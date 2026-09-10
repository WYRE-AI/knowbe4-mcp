/**
 * Tests for the partner domain handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/graphql.js", () => ({
  partnerQuery: vi.fn(),
}));

import { partnerHandler, PARTNER_ACCOUNTS_QUERY, PARTNER_ACCOUNT_QUERY } from "../../domains/partner.js";
import { partnerQuery } from "../../utils/graphql.js";

const mockPartnerQuery = vi.mocked(partnerQuery);

describe("Partner Domain Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getTools", () => {
    it("exposes the partner tools", () => {
      const names = partnerHandler.getTools().map((t) => t.name);
      expect(names).toEqual(["knowbe4_partner_accounts_list", "knowbe4_partner_account_get"]);
    });

    it("requires account_id on account_get", () => {
      const tool = partnerHandler.getTools().find((t) => t.name === "knowbe4_partner_account_get")!;
      expect(tool.inputSchema.required).toEqual(["account_id"]);
    });
  });

  describe("knowbe4_partner_accounts_list", () => {
    const listResponse = {
      accounts: {
        nodes: [{ id: 1, companyName: "Acme", riskScore: "42.0" }],
        pagination: { page: 1, pages: 1, per: 100, totalCount: 1 },
      },
    };

    it("queries accounts with defaults (active, page 1, per 100)", async () => {
      mockPartnerQuery.mockResolvedValueOnce(listResponse);

      const result = await partnerHandler.handleCall("knowbe4_partner_accounts_list", {});

      expect(mockPartnerQuery).toHaveBeenCalledWith(PARTNER_ACCOUNTS_QUERY, {
        per: 100,
        page: 1,
        search: undefined,
        status: "ACTIVE",
      });
      expect(PARTNER_ACCOUNTS_QUERY).toContain("accounts(per: $per, page: $page, search: $search, status: $status)");
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.accounts).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
    });

    it("maps search, status, and pagination arguments", async () => {
      mockPartnerQuery.mockResolvedValueOnce(listResponse);

      await partnerHandler.handleCall("knowbe4_partner_accounts_list", {
        search: "  acme  ",
        status: "archived",
        page: 3,
        per_page: 50,
      });

      expect(mockPartnerQuery).toHaveBeenCalledWith(PARTNER_ACCOUNTS_QUERY, {
        per: 50,
        page: 3,
        search: "acme",
        status: "ARCHIVED",
      });
    });

    it("clamps per_page to KnowBe4's 25..1000 window", async () => {
      mockPartnerQuery.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(listResponse);

      await partnerHandler.handleCall("knowbe4_partner_accounts_list", { per_page: 5 });
      await partnerHandler.handleCall("knowbe4_partner_accounts_list", { per_page: 5000 });

      expect(mockPartnerQuery.mock.calls[0][1]).toMatchObject({ per: 25 });
      expect(mockPartnerQuery.mock.calls[1][1]).toMatchObject({ per: 1000 });
    });

    it("propagates partner API errors", async () => {
      mockPartnerQuery.mockRejectedValueOnce(new Error("Authentication failed"));
      await expect(partnerHandler.handleCall("knowbe4_partner_accounts_list", {})).rejects.toThrow(
        "Authentication failed"
      );
    });
  });

  describe("knowbe4_partner_account_get", () => {
    it("requires account_id", async () => {
      const result = await partnerHandler.handleCall("knowbe4_partner_account_get", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("account_id is required");
      expect(mockPartnerQuery).not.toHaveBeenCalled();
    });

    it("returns the managed account", async () => {
      mockPartnerQuery.mockResolvedValueOnce({ account: { id: 7, companyName: "Acme" } });

      const result = await partnerHandler.handleCall("knowbe4_partner_account_get", { account_id: 7 });

      expect(mockPartnerQuery).toHaveBeenCalledWith(PARTNER_ACCOUNT_QUERY, { id: 7 });
      expect(PARTNER_ACCOUNT_QUERY).toContain("account(id: $id)");
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.account_id).toBe(7);
      expect(parsed.account.companyName).toBe("Acme");
    });

    it("errors when the account is not managed by this partner", async () => {
      mockPartnerQuery.mockResolvedValueOnce({ account: null });

      const result = await partnerHandler.handleCall("knowbe4_partner_account_get", { account_id: 7 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found or is not managed by this partner");
    });
  });

  it("rejects unknown tools", async () => {
    const result = await partnerHandler.handleCall("knowbe4_partner_nope", {});
    expect(result.isError).toBe(true);
  });
});
