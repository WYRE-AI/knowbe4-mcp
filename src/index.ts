#!/usr/bin/env node
/**
 * KnowBe4 MCP Server
 *
 * This MCP server provides tools for interacting with the KnowBe4 API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `knowbe4_navigate` tool provides domain
 * discovery and guidance.
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Auth modes:
 * - env (default): Credentials from KNOWBE4_API_KEY environment variable
 * - gateway: Credentials injected from request headers by the MCP gateway
 *   - Header: X-KnowBe4-API-Key (X-KnowBe4-Region optional)
 *   - Missing credential headers are rejected. There is no KNOWBE4_* fallback.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real secret.
 * A known placeholder is never accepted. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, skips
 * X-Gateway-S2S, and listens on 127.0.0.1 only. A configured secret still
 * honors MCP_HTTP_HOST (default 0.0.0.0). /health and /healthz stay
 * unauthenticated. stdio does not use S2S auth.
 *
 * Domains:
 * - account: Account info and risk score history
 * - users: User management and individual risk scores
 * - groups: Group management, members, and group risk scores
 * - phishing: Phishing campaigns, security tests, and recipient results
 * - training: Training campaigns, enrollments, store purchases, and policies
 * - reporting: Aggregated reports, risk overview, and phishing/training summaries
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { getDomainHandler, getAvailableDomains } from "./domains/index.js";
import { isDomainName, KNOWBE4_REGIONS, type DomainName } from "./utils/types.js";
import { getCredentials, credentialStore } from "./utils/client.js";
import { logger } from "./utils/logger.js";
import { setServerRef } from "./utils/server-ref.js";
import { TOOL_CATEGORIES, findDomainForTool, routeIntent } from "./utils/categories.js";
import { registerResourceHandlers } from "./resources.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real
 * secret, and it is not bypassed by MCP_ALLOW_INSECURE_DEV.
 */
export const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP server: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is unset and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const LOOPBACK_HOST = "127.0.0.1";
/** Bind used when a real secret is set and MCP_HTTP_HOST is unset. Container images set 0.0.0.0 explicitly. */
const SECRET_DEFAULT_HOST = "0.0.0.0";

const S2S_UNAUTHORIZED = {
  error:
    "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
};

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 127.0.0.0/8, localhost, and ::1. Bracketed IPv6 forms count too. */
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. An empty CONDUIT_S2S_SECRET used to skip X-Gateway-S2S.
 * Read at HTTP startup, not module load. A known placeholder is refused
 * even when MCP_ALLOW_INSECURE_DEV=1, so a copied example cannot sign
 * requests. The secret value is never logged.
 */
function resolveHttpS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    exitWithError(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    console.error("================================================================");
    console.error(INSECURE_DEV_WARNING);
    console.error("================================================================");
    return { secret: "", insecureDev: true };
  }
  exitWithError(MISSING_S2S_SECRET_ERROR);
}

/**
 * No secret: bind 127.0.0.1 only. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST, including
 * 0.0.0.0, so container deploys stay on the image bind address.
 */
