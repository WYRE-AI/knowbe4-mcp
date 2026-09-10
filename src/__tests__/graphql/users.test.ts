/**
 * Tests for the partner-mode (GraphQL) users tools
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import { handle, USERS_QUERY, USER_QUERY, RISK_SCORE_HISTORY_QUERY } from "../../graphql/users.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);

const ACCOUNT_ID = 42;
const pagination = { page: 1, pages: 1, per: 100, totalCount: 1 };

describe("GraphQL users tools", () => {
  describe("knowbe4_users_list", () => {
    const listResponse = {
      users: {
        nodes: [{ id: 1, email: "a@example.com", riskScore: 12.5 }],
        pagination,
      },
    };

    it("queries users with defaults (page 1, per 100, no filters)", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse);

      const result = await handle("knowbe4_users_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, USERS_QUERY, {
        per: 100,
        page: 1,
        status: undefined,
        group: undefined,
      });
      expect(USERS_QUERY).toContain("users(per: $per, page: $page, status: $status, group: $group)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.users).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.page).toBe(1);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps status to the UserStatusFilters enum and group_id to group", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(listResponse);

      await handle("knowbe4_users_list", ACCOUNT_ID, { status: "active", group_id: 9, page: 3, per_page: 50 });
      await handle("knowbe4_users_list", ACCOUNT_ID, { status: "archived" });

      expect(mockTenantQuery).toHaveBeenNthCalledWith(1, ACCOUNT_ID, USERS_QUERY, {
        per: 50,
        page: 3,
        status: "ACTIVE",
        group: 9,
      });
      expect(mockTenantQuery).toHaveBeenNthCalledWith(2, ACCOUNT_ID, USERS_QUERY, {
        per: 100,
        page: 1,
        status: "ARCHIVED",
        group: undefined,
      });
    });

    it("clamps per_page to KnowBe4's 25..1000 window", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(listResponse);

      await handle("knowbe4_users_list", ACCOUNT_ID, { per_page: 5 });
      await handle("knowbe4_users_list", ACCOUNT_ID, { per_page: 5000 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25 });
      expect(mockTenantQuery.mock.calls[1][2]).toMatchObject({ per: 1000 });
    });

    it("propagates tenant API errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));

      await expect(handle("knowbe4_users_list", ACCOUNT_ID, {})).rejects.toThrow("Authentication failed");
    });
  });

  describe("knowbe4_users_get", () => {
    it("requires user_id", async () => {
      const result = await handle("knowbe4_users_get", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("user_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the user", async () => {
      mockTenantQuery.mockResolvedValueOnce({ user: { id: 7, email: "b@example.com", groups: [{ id: 1, name: "All" }] } });

      const result = await handle("knowbe4_users_get", ACCOUNT_ID, { user_id: 7 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, USER_QUERY, { id: 7 });
      expect(USER_QUERY).toContain("user(id: $id)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.user.email).toBe("b@example.com");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the user does not exist in the account", async () => {
      mockTenantQuery.mockResolvedValueOnce({ user: null });

      const result = await handle("knowbe4_users_get", ACCOUNT_ID, { user_id: 7 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: user 7 not found in account 42");
    });
  });

  describe("knowbe4_users_risk_score_history", () => {
    const historyResponse = {
      riskScoreHistories: {
        nodes: [{ id: 100, riskScore: 30.2, createdAt: "2026-01-01T00:00:00Z" }],
        pagination,
      },
    };

    it("requires user_id", async () => {
      const result = await handle("knowbe4_users_risk_score_history", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("user_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("queries the risk score history for a user", async () => {
      mockTenantQuery.mockResolvedValueOnce(historyResponse);

      const result = await handle("knowbe4_users_risk_score_history", ACCOUNT_ID, { user_id: 7, page: 2 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, RISK_SCORE_HISTORY_QUERY, {
        per: 100,
        page: 2,
        userId: 7,
      });
      expect(RISK_SCORE_HISTORY_QUERY).toContain("riskScoreHistories(per: $per, page: $page, userId: $userId)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.user_id).toBe(7);
      expect(parsed.page).toBe(2);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("clamps per_page to the minimum of 25", async () => {
      mockTenantQuery.mockResolvedValueOnce(historyResponse);

      await handle("knowbe4_users_risk_score_history", ACCOUNT_ID, { user_id: 7, per_page: 5 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25, userId: 7 });
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_users_nope", ACCOUNT_ID, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown users tool: knowbe4_users_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
