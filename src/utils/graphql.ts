/**
 * KnowBe4 GraphQL client and partner credential management.
 *
 * Partner mode authenticates with a single partner Product API key against
 * the partner GraphQL API. The same regional endpoint also serves tenant-level
 * queries when called with a JIT token (see jit.ts).
 *
 * Endpoints by region (partner and tenant share them):
 * - US: https://training.knowbe4.com/graphql
 * - EU: https://eu.knowbe4.com/graphql
 * - CA: https://ca.knowbe4.com/graphql
 * - UK: https://uk.knowbe4.com/graphql
 * - DE: https://de.knowbe4.com/graphql
 *
 * Limits: 150-line complexity per query, 4 requests/second,
 * 10 requests per licensed user per day.
 */

import { credentialStore } from "./client.js";
import { logger } from "./logger.js";
import { KNOWBE4_GRAPHQL_REGIONS, type PartnerCredentials, type TenantGraphqlCredentials } from "./types.js";

export const PARTNER_NOT_CONFIGURED_MESSAGE =
  "Partner mode is not configured. Set KNOWBE4_PARTNER_API_KEY (env mode) or send the X-KnowBe4-Partner-API-Key header (gateway mode).";

export const TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE =
  "Opt-in tenant GraphQL is not configured. Set KNOWBE4_PRODUCT_API_KEY (env mode) or send the X-KnowBe4-Product-API-Key header (gateway mode). The tenant GraphQL API requires a Diamond or SAT Advanced subscription.";

/**
 * Resolve the GraphQL endpoint for a region, honoring an explicit override.
 */
export function resolveGraphqlUrl(region?: string, override?: string): string {
  if (override) return override;
  const key = (region || "us").toLowerCase();
  return KNOWBE4_GRAPHQL_REGIONS[key] || KNOWBE4_GRAPHQL_REGIONS.us;
}

/**
 * Get partner credentials from the request-scoped store (gateway mode)
 * or from environment variables (stdio/env mode).
 */
export function getPartnerCredentials(): PartnerCredentials | null {
  const scoped = credentialStore.getStore();
  if (scoped) {
    return scoped.partner ?? null;
  }

  const partnerApiKey = process.env.KNOWBE4_PARTNER_API_KEY;
  if (!partnerApiKey) return null;

  return {
    partnerApiKey,
    graphqlUrl: resolveGraphqlUrl(process.env.KNOWBE4_REGION, process.env.KNOWBE4_GRAPHQL_URL),
  };
}

/**
 * Partner credentials, or a clear error telling the caller how to configure them.
 */
export function requirePartnerCredentials(): PartnerCredentials {
  const creds = getPartnerCredentials();
  if (!creds) throw new Error(PARTNER_NOT_CONFIGURED_MESSAGE);
  return creds;
}

/**
 * Get opt-in tenant GraphQL credentials (a Product API key, scoped to this
 * tenant only -- distinct from a partner key, which lists *other* managed
 * accounts) from the request-scoped store (gateway mode) or environment
 * variables (stdio/env mode). `KNOWBE4_API_KEY` (Reporting API) is unrelated
 * and never used here, even if both are set.
 */
export function getTenantGraphqlCredentials(): TenantGraphqlCredentials | null {
  const scoped = credentialStore.getStore();
  if (scoped) {
    return scoped.tenantGraphql ?? null;
  }

  const apiKey = process.env.KNOWBE4_PRODUCT_API_KEY;
  if (!apiKey) return null;

  return {
    apiKey,
    graphqlUrl: resolveGraphqlUrl(process.env.KNOWBE4_REGION, process.env.KNOWBE4_GRAPHQL_URL),
  };
}

/**
 * Opt-in tenant GraphQL credentials, or a clear error telling the caller how
 * to configure them.
 */
export function requireTenantGraphqlCredentials(): TenantGraphqlCredentials {
  const creds = getTenantGraphqlCredentials();
  if (!creds) throw new Error(TENANT_GRAPHQL_NOT_CONFIGURED_MESSAGE);
  return creds;
}

interface GraphqlErrorEntry {
  message?: string;
  [key: string]: unknown;
}

/** Best-effort operation name for logs, e.g. "query PartnerAccounts". */
function operationLabel(query: string): string {
  const match = /^\s*(query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  return match ? `${match[1]} ${match[2]}` : "anonymous operation";
}

/**
 * Execute a GraphQL operation with a bearer token. Throws on HTTP errors and
 * on a non-empty `errors` array. The token is never logged.
 */
export async function graphqlRequest<T>(
  url: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const label = operationLabel(query);
  logger.debug("KnowBe4 GraphQL request", { url, operation: label });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });

  const rawText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = rawText;
  }

  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as Record<string, unknown>).message)
        : `HTTP ${response.status}: ${response.statusText}`;

    logger.error("KnowBe4 GraphQL error", { status: response.status, url, operation: label, message });

    if (response.status === 401) {
      throw new Error(`Authentication failed: ${message}. Check the partner API key or JIT token.`);
    }
    if (response.status === 403) {
      throw new Error(`Forbidden: ${message}. Insufficient permissions or subscription level.`);
    }
    if (response.status === 429) {
      throw new Error(`Rate limit exceeded: ${message}. KnowBe4 GraphQL allows 4 req/sec.`);
    }
    throw new Error(`KnowBe4 GraphQL error (${response.status}): ${message}`);
  }

  const { data, errors } = (body ?? {}) as { data?: T; errors?: GraphqlErrorEntry[] };

  if (errors && errors.length > 0) {
    const messages = errors.map((e) => e.message ?? JSON.stringify(e)).join("; ");
    logger.error("KnowBe4 GraphQL response errors", { operation: label, messages });
    throw new Error(`KnowBe4 GraphQL error: ${messages}`);
  }

  if (data === undefined || data === null) {
    throw new Error(`KnowBe4 GraphQL response for ${label} contained no data`);
  }

  return data;
}

/**
 * Run a partner-level operation (accounts list, JIT minting, ...) using the
 * partner API key directly.
 */
export async function partnerQuery<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const creds = requirePartnerCredentials();
  return graphqlRequest<T>(creds.graphqlUrl, creds.partnerApiKey, query, variables);
}