function resolveBindHost(insecureDev: boolean): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) return configured || SECRET_DEFAULT_HOST;
  if (configured === "" || configured === LOOPBACK_HOST) return LOOPBACK_HOST;
  if (isLoopbackHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is loopback, but MCP_ALLOW_INSECURE_DEV=1 binds ${LOOPBACK_HOST} only.`
    );
    return LOOPBACK_HOST;
  }
  exitWithError(
    "Refusing to start HTTP server: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET only binds 127.0.0.1. " +
      `MCP_HTTP_HOST=${configured} is not loopback. Unset MCP_HTTP_HOST or set it to 127.0.0.1.`
  );
}

// Navigation state removed - all tools are always available for direct-install compatibility

/**
 * Navigation tool - stateless discovery helper that describes available tools for a domain.
 * All domain tools are always listed in tools/list regardless of navigation state,
 * because many MCP clients (claude.ai connectors, mcp-remote) only fetch the tool
 * list once and do not support notifications/tools/list_changed.
 */
const navigateTool: Tool = {
  name: "knowbe4_navigate",
  description:
    "Discover available KnowBe4 tools by domain. Returns tool names and descriptions for the selected domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.",
  inputSchema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        enum: getAvailableDomains(),
        description: `The domain to explore:
- account: Account info and risk score history
- users: User management and individual risk scores
- groups: Group management, members, and group risk scores
- phishing: Phishing campaigns, security tests, and recipient results
- training: Training campaigns, enrollments, store purchases, and policies
- reporting: Aggregated reports, risk overview, and phishing/training summaries`,
      },
    },
    required: ["domain"],
  },
};

/**
 * Back navigation tool - now a no-op since all tools are always available
 */
const backTool: Tool = {
  name: "knowbe4_back",
  description: "No-op tool for backwards compatibility. All tools are always available.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

/**
 * Status tool - shows credentials status and available domains
 */
const statusTool: Tool = {
  name: "knowbe4_status",
  description:
    "Show credentials status and available domains. Also verifies API credentials are configured.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ---------------------------------------------------------------------------
// Lazy-loading meta-tools (used when LAZY_LOADING=true)
// ---------------------------------------------------------------------------

const metaTools: Tool[] = [
  {
    name: "knowbe4_list_categories",
    description:
      "List all available KnowBe4 tool categories with descriptions and tool counts. Use this first to discover what the server can do before loading individual tool schemas.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "knowbe4_list_category_tools",
    description:
      "List all tools in a specific category with their full schemas. Call this after knowbe4_list_categories to see exactly what parameters a tool accepts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          enum: Object.keys(TOOL_CATEGORIES),
          description:
            "The category to list tools for (e.g. account, users, groups, phishing, training, reporting)",
        },
      },
      required: ["category"],
    },
  },
  {
    name: "knowbe4_execute_tool",
    description:
      "Execute any KnowBe4 tool by name. Use knowbe4_list_category_tools first to discover the tool's required arguments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        toolName: {
          type: "string",
          description: "The full tool name to execute (e.g. knowbe4_users_list)",
        },
        arguments: {
          type: "object",
          description: "The arguments to pass to the tool",
          additionalProperties: true,
        },
      },
      required: ["toolName"],
    },
  },
  {
    name: "knowbe4_router",
    description:
      "Suggest the best KnowBe4 tool(s) for a given intent. Describe what you want to do in plain language and this tool will recommend which tool(s) to call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            "A plain-language description of what you want to accomplish (e.g. 'list all users', 'get phishing test results', 'risk overview')",
        },
      },
      required: ["intent"],
    },
  },
];

/**
 * Check whether lazy-loading mode is enabled via environment variable.
 */
function isLazyLoadingEnabled(): boolean {
  return process.env.LAZY_LOADING === "true";
}

/**
 * Map from domain name to its tool definitions (loaded lazily)
 */
const domainToolMap = new Map<DomainName, Tool[]>();

/**
 * All domain tools, collected once at startup
 */
let allDomainTools: Tool[] | null = null;

/**
 * Load all domain tools (lazy-loaded on first access)
 */
async function getAllDomainTools(): Promise<Tool[]> {
  if (allDomainTools !== null) {
    return allDomainTools;
  }

  const domains = getAvailableDomains();
  const tools: Tool[] = [];

  for (const domain of domains) {
    if (!domainToolMap.has(domain)) {
      const handler = await getDomainHandler(domain);
      const domainTools = handler.getTools();
      domainToolMap.set(domain, domainTools);
    }
    tools.push(...domainToolMap.get(domain)!);
  }

  allDomainTools = tools;
  return tools;
}

// Handle ListTools requests - always returns ALL tools
const handleListTools = async () => {
  if (isLazyLoadingEnabled()) {
    return { tools: metaTools };
  }

  const domainTools = await getAllDomainTools();
  return { tools: [navigateTool, backTool, statusTool, ...domainTools] };
};

// Handle CallTool requests
const handleCallTool = async (request: CallToolRequest) => {
  const { name, arguments: args } = request.params;
  logger.info("Tool call received", { tool: name, arguments: args });

  try {
    // -----------------------------------------------------------------
    // Lazy-loading meta-tool handlers
    // -----------------------------------------------------------------

    if (name === "knowbe4_list_categories") {
      const categories = Object.entries(TOOL_CATEGORIES).map(
        ([categoryName, cat]) => ({
          name: categoryName,
          description: cat.description,
          toolCount: cat.tools.length,
        })
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ categories }, null, 2),
          },
        ],
      };
    }

    if (name === "knowbe4_list_category_tools") {
      const category = (args as { category: string }).category;
      if (!isDomainName(category)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid category: '${category}'. Available categories: ${Object.keys(TOOL_CATEGORIES).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const handler = await getDomainHandler(category);
      const tools = handler.getTools();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                category,
                description: TOOL_CATEGORIES[category].description,
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "knowbe4_execute_tool") {
      const toolName = (args as { toolName: string; arguments?: Record<string, unknown> }).toolName;
      const toolArgs = (args as { toolName: string; arguments?: Record<string, unknown> }).arguments ?? {};

      // Validate credentials
      const creds = getCredentials();
      if (!creds) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No API credentials configured. Please set the KNOWBE4_API_KEY environment variable.",
            },
          ],
          isError: true,
        };
      }

      const domain = findDomainForTool(toolName);
      if (!domain) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: '${toolName}'. Use knowbe4_list_categories and knowbe4_list_category_tools to discover available tools.`,
            },
          ],
          isError: true,
        };
      }

      const handler = await getDomainHandler(domain);
      const result = await handler.handleCall(toolName, toolArgs);

      logger.debug("Meta-tool execute completed", {
        tool: toolName,
        domain,
        responseSize: JSON.stringify(result).length,
      });

      return result;
    }

    if (name === "knowbe4_router") {
      const intent = (args as { intent: string }).intent;
      const suggestions = routeIntent(intent);

      if (suggestions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  intent,
                  suggestions: [],
                  message:
                    "No matching tools found for that intent. Use knowbe4_list_categories to browse all available categories.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Enrich suggestions with their category
      const enriched = suggestions.map((toolName) => {
        const domain = findDomainForTool(toolName);
        return {
          tool: toolName,
          category: domain,
          categoryDescription: domain ? TOOL_CATEGORIES[domain].description : null,
        };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ intent, suggestions: enriched }, null, 2),
          },
        ],
      };
    }

    // Navigate to a domain - stateless discovery helper
    if (name === "knowbe4_navigate") {
      const domain = (args as { domain: string }).domain;

      if (!isDomainName(domain)) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid domain: '${domain}'. Available domains: ${getAvailableDomains().join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const handler = await getDomainHandler(domain);
      const domainTools = handler.getTools();

      const domainDescriptions: Record<DomainName, string> = {
        account: "Account info and risk score history",
        users: "User management and individual risk scores",
        groups: "Group management, members, and group risk scores",
        phishing: "Phishing campaigns, security tests, and recipient results",
        training: "Training campaigns, enrollments, store purchases, and policies",
        reporting: "Aggregated reports, risk overview, and phishing/training summaries"
      };

      const toolSummary = domainTools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${domainDescriptions[domain]}\n\nAvailable tools:\n${toolSummary}\n\nYou can call any of these tools directly.`,
          },
        ],
      };
    }

    // Navigate back to root - now a no-op for backwards compatibility
    if (name === "knowbe4_back") {
      return {
        content: [
          {
            type: "text",
            text: `All tools are always available.\n\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nUse knowbe4_navigate to discover tools by domain.`,
          },
        ],
      };
    }

    // Status check
    if (name === "knowbe4_status") {
      const creds = getCredentials();
      const credStatus = creds
        ? `Configured (region: ${process.env.KNOWBE4_REGION || "us"})`
        : "NOT CONFIGURED - Please set KNOWBE4_API_KEY environment variable";

      return {
        content: [
          {
            type: "text",
            text: `KnowBe4 MCP Server Status\n\nCredentials: ${credStatus}\nAvailable domains: ${getAvailableDomains().join(", ")}\n\nAll tools are available at all times. Use knowbe4_navigate to discover tools by domain.`,
          },
        ],
      };
    }

    // Route to appropriate domain handler based on tool name pattern
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    if (name.startsWith("knowbe4_account_")) {
      const handler = await getDomainHandler("account");
      return await handler.handleCall(name, toolArgs);
    }
    if (name.startsWith("knowbe4_users_")) {
      const handler = await getDomainHandler("users");
      return await handler.handleCall(name, toolArgs);
    }
    if (name.startsWith("knowbe4_groups_")) {
      const handler = await getDomainHandler("groups");
      return await handler.handleCall(name, toolArgs);
    }
    if (name.startsWith("knowbe4_phishing_")) {
      const handler = await getDomainHandler("phishing");
      return await handler.handleCall(name, toolArgs);
    }
    if (name.startsWith("knowbe4_training_")) {
      const handler = await getDomainHandler("training");
      return await handler.handleCall(name, toolArgs);
    }
    if (name.startsWith("knowbe4_reporting_")) {
      const handler = await getDomainHandler("reporting");
      return await handler.handleCall(name, toolArgs);
    }

    // Unknown tool
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: '${name}'. Use knowbe4_navigate to discover available tools by domain.`,
        },
      ],
      isError: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("Tool call failed", { tool: name, error: message, stack });
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
};

