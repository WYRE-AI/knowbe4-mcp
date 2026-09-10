/**
 * Tests for partner-mode routing of tenant tools (account_id handling)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
  PARTNER_NOT_CONFIGURED_MESSAGE: "Partner mode is not configured.",
}));

import { isPartnerScoped, withAccountIdArg, callViaPartner, ACCOUNT_ID_ARG } from "../graphql/index.js";
import { getPartnerCredentials } from "../utils/graphql.js";

const ok = { content: [{ type: "text" as const, text: "{}" }] };

describe("isPartnerScoped", () => {
  it("is true only for a positive integer account_id", () => {
    expect(isPartnerScoped({ account_id: 12 })).toBe(true);
    expect(isPartnerScoped({ account_id: 0 })).toBe(false);
    expect(isPartnerScoped({ account_id: -3 })).toBe(false);
    expect(isPartnerScoped({ account_id: 1.5 })).toBe(false);
    expect(isPartnerScoped({ account_id: "12" })).toBe(false);
    expect(isPartnerScoped({})).toBe(false);
    expect(isPartnerScoped(undefined)).toBe(false);
  });
});

describe("withAccountIdArg", () => {
  it("adds an optional account_id and keeps everything else", () => {
    const tool: Tool = {
      name: "knowbe4_users_get",
      description: "Get user",
      _meta: { "ui/resourceUri": "ui://x" },
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "number" } },
        required: ["user_id"],
      },
    };

    const [augmented] = withAccountIdArg([tool]);

    expect(augmented.inputSchema.properties).toEqual({
      user_id: { type: "number" },
      account_id: ACCOUNT_ID_ARG,
    });
    expect(augmented.inputSchema.required).toEqual(["user_id"]);
    expect(augmented._meta).toEqual({ "ui/resourceUri": "ui://x" });
    expect(augmented.name).toBe("knowbe4_users_get");
    // Original untouched
    expect(tool.inputSchema.properties).not.toHaveProperty("account_id");
  });

  it("handles tools without properties", () => {
    const [augmented] = withAccountIdArg([
      { name: "knowbe4_account_get", description: "x", inputSchema: { type: "object" } },
    ]);
    expect(augmented.inputSchema.properties).toEqual({ account_id: ACCOUNT_ID_ARG });
  });
});

describe("callViaPartner", () => {
  beforeEach(() => {
    vi.mocked(getPartnerCredentials).mockReturnValue({
      partnerApiKey: "partner-key",
      graphqlUrl: "https://training.knowbe4.com/graphql",
    });
  });

  it("errors with the configuration hint when partner mode is off", async () => {
    vi.mocked(getPartnerCredentials).mockReturnValue(null);

    const result = await callViaPartner("knowbe4_users_list", { account_id: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("account_id requires partner mode");
    expect(result.content[0].text).toContain("Partner mode is not configured.");
    expect(handlers.users).not.toHaveBeenCalled();
  });

  it("routes to the tenant handler for the tool's domain and strips account_id", async () => {
    handlers.users.mockResolvedValue(ok);

    const result = await callViaPartner("knowbe4_users_list", { account_id: 5, status: "active", page: 2 });

    expect(handlers.users).toHaveBeenCalledWith("knowbe4_users_list", 5, { status: "active", page: 2 });
    expect(result).toBe(ok);
  });

  it("routes store purchases and policies to the training handler", async () => {
    handlers.training.mockResolvedValue(ok);

    await callViaPartner("knowbe4_store_purchases_list", { account_id: 5 });
    await callViaPartner("knowbe4_policies_get", { account_id: 5, policy_id: 9 });

    expect(handlers.training).toHaveBeenNthCalledWith(1, "knowbe4_store_purchases_list", 5, {});
    expect(handlers.training).toHaveBeenNthCalledWith(2, "knowbe4_policies_get", 5, { policy_id: 9 });
  });

  it.each([
    ["knowbe4_account_get", "account"],
    ["knowbe4_groups_list", "groups"],
    ["knowbe4_phishing_campaigns_list", "phishing"],
    ["knowbe4_reporting_risk_overview", "reporting"],
  ] as const)("routes %s to the %s handler", async (toolName, domain) => {
    handlers[domain].mockResolvedValue(ok);
    await callViaPartner(toolName, { account_id: 7 });
    expect(handlers[domain]).toHaveBeenCalledWith(toolName, 7, {});
  });

  it("rejects tools that have no tenant equivalent", async () => {
    const partnerTool = await callViaPartner("knowbe4_partner_accounts_list", { account_id: 5 });
    expect(partnerTool.isError).toBe(true);
    expect(partnerTool.content[0].text).toContain("does not accept account_id");

    const unknown = await callViaPartner("knowbe4_nope", { account_id: 5 });
    expect(unknown.isError).toBe(true);
  });
});
