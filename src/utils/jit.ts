/**
 * Just-In-Time (JIT) tenant tokens for partner mode.
 *
 * The partner API mints a JWT scoped to one managed account via
 * `apiTokensGenerateJit(accountId)`. KnowBe4 documents a 15-minute lifetime,
 * so tokens are cached for 14 minutes and re-minted after that. The cache is
 * keyed by a hash of the partner key plus the account ID, so two partners
 * sharing one gateway process can never receive each other's tokens.
 * JWTs are never logged.
 */

import { createHash } from "node:crypto";
import { graphqlRequest, requirePartnerCredentials } from "./graphql.js";
import { logger } from "./logger.js";
import type { PartnerCredentials } from "./types.js";

/** KnowBe4 JIT tokens live 15 minutes; refresh a minute early. */
export const JIT_TOKEN_TTL_MS = 14 * 60 * 1000;

export const JIT_MUTATION = `mutation GenerateJitToken($accountId: Int!) {
  apiTokensGenerateJit(accountId: $accountId) {
    node
    errors { field reason }
  }
}`;

interface JitPayload {
  apiTokensGenerateJit: {
    node: string | null;
    errors: Array<{ field?: string | null; reason?: string | null }> | null;
  } | null;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Pending or settled mints, so concurrent calls for one tenant share a mint. */
const cache = new Map<string, Promise<CachedToken>>();

function cacheKey(partnerApiKey: string, accountId: number): string {
  const digest = createHash("sha256").update(partnerApiKey).digest("hex").slice(0, 16);
  return `${digest}:${accountId}`;
}

async function mintJitToken(
  creds: PartnerCredentials,
  accountId: number,
  now: () => number
): Promise<CachedToken> {
  logger.info("Minting JIT token", { accountId });
  const data = await graphqlRequest<JitPayload>(creds.graphqlUrl, creds.partnerApiKey, JIT_MUTATION, {
    accountId,
  });

  const payload = data.apiTokensGenerateJit;
  const errors = payload?.errors ?? [];
  if (!payload?.node || errors.length > 0) {
    const reasons = errors
      .map((e) => [e.field, e.reason].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Could not generate a JIT token for account ${accountId}: ${reasons || "no token returned"}`
    );
  }

  return { token: payload.node, expiresAt: now() + JIT_TOKEN_TTL_MS };
}

/**
 * Get a JIT token for a managed account, minting one if none is cached or
 * the cached one is about to expire.
 */
export async function getJitToken(accountId: number, now: () => number = Date.now): Promise<string> {
  const creds = requirePartnerCredentials();
  const key = cacheKey(creds.partnerApiKey, accountId);

  const cached = cache.get(key);
  if (cached) {
    const entry = await cached.catch(() => null);
    if (entry && entry.expiresAt > now()) return entry.token;
    cache.delete(key);
  }

  const pending = mintJitToken(creds, accountId, now);
  cache.set(key, pending);
  try {
    return (await pending).token;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/**
 * Run a tenant-level GraphQL operation against a managed account using a JIT
 * token. An authentication failure evicts the cached token so the next call
 * mints a fresh one.
 */
export async function tenantQuery<T>(
  accountId: number,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const creds = requirePartnerCredentials();
  const token = await getJitToken(accountId);
  try {
    return await graphqlRequest<T>(creds.graphqlUrl, token, query, variables);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Authentication failed")) {
      cache.delete(cacheKey(creds.partnerApiKey, accountId));
    }
    throw error;
  }
}

/** Drop every cached token (tests, credential rotation). */
export function clearJitTokenCache(): void {
  cache.clear();
}
