/**
 * Shared types for the KnowBe4 MCP server
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool call result type - inline definition for MCP SDK compatibility
 */
export type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Domain handler interface
 */
export interface DomainHandler {
  /** Get the tools for this domain */
  getTools(): Tool[];
  /** Handle a tool call */
  handleCall(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>;
}

/**
 * Domain names for KnowBe4
 */
export type DomainName =
  | "account"
  | "users"
  | "groups"
  | "phishing"
  | "training"
  | "reporting"
  | "partner";

/**
 * Check if a string is a valid domain name
 */
export function isDomainName(value: string): value is DomainName {
  return ["account", "users", "groups", "phishing", "training", "reporting", "partner"].includes(value);
}

/**
 * Tenant credentials for the KnowBe4 Reporting (REST) API, extracted from
 * environment or gateway headers.
 */
export interface KnowBe4Credentials {
  apiKey: string;
  baseUrl: string;
}

/**
 * Partner credentials for the KnowBe4 partner GraphQL API. The partner key
 * lists managed accounts and mints short-lived JIT tokens for tenant queries.
 */
export interface PartnerCredentials {
  partnerApiKey: string;
  graphqlUrl: string;
}

/**
 * Per-request credential bundle held in AsyncLocalStorage in gateway mode.
 * Either half may be absent; a present store never falls back to env vars.
 */
export interface RequestCredentials {
  tenant?: KnowBe4Credentials;
  partner?: PartnerCredentials;
}

/**
 * KnowBe4 Reporting API regions and their base URLs
 */
export const KNOWBE4_REGIONS: Record<string, string> = {
  us: "https://us.api.knowbe4.com",
  eu: "https://eu.api.knowbe4.com",
  ca: "https://ca.api.knowbe4.com",
  uk: "https://uk.api.knowbe4.com",
  de: "https://de.api.knowbe4.com",
};

/**
 * KnowBe4 GraphQL API regions and their endpoints. Partner and tenant
 * GraphQL share the same endpoint; the bearer token decides the scope.
 */
export const KNOWBE4_GRAPHQL_REGIONS: Record<string, string> = {
  us: "https://training.knowbe4.com/graphql",
  eu: "https://eu.knowbe4.com/graphql",
  ca: "https://ca.knowbe4.com/graphql",
  uk: "https://uk.knowbe4.com/graphql",
  de: "https://de.knowbe4.com/graphql",
};
