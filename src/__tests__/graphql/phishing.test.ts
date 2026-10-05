/**
 * Tests for the partner-mode (tenant GraphQL) phishing handler
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import {
  handle,
  PHISHING_CAMPAIGNS_QUERY,
  PHISHING_CAMPAIGN_QUERY,
  PHISHING_CAMPAIGN_RUNS_QUERY,
  PHISHING_CAMPAIGN_RUN_QUERY,
  PHISHING_CAMPAIGN_RECIPIENTS_QUERY,
  PHISHING_CAMPAIGN_RECIPIENT_QUERY,
} from "../../graphql/phishing.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);

const ACCOUNT_ID = 4242;
const pagination = { page: 1, pages: 1, per: 100, totalCount: 1 };

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("GraphQL phishing handler", () => {
  describe("query documents", () => {
    it("names every operation and targets the tenant root fields", () => {
      expect(PHISHING_CAMPAIGNS_QUERY).toMatch(/^query PhishingCampaigns\(/);
      expect(PHISHING_CAMPAIGNS_QUERY).toContain(
        "phishingCampaigns(per: $per, page: $page, filter: $filter, search: $search)"
      );
      expect(PHISHING_CAMPAIGN_QUERY).toMatch(/^query PhishingCampaign\(/);
      expect(PHISHING_CAMPAIGN_QUERY).toContain("phishingCampaign(id: $id)");
      expect(PHISHING_CAMPAIGN_RUNS_QUERY).toMatch(/^query PhishingCampaignRuns\(/);
      expect(PHISHING_CAMPAIGN_RUNS_QUERY).toContain(
        "phishingCampaignRuns(per: $per, page: $page, campaignId: $campaignId)"
      );
      expect(PHISHING_CAMPAIGN_RUN_QUERY).toMatch(/^query PhishingCampaignRun\(/);
      expect(PHISHING_CAMPAIGN_RUN_QUERY).toContain("phishingCampaignRun(id: $id)");
      expect(PHISHING_CAMPAIGN_RECIPIENTS_QUERY).toMatch(/^query PhishingCampaignRecipients\(/);
      expect(PHISHING_CAMPAIGN_RECIPIENTS_QUERY).toContain(
        "phishingCampaignRecipients(per: $per, page: $page, campaignRunId: $campaignRunId)"
      );
      expect(PHISHING_CAMPAIGN_RECIPIENT_QUERY).toMatch(/^query PhishingCampaignRecipient\(\$campaignRunId: Int, \$id: ID!\)/);
      expect(PHISHING_CAMPAIGN_RECIPIENT_QUERY).toContain(
        "phishingCampaignRecipient(campaignRunId: $campaignRunId, id: $id)"
      );
    });

    it("selects nodes and pagination on every cursor query", () => {
      for (const query of [
        PHISHING_CAMPAIGNS_QUERY,
        PHISHING_CAMPAIGN_RUNS_QUERY,
        PHISHING_CAMPAIGN_RECIPIENTS_QUERY,
      ]) {
        expect(query).toContain("nodes {");
        expect(query).toContain("pagination { page pages per totalCount }");
      }
    });
  });

  describe("knowbe4_phishing_campaigns_list", () => {
    const response = {
      phishingCampaigns: { nodes: [{ id: 1, name: "Q1 Phish", active: true }], pagination },
    };

    it("lists campaigns with defaults (page 1, per 100, no filter)", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      const result = await handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGNS_QUERY, {
        per: 100,
        page: 1,
        filter: undefined,
        search: undefined,
      });
      expect(result.isError).toBeUndefined();
      const parsed = parse(result);
      expect(parsed.campaigns).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed).toMatchObject({ page: 1, per_page: 100, account_id: ACCOUNT_ID });
    });

    it("maps status onto PhishingCampaignFilters and trims search", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      await handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, {
        status: "inactive",
        search: "  quarterly ",
        page: 2,
        per_page: 50,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGNS_QUERY, {
        per: 50,
        page: 2,
        filter: "INACTIVE",
        search: "quarterly",
      });
    });

    it("drops a status that is not a PhishingCampaignFilters value", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      await handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, { status: "closed" });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ filter: undefined });
    });

    it("clamps per_page into KnowBe4's 25..1000 window", async () => {
      mockTenantQuery.mockResolvedValueOnce(response).mockResolvedValueOnce(response);

      await handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, { per_page: 5 });
      await handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, { per_page: 5000 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25 });
      expect(mockTenantQuery.mock.calls[1][2]).toMatchObject({ per: 1000 });
    });

    it("propagates GraphQL errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));
      await expect(handle("knowbe4_phishing_campaigns_list", ACCOUNT_ID, {})).rejects.toThrow(
        "Authentication failed"
      );
    });
  });

  describe("knowbe4_phishing_campaigns_get", () => {
    it("requires campaign_id", async () => {
      const result = await handle("knowbe4_phishing_campaigns_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("campaign_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the campaign", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaign: { id: 7, name: "Q1 Phish" } });

      const result = await handle("knowbe4_phishing_campaigns_get", ACCOUNT_ID, { campaign_id: 7 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_QUERY, { id: 7 });
      expect(result.isError).toBeUndefined();
      const parsed = parse(result);
      expect(parsed.campaign.name).toBe("Q1 Phish");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the campaign does not exist", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaign: null });

      const result = await handle("knowbe4_phishing_campaigns_get", ACCOUNT_ID, { campaign_id: 7 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: campaign 7 not found in account ${ACCOUNT_ID}`);
    });
  });

  describe("knowbe4_phishing_campaign_tests", () => {
    const response = {
      phishingCampaignRuns: { nodes: [{ id: 99, status: "CLOSED", phishPronePercentage: 12.5 }], pagination },
    };

    it("requires campaign_id", async () => {
      const result = await handle("knowbe4_phishing_campaign_tests", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("campaign_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("lists runs scoped to the campaign", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      const result = await handle("knowbe4_phishing_campaign_tests", ACCOUNT_ID, {
        campaign_id: 7,
        page: 3,
        per_page: 30,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_RUNS_QUERY, {
        per: 30,
        page: 3,
        campaignId: 7,
      });
      const parsed = parse(result);
      expect(parsed.security_tests).toHaveLength(1);
      expect(parsed).toMatchObject({ campaign_id: 7, page: 3, per_page: 30, account_id: ACCOUNT_ID });
      expect(parsed.pagination).toEqual(pagination);
    });
  });

  describe("knowbe4_phishing_security_tests_list", () => {
    it("lists every run in the account", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        phishingCampaignRuns: { nodes: [{ id: 99 }, { id: 100 }], pagination },
      });

      const result = await handle("knowbe4_phishing_security_tests_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_RUNS_QUERY, {
        per: 100,
        page: 1,
        campaignId: undefined,
      });
      const parsed = parse(result);
      expect(parsed.security_tests).toHaveLength(2);
      expect(parsed.campaign_id).toBeUndefined();
      expect(parsed).toMatchObject({ page: 1, per_page: 100, account_id: ACCOUNT_ID });
    });

    it("clamps per_page to the minimum of 25", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaignRuns: { nodes: [], pagination } });

      await handle("knowbe4_phishing_security_tests_list", ACCOUNT_ID, { per_page: 5 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25 });
    });
  });

  describe("knowbe4_phishing_security_test_get", () => {
    it("requires pst_id", async () => {
      const result = await handle("knowbe4_phishing_security_test_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("pst_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the run", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        phishingCampaignRun: { id: 99, status: "CLOSED", totalClicked: 3 },
      });

      const result = await handle("knowbe4_phishing_security_test_get", ACCOUNT_ID, { pst_id: 99 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_RUN_QUERY, { id: 99 });
      const parsed = parse(result);
      expect(parsed.security_test.totalClicked).toBe(3);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the run does not exist", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaignRun: null });

      const result = await handle("knowbe4_phishing_security_test_get", ACCOUNT_ID, { pst_id: 99 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: security test 99 not found in account ${ACCOUNT_ID}`);
    });
  });

  describe("knowbe4_phishing_security_test_recipients", () => {
    it("requires pst_id", async () => {
      const result = await handle("knowbe4_phishing_security_test_recipients", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("pst_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("lists recipients of the run", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        phishingCampaignRecipients: {
          nodes: [{ id: "123", email: "a@example.com", clicked: null, user: { id: 5 } }],
          pagination,
        },
      });

      const result = await handle("knowbe4_phishing_security_test_recipients", ACCOUNT_ID, {
        pst_id: 99,
        page: 2,
        per_page: 5,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_RECIPIENTS_QUERY, {
        per: 25,
        page: 2,
        campaignRunId: 99,
      });
      const parsed = parse(result);
      expect(parsed.recipients).toHaveLength(1);
      expect(parsed).toMatchObject({ pst_id: 99, page: 2, per_page: 25, account_id: ACCOUNT_ID });
    });
  });

  describe("knowbe4_phishing_security_test_recipient", () => {
    it("requires pst_id and recipient_id", async () => {
      const missingBoth = await handle("knowbe4_phishing_security_test_recipient", ACCOUNT_ID, {});
      const missingRecipient = await handle("knowbe4_phishing_security_test_recipient", ACCOUNT_ID, { pst_id: 99 });

      for (const result of [missingBoth, missingRecipient]) {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("pst_id and recipient_id are required");
      }
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("passes the recipient id as a string (GraphQL ID!)", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        phishingCampaignRecipient: { id: "123", email: "a@example.com", clicked: "2026-01-01T00:00:00Z" },
      });

      const result = await handle("knowbe4_phishing_security_test_recipient", ACCOUNT_ID, {
        pst_id: 99,
        recipient_id: 123,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_CAMPAIGN_RECIPIENT_QUERY, {
        campaignRunId: 99,
        id: "123",
      });
      const parsed = parse(result);
      expect(parsed.recipient.email).toBe("a@example.com");
      expect(parsed).toMatchObject({ pst_id: 99, account_id: ACCOUNT_ID });
    });

    it("errors when the recipient does not exist", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaignRecipient: null });

      const result = await handle("knowbe4_phishing_security_test_recipient", ACCOUNT_ID, {
        pst_id: 99,
        recipient_id: 123,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `Error: recipient 123 not found in security test 99 in account ${ACCOUNT_ID}`
      );
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_phishing_nope", ACCOUNT_ID, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown phishing tool: knowbe4_phishing_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
