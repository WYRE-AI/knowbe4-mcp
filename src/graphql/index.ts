/**
 * Partner-mode routing for tenant tools.
 *
 * Every tenant tool accepts an optional `account_id`. When it is present the
 * call is served over KnowBe4's tenant GraphQL API with a JIT token minted
 * from the partner key (src/graphql/<domain>.ts) instead of the REST
 * Reporting API (src/domains/<domain>.ts). Routing lives here so the REST
 * handlers stay untouched and single-tenant installs behave exactly as before.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, DomainName } from "../utils/types.js";
import { getPartnerCredentials, PARTNER_NOT_CONFIGURED_MESSAGE } from "../utils/graphql.js";
import { findDomainForTool } from "../utils/categories.js";
import * as account from "./account.js";
import * as users from "./users.js";
import * as groups from "./groups.js";
import * as phishing from "./phishing.js";
import * as training from "./training.js";
import * as reporting from "./reporting.js";

export type TenantToolHandler = (
  toolName: string,
  accountId: number,
  args: Record<string, unknown>
) => Promise<CallToolResult>;

/** Tenant domains served over GraphQL in partner mode. `partner` is not one. */
const TENANT_HANDLERS: Partial<Record<DomainName, TenantToolHandler>> = {
  account: account.handle,
  users: users.handle,
  groups: groups.handle,
  phishing: phishing.handle,
  training: training.handle,
  reporting: reporting.handle,
};

/** JSON Schema for the `account_id` argument added to every tenant tool. */
export const ACCOUNT_ID_ARG = {
  type: "number",
  description:
    "Partner mode only: the managed account (customer tenant) id to query, from knowbe4_partner_accounts_list. Requires a partner API key. Omit to use the tenant API key.",
} as const;

/** True when the call names a managed account and must go through partner mode. */
export function isPartnerScoped(args: Record<string, unknown> | undefined): boolean {
  const id = args?.account_id;
  return typeof id === "number" && Number.isInteger(id) && id > 0;
}

/** Add the optional `account_id` argument to each tool's input schema. */
export function withAccountIdArg(tools: Tool[]): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties ?? {}), account_id: ACCOUNT_ID_ARG },
    },
  }));
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Serve a tenant tool for the managed account named by `args.account_id`.
 * There is deliberately no fallback to the REST path: silently answering
 * from the wrong tenant would be worse than an error.
 */
export async function callViaPartner(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  if (!getPartnerCredentials()) {
    return errorResult(`Error: account_id requires partner mode. ${PARTNER_NOT_CONFIGURED_MESSAGE}`);
  }

  const domain = findDomainForTool(toolName);
  const handler = domain ? TENANT_HANDLERS[domain] : undefined;
  if (!handler) {
    return errorResult(`Error: ${toolName} does not accept account_id (partner mode)`);
  }

  const { account_id: accountId, ...tenantArgs } = args;
  return handler(toolName, accountId as number, tenantArgs);
}
