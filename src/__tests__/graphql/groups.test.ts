/**
 * Tests for the partner-mode (GraphQL) groups handler
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import {
  handle,
  GROUPS_QUERY,
  GROUP_QUERY,
  GROUP_MEMBERS_QUERY,
  GROUP_RISK_SCORE_HISTORY_QUERY,
} from "../../graphql/groups.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);

const ACCOUNT_ID = 4242;
const pagination = { page: 1, pages: 1, per: 100, totalCount: 1 };

describe("Partner-mode groups handler", () => {
  describe("knowbe4_groups_list", () => {
    const listResponse = {
      groups: {
        nodes: [{ id: 1, name: "Finance", memberCount: 12, riskScore: 41.5 }],
        pagination,
      },
    };

    it("queries groups with defaults (active, page 1, per 100)", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse);

      const result = await handle("knowbe4_groups_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUPS_QUERY, {
        per: 100,
        page: 1,
        status: "ACTIVE",
      });
      expect(GROUPS_QUERY).toContain("groups(per: $per, page: $page, status: $status)");
      expect(GROUPS_QUERY).toContain("pagination { page pages per totalCount }");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.groups).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.page).toBe(1);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps page, per_page, and status arguments", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse);

      await handle("knowbe4_groups_list", ACCOUNT_ID, { page: 3, per_page: 50, status: "archived" });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUPS_QUERY, {
        per: 50,
        page: 3,
        status: "ARCHIVED",
      });
    });

    it("clamps per_page to KnowBe4's 25..1000 window", async () => {
      mockTenantQuery.mockResolvedValueOnce(listResponse).mockResolvedValueOnce(listResponse);

      await handle("knowbe4_groups_list", ACCOUNT_ID, { per_page: 5 });
      await handle("knowbe4_groups_list", ACCOUNT_ID, { per_page: 5000 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25 });
      expect(mockTenantQuery.mock.calls[1][2]).toMatchObject({ per: 1000 });
    });

    it("propagates tenant API errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));

      await expect(handle("knowbe4_groups_list", ACCOUNT_ID, {})).rejects.toThrow("Authentication failed");
    });
  });

  describe("knowbe4_groups_get", () => {
    it("requires group_id", async () => {
      const result = await handle("knowbe4_groups_get", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("group_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the group", async () => {
      mockTenantQuery.mockResolvedValueOnce({ group: { id: 7, name: "Finance", memberCount: 12 } });

      const result = await handle("knowbe4_groups_get", ACCOUNT_ID, { group_id: 7 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_QUERY, { id: 7 });
      expect(GROUP_QUERY).toContain("group(id: $id)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.group.name).toBe("Finance");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the group does not exist", async () => {
      mockTenantQuery.mockResolvedValueOnce({ group: null });

      const result = await handle("knowbe4_groups_get", ACCOUNT_ID, { group_id: 7 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(`Error: group 7 not found in account ${ACCOUNT_ID}`);
    });
  });

  describe("knowbe4_groups_members", () => {
    const membersResponse = {
      users: {
        nodes: [{ id: 99, email: "jane@acme.test", firstName: "Jane", lastName: "Doe" }],
        pagination,
      },
    };

    it("requires group_id", async () => {
      const result = await handle("knowbe4_groups_members", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("group_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("queries users filtered by group with defaults", async () => {
      mockTenantQuery.mockResolvedValueOnce(membersResponse);

      const result = await handle("knowbe4_groups_members", ACCOUNT_ID, { group_id: 7 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_MEMBERS_QUERY, {
        per: 100,
        page: 1,
        group: 7,
      });
      expect(GROUP_MEMBERS_QUERY).toContain("users(per: $per, page: $page, group: $group)");
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.members).toHaveLength(1);
      expect(parsed.members[0].email).toBe("jane@acme.test");
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.group_id).toBe(7);
      expect(parsed.page).toBe(1);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps page and clamps per_page", async () => {
      mockTenantQuery.mockResolvedValueOnce(membersResponse);

      await handle("knowbe4_groups_members", ACCOUNT_ID, { group_id: 7, page: 2, per_page: 5 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_MEMBERS_QUERY, {
        per: 25,
        page: 2,
        group: 7,
      });
    });
  });

  describe("knowbe4_groups_risk_score_history", () => {
    const historyResponse = {
      groupRiskScoreHistories: {
        nodes: [{ id: 1, riskScore: 38.2, createdAt: "2026-09-01T00:00:00Z" }],
        pagination,
      },
    };

    it("requires group_id", async () => {
      const result = await handle("knowbe4_groups_risk_score_history", ACCOUNT_ID, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("group_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("queries risk score history with defaults", async () => {
      mockTenantQuery.mockResolvedValueOnce(historyResponse);

      const result = await handle("knowbe4_groups_risk_score_history", ACCOUNT_ID, { group_id: 7 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_RISK_SCORE_HISTORY_QUERY, {
        per: 100,
        page: 1,
        groupId: 7,
      });
      expect(GROUP_RISK_SCORE_HISTORY_QUERY).toContain(
        "groupRiskScoreHistories(per: $per, page: $page, groupId: $groupId)"
      );
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.risk_score_history).toHaveLength(1);
      expect(parsed.risk_score_history[0].riskScore).toBe(38.2);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.group_id).toBe(7);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps page and clamps per_page", async () => {
      mockTenantQuery.mockResolvedValueOnce(historyResponse);

      await handle("knowbe4_groups_risk_score_history", ACCOUNT_ID, { group_id: 7, page: 4, per_page: 5 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, GROUP_RISK_SCORE_HISTORY_QUERY, {
        per: 25,
        page: 4,
        groupId: 7,
      });
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_groups_nope", ACCOUNT_ID, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown groups tool: knowbe4_groups_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
