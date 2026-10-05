/**
 * Tests for the partner-mode (GraphQL) reporting tools
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import {
  handle,
  PHISHING_RUNS_QUERY,
  TRAINING_CAMPAIGNS_QUERY,
  ACCOUNT_RISK_QUERY,
  GROUP_RISK_QUERY,
} from "../../graphql/reporting.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);

const ACCOUNT_ID = 42;
const pagination = { page: 1, pages: 1, per: 500, totalCount: 2 };

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("GraphQL reporting tools", () => {
  describe("knowbe4_reporting_phishing_summary", () => {
    const runsResponse = {
      phishingCampaignRuns: {
        nodes: [
          { id: 1, totalDelivered: 100, totalOpened: 40, totalClicked: 20, totalReported: 10, phishPronePercentage: 20 },
          { id: 2, totalDelivered: 100, totalOpened: 30, totalClicked: 5, totalReported: 20, phishPronePercentage: 5 },
        ],
        pagination,
      },
    };

    it("queries phishing runs with defaults (page 1, per 500) and computes the summary", async () => {
      mockTenantQuery.mockResolvedValueOnce(runsResponse);

      const result = await handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, PHISHING_RUNS_QUERY, { per: 500, page: 1 });
      expect(PHISHING_RUNS_QUERY).toContain("phishingCampaignRuns(per: $per, page: $page)");
      expect(PHISHING_RUNS_QUERY).toContain("totalDelivered totalOpened totalClicked totalReported phishPronePercentage");
      expect(result.isError).toBeUndefined();

      expect(parse(result)).toEqual({
        total_security_tests: 2,
        total_emails_delivered: 200,
        total_opened: 70,
        total_clicked: 25,
        total_reported: 30,
        average_phish_prone_percentage: 12.5,
        click_rate: 12.5,
        report_rate: 15,
        page: 1,
        per_page: 500,
        account_id: ACCOUNT_ID,
      });
    });

    it("coerces string percentages and skips values that are not numeric", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        phishingCampaignRuns: {
          nodes: [
            { id: 1, totalDelivered: "50", totalClicked: "10", totalReported: "0", phishPronePercentage: "33.3" },
            { id: 2, totalDelivered: 50, totalClicked: 15, totalReported: 5, phishPronePercentage: "66.7" },
            { id: 3, totalDelivered: null, totalClicked: null, totalReported: null, phishPronePercentage: "n/a" },
          ],
          pagination,
        },
      });

      const parsed = parse(await handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, {}));

      expect(parsed.total_security_tests).toBe(3);
      expect(parsed.total_emails_delivered).toBe(100);
      expect(parsed.total_clicked).toBe(25);
      expect(parsed.total_reported).toBe(5);
      expect(parsed.average_phish_prone_percentage).toBe(50);
      expect(parsed.click_rate).toBe(25);
      expect(parsed.report_rate).toBe(5);
    });

    it("returns null rates when nothing was delivered", async () => {
      mockTenantQuery.mockResolvedValueOnce({ phishingCampaignRuns: { nodes: [], pagination } });

      const parsed = parse(await handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, {}));

      expect(parsed.total_security_tests).toBe(0);
      expect(parsed.average_phish_prone_percentage).toBeNull();
      expect(parsed.click_rate).toBeNull();
      expect(parsed.report_rate).toBeNull();
    });

    it("passes page through and clamps per_page to KnowBe4's 25..1000 window", async () => {
      mockTenantQuery.mockResolvedValue(runsResponse);

      await handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, { page: 3, per_page: 5 });
      await handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, { page: 2, per_page: 5000 });

      expect(mockTenantQuery).toHaveBeenNthCalledWith(1, ACCOUNT_ID, PHISHING_RUNS_QUERY, { per: 25, page: 3 });
      expect(mockTenantQuery).toHaveBeenNthCalledWith(2, ACCOUNT_ID, PHISHING_RUNS_QUERY, { per: 1000, page: 2 });
    });

    it("propagates tenant API errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));
      await expect(handle("knowbe4_reporting_phishing_summary", ACCOUNT_ID, {})).rejects.toThrow(
        "Authentication failed"
      );
    });
  });

  describe("knowbe4_reporting_training_summary", () => {
    it("queries training campaigns and splits active from completed", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        trainingCampaigns: {
          nodes: [
            { id: 1, name: "Onboarding", status: "IN_PROGRESS" },
            { id: 2, name: "Q1", status: "CLOSED" },
            { id: 3, name: "Q2", status: "COMPLETED" },
            { id: 4, name: "Q3", status: "ENROLLING" },
            { id: 5, name: "Q4", status: "CREATED" },
          ],
          pagination,
        },
      });

      const result = await handle("knowbe4_reporting_training_summary", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, TRAINING_CAMPAIGNS_QUERY, { per: 500, page: 1 });
      expect(TRAINING_CAMPAIGNS_QUERY).toContain("trainingCampaigns(per: $per, page: $page)");
      expect(TRAINING_CAMPAIGNS_QUERY).toContain("nodes { id name status }");
      expect(result.isError).toBeUndefined();

      expect(parse(result)).toEqual({
        total_campaigns: 5,
        active_campaigns: 3,
        completed_campaigns: 2,
        page: 1,
        per_page: 500,
        account_id: ACCOUNT_ID,
      });
    });

    it("passes page through and clamps per_page", async () => {
      mockTenantQuery.mockResolvedValueOnce({ trainingCampaigns: { nodes: [], pagination } });

      const parsed = parse(await handle("knowbe4_reporting_training_summary", ACCOUNT_ID, { page: 2, per_page: 10 }));

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, TRAINING_CAMPAIGNS_QUERY, { per: 25, page: 2 });
      expect(parsed.page).toBe(2);
      expect(parsed.per_page).toBe(25);
      expect(parsed.total_campaigns).toBe(0);
    });
  });

  describe("knowbe4_reporting_risk_overview", () => {
    // 12 entries, oldest first, so the handler has to sort and truncate.
    const histories = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      riskScore: 30 + i,
      createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));

    const accountResponse = {
      account: {
        companyName: "Acme Corp",
        displayName: "Acme",
        riskScore: "41.5",
        latestRiskScore: 41.2,
        numberOfStandardSeats: 250,
        allUserCount: 240,
        phishPronePercentage: "12.3",
        partnerSubscriptionType: "Diamond",
        accountRiskScoreHistories: histories,
      },
    };

    const groupsResponse = {
      groups: {
        nodes: [
          { id: 1, name: "Zero", riskScore: 0, memberCount: 10 },
          { id: 2, name: "Sales", riskScore: 55.5, memberCount: 20 },
          { id: 3, name: "Unknown", riskScore: null, memberCount: 3 },
          { id: 4, name: "Finance", riskScore: "70.1", memberCount: 8 },
          { id: 5, name: "Eng", riskScore: 42, memberCount: 50 },
          { id: 6, name: "Exec", riskScore: 88, memberCount: 5 },
          { id: 7, name: "Ops", riskScore: 61, memberCount: 12 },
          { id: 8, name: "Support", riskScore: 30, memberCount: 15 },
        ],
        pagination: { page: 1, pages: 1, per: 500, totalCount: 8 },
      },
    };

    function mockRiskQueries() {
      mockTenantQuery.mockImplementation(async (_accountId, query) => {
        if (query === ACCOUNT_RISK_QUERY) return accountResponse;
        if (query === GROUP_RISK_QUERY) return groupsResponse;
        throw new Error(`Unexpected query: ${query}`);
      });
    }

    it("queries account and groups, and builds the overview", async () => {
      mockRiskQueries();

      const result = await handle("knowbe4_reporting_risk_overview", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledTimes(2);
      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ACCOUNT_RISK_QUERY);
      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_RISK_QUERY, { per: 500, page: 1 });
      expect(ACCOUNT_RISK_QUERY).toContain("accountRiskScoreHistories(fullHistory: false) { id riskScore createdAt }");
      expect(GROUP_RISK_QUERY).toContain("nodes { id name riskScore memberCount }");
      expect(result.isError).toBeUndefined();

      const parsed = parse(result);
      expect(parsed.account_name).toBe("Acme Corp");
      expect(parsed.current_risk_score).toBe(41.5);
      expect(parsed.number_of_seats).toBe(250);
      expect(parsed.subscription_level).toBe("Diamond");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("returns the 10 most recent risk history entries, newest first", async () => {
      mockRiskQueries();

      const parsed = parse(await handle("knowbe4_reporting_risk_overview", ACCOUNT_ID, {}));

      expect(parsed.recent_risk_history).toHaveLength(10);
      expect(parsed.recent_risk_history[0]).toEqual({ risk_score: 41, date: "2026-01-12T00:00:00Z" });
      expect(parsed.recent_risk_history[9]).toEqual({ risk_score: 32, date: "2026-01-03T00:00:00Z" });
    });

    it("returns the top 5 groups by risk score, skipping null and zero scores", async () => {
      mockRiskQueries();

      const parsed = parse(await handle("knowbe4_reporting_risk_overview", ACCOUNT_ID, {}));

      expect(parsed.highest_risk_groups).toEqual([
        { id: 6, name: "Exec", risk_score: 88, member_count: 5 },
        { id: 4, name: "Finance", risk_score: 70.1, member_count: 8 },
        { id: 7, name: "Ops", risk_score: 61, member_count: 12 },
        { id: 2, name: "Sales", risk_score: 55.5, member_count: 20 },
        { id: 5, name: "Eng", risk_score: 42, member_count: 50 },
      ]);
    });

    it("falls back to displayName and latestRiskScore when primary fields are missing", async () => {
      mockTenantQuery.mockImplementation(async (_accountId, query) => {
        if (query === ACCOUNT_RISK_QUERY) {
          return {
            account: {
              displayName: "Acme",
              riskScore: null,
              latestRiskScore: 39.9,
              accountRiskScoreHistories: null,
            },
          };
        }
        return { groups: { nodes: [], pagination } };
      });

      const parsed = parse(await handle("knowbe4_reporting_risk_overview", ACCOUNT_ID, {}));

      expect(parsed.account_name).toBe("Acme");
      expect(parsed.current_risk_score).toBe(39.9);
      expect(parsed.number_of_seats).toBeNull();
      expect(parsed.subscription_level).toBeNull();
      expect(parsed.recent_risk_history).toEqual([]);
      expect(parsed.highest_risk_groups).toEqual([]);
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_reporting_nope", ACCOUNT_ID, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown reporting tool: knowbe4_reporting_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
