/**
 * Tests for opt-in direct-tenant-GraphQL routing (a tenant's own Product API
 * key, no account_id, no partner key).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { handlers } = vi.hoisted(() => ({
  handlers: {
    account: vi.fn(),
    users: vi.fn(),
    groups: vi.fn(),
    phishing: vi.fn(),
    training: vi.fn(),
    reporting: vi.fn(),
  },
}));

vi.mock("../graphql/account.js", () => ({ handle: handlers.account }));
vi.mock("../graphql/users.js", () => ({ handle: handlers.users }));
vi.mock("../graphql/groups.js", () => ({ handle: handlers.groups }));
vi.mock("../graphql/phishing.js", () => ({ handle: handlers.phishing }));
vi.mock("../graphql/training.js", () => ({ handle: handlers.training }));
vi.mock("../graphql/reporting.js", () => ({ handle: handlers.reporting }));
vi.mock("../utils/graphql.js", () => ({
  getPartnerCredentials: vi.fn(),
  getTenantGraphqlCredentials: vi.fn(),
  PARTNER_NOT_CONFIGURED_MESSAGE: "Partner mode is not configured.",
}));

import { shouldUseDirectTenantGraphql, callViaDirectTenantGraphql } from "../graphql/index.js";
import { getTenantGraphqlCredentials } from "../utils/graphql.js";

const ok = { content: [{ type: "text" as const, text: "{}" }] };
const configuredCreds = { apiKey: "product-key", graphqlUrl: "https://training.knowbe4.com/graphql" };

describe("shouldUseDirectTenantGraphql", () => {
  it("is false for a null domain regardless of credentials", () => {
    vi.mocked(getTenantGraphqlCredentials).mockReturnValue(configuredCreds);
    expect(shouldUseDirectTenantGraphql(null)).toBe(false);
  });

  it("is false for the partner domain, which has no REST/GraphQL opt-out to make", () => {
    vi.mocked(getTenantGraphqlCredentials).mockReturnValue(configuredCreds);
    expect(shouldUseDirectTenantGraphql("partner")).toBe(false);
  });

  it("is false for a tenant domain when no Product API key is configured", () => {
    vi.mocked(getTenantGraphqlCredentials).mockReturnValue(null);
    expect(shouldUseDirectTenantGraphql("users")).toBe(false);
  });

  it.each(["account", "users", "groups", "phishing", "training", "reporting"] as const)(
    "is true for the %s domain when a Product API key is configured",
    (domain) => {
      vi.mocked(getTenantGraphqlCredentials).mockReturnValue(configuredCreds);
      expect(shouldUseDirectTenantGraphql(domain)).toBe(true);
    }
  );
});

describe("callViaDirectTenantGraphql", () => {
  beforeEach(() => {
    vi.mocked(getTenantGraphqlCredentials).mockReturnValue(configuredCreds);
  });

  it("routes to the tenant handler for the tool's domain with accountId null, args untouched", async () => {
    handlers.users.mockResolvedValue(ok);

    const result = await callViaDirectTenantGraphql("knowbe4_users_list", { status: "active", page: 2 });

    expect(handlers.users).toHaveBeenCalledWith("knowbe4_users_list", null, { status: "active", page: 2 });
    expect(result).toBe(ok);
  });

  it("routes store purchases and policies to the training handler", async () => {
    handlers.training.mockResolvedValue(ok);

    await callViaDirectTenantGraphql("knowbe4_store_purchases_list", {});
    await callViaDirectTenantGraphql("knowbe4_policies_get", { policy_id: 9 });

    expect(handlers.training).toHaveBeenNthCalledWith(1, "knowbe4_store_purchases_list", null, {});
    expect(handlers.training).toHaveBeenNthCalledWith(2, "knowbe4_policies_get", null, { policy_id: 9 });
  });

  it("rejects tools that have no tenant GraphQL equivalent (e.g. partner-only tools)", async () => {
    const result = await callViaDirectTenantGraphql("knowbe4_partner_accounts_list", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not available over the opt-in tenant GraphQL path");
  });

  it("rejects an unknown tool name", async () => {
    const result = await callViaDirectTenantGraphql("knowbe4_nope", {});
    expect(result.isError).toBe(true);
  });
});
