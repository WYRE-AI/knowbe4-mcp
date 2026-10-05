/**
 * Tests for the partner-mode (tenant GraphQL) account tools
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import { handle, ACCOUNT_QUERY, ACCOUNT_RISK_HISTORY_QUERY } from "../../graphql/account.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);
const ACCOUNT_ID = 4242;

describe("GraphQL account tools", () => {
  describe("knowbe4_account_get", () => {
    it("queries the tenant account and echoes account_id", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        account: { id: ACCOUNT_ID, companyName: "Acme", riskScore: "42.0" },
      });

      const result = await handle("knowbe4_account_get", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ACCOUNT_QUERY);
      expect(ACCOUNT_QUERY).toContain("query TenantAccount");
      expect(ACCOUNT_QUERY).toContain("accountOwner { id email firstName lastName }");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
      expect(parsed.account.companyName).toBe("Acme");
    });

    it("errors when the account is null", async () => {
      mockTenantQuery.mockResolvedValueOnce({ account: null });

      const result = await handle("knowbe4_account_get", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: account ${ACCOUNT_ID} returned no data`);
    });

    it("propagates tenant API errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));
      await expect(handle("knowbe4_account_get", ACCOUNT_ID, {})).rejects.toThrow("Authentication failed");
    });
  });

  describe("knowbe4_account_risk_score_history", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      riskScore: 40 - i,
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    }));

    it("queries full history and defaults to page 1, per_page 100", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        account: { id: ACCOUNT_ID, accountRiskScoreHistories: entries },
      });

      const result = await handle("knowbe4_account_risk_score_history", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ACCOUNT_RISK_HISTORY_QUERY);
      expect(ACCOUNT_RISK_HISTORY_QUERY).toContain("query TenantAccountRiskScoreHistory");
      expect(ACCOUNT_RISK_HISTORY_QUERY).toContain("accountRiskScoreHistories(fullHistory: true)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history).toHaveLength(7);
      expect(parsed.total).toBe(7);
      expect(parsed.page).toBe(1);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("slices history client-side by page and per_page", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        account: { id: ACCOUNT_ID, accountRiskScoreHistories: entries },
      });

      const result = await handle("knowbe4_account_risk_score_history", ACCOUNT_ID, {
        page: 2,
        per_page: 3,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history.map((e: { id: number }) => e.id)).toEqual([4, 5, 6]);
      expect(parsed.total).toBe(7);
      expect(parsed.page).toBe(2);
      expect(parsed.per_page).toBe(3);
    });

    it("returns an empty page past the end of history", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        account: { id: ACCOUNT_ID, accountRiskScoreHistories: entries },
      });

      const result = await handle("knowbe4_account_risk_score_history", ACCOUNT_ID, {
        page: 5,
        per_page: 3,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history).toEqual([]);
      expect(parsed.total).toBe(7);
    });

    it("treats a null history list as empty", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        account: { id: ACCOUNT_ID, accountRiskScoreHistories: null },
      });

      const result = await handle("knowbe4_account_risk_score_history", ACCOUNT_ID, {});

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history).toEqual([]);
      expect(parsed.total).toBe(0);
    });

    it("errors when the account is null", async () => {
      mockTenantQuery.mockResolvedValueOnce({ account: null });

      const result = await handle("knowbe4_account_risk_score_history", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: account ${ACCOUNT_ID} returned no data`);
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_account_nope", ACCOUNT_ID, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown account tool: knowbe4_account_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