/**
 * Register the ListTools and CallTool handlers on a Server instance.
 * Called once per server — once for the shared stdio server, and once per
 * HTTP request for the fresh per-request servers.
 */
function registerHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, handleListTools);
  server.setRequestHandler(CallToolRequestSchema, handleCallTool);
  registerResourceHandlers(server);
}

/**
 * Build a fresh MCP Server with all request handlers registered.
 *
 * A NEW Server (paired with a NEW StreamableHTTPServerTransport) is created for
 * every HTTP request so the server is stateless: each request can `initialize`
 * independently and multiple clients work simultaneously. Reusing a single
 * Server + stateful transport causes the second client to receive
 * -32600 "Server already initialized" and therefore see zero tools — behind the
 * multi-user gateway that means only the first client since container start gets
 * any tools. stdio mode is inherently single-client and reuses one such server.
 */
function createFreshServer(): Server {
  const server = new Server(
    {
      name: "mcp-server-knowbe4",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.onerror = (error) => {
    logger.error("MCP server error", {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  registerHandlers(server);
  return server;
}

/**
 * Start the server with stdio transport (default)
 */
async function startStdioTransport(): Promise<void> {
  // stdio is inherently single-client, so a single shared server is fine.
  const server = createFreshServer();
  setServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const mode = isLazyLoadingEnabled() ? "lazy loading" : "flattened";
  logger.info(`KnowBe4 MCP server running on stdio (${mode} mode)`);
}

/**
 * Start the server with HTTP Streamable transport.
 * In gateway mode (AUTH_MODE=gateway), credentials are extracted
 * from the X-KnowBe4-API-Key request header. A request missing that
 * header is rejected and does not fall back to KNOWBE4_* in process.env.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveBindHost(insecureDev);
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  /**
   * Handle a single /mcp POST with a FRESH Server + Transport (stateless).
   *
   * The entire body is guarded: on any error we reply 500 with a JSON-RPC
   * error and NEVER rethrow. This keeps a single bad request from escaping as
   * an unhandledRejection (which, with a process-level handler, could exit the
   * container). The fresh server + transport are built here — and, in gateway
   * mode, inside credentialStore.run(...) — so per-request credentials apply to
   * every downstream getCredentials()/apiRequest() call, including async
   * continuations of the connect/handleRequest promise chain.
   */
  const handleMcpRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const respondInternalError = () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          })
        );
      }
    };

    try {
      const server = createFreshServer();
      // Best-effort ref for elicitation helpers (stateless HTTP can't stream
      // server->client requests, so these degrade gracefully to null).
      setServerRef(server);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: no session, allows every client to initialize
        enableJsonResponse: true,
      });

      // Dispose the per-request server + transport when the response closes.
      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      server
        .connect(transport)
        .then(() => transport.handleRequest(req, res))
        .catch((error) => {
          logger.error("MCP request handling failed", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          respondInternalError();
        });
    } catch (error) {
      logger.error("MCP request setup failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      respondInternalError();
    }
  };

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health check - shallow, unauthenticated liveness probe.
    // Must NOT call getCredentials() or any upstream: in gateway mode
    // credentials arrive per-request via X-KnowBe4-API-Key, so a
    // credential-gated /health would always 503 and Azure's liveness
    // probe would SIGTERM-kill the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          authMode: isGatewayMode ? "gateway" : "env",
        })
      );
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
      // A configured secret is always enforced. Placeholder secrets never
      // reach this point — startup already exited. Rejected before any
      // credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify(S2S_UNAUTHORIZED));
        return;
      }

      // Stateless mode only supports POST (no GET SSE stream).
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // Gateway mode: credentials must arrive on this request. Falling
      // through would resolve KNOWBE4_* from the process environment,
      // which is not request-scoped.
      if (isGatewayMode) {
        const apiKey = headerValue(req.headers["x-knowbe4-api-key"]);
        const region = headerValue(req.headers["x-knowbe4-region"]);

        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-KnowBe4-API-Key header",
              required: ["X-KnowBe4-API-Key"],
              optional: ["X-KnowBe4-Region"],
            })
          );
          return;
        }

        // Build credentials with region-to-baseUrl resolution
        const regionKey = (region || "us").toLowerCase();
        const baseUrl = KNOWBE4_REGIONS[regionKey] || KNOWBE4_REGIONS.us;

        // Build the fresh per-request server + transport INSIDE the credential
        // scope so all downstream getCredentials()/apiRequest() calls use these creds.
        credentialStore.run({ apiKey, baseUrl }, () => {
          handleMcpRequest(req, res);
        });
        return;
      }

      handleMcpRequest(req, res);
      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health", "/healthz"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      logger.info(`KnowBe4 MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(
        `Authentication mode: ${isGatewayMode ? "gateway (X-KnowBe4-API-Key header)" : "env (KNOWBE4_API_KEY environment variable)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

/**
 * Close the HTTP server on SIGINT/SIGTERM.
 *
 * The returned promise always settles. A close error is logged and exits 1
 * so a signal listener cannot surface an unhandled rejection. A successful
 * close exits 0.
 */
export async function shutdownHttpServer(
  httpServer: HttpServer,
  exit: (code: number) => void = process.exit,
): Promise<void> {
  logger.info("Shutting down KnowBe4 MCP server...");
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    exit(0);
  } catch (error) {
    logger.error("HTTP server close failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    exit(1);
  }
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var
 */
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting KnowBe4 MCP server", {
    transport: transportType,
    logLevel: process.env.LOG_LEVEL || "info",
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    let shuttingDown = false;
    const shutdown = () => {
      // A second signal would make close() fail with ERR_SERVER_NOT_RUNNING.
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      void shutdownHttpServer(httpServer);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  });
}
