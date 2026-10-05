/**
 * Tests for the partner-mode (tenant GraphQL) training handler
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/jit.js", () => ({
  tenantQuery: vi.fn(),
}));

import {
  handle,
  TRAINING_CAMPAIGNS_QUERY,
  TRAINING_CAMPAIGN_QUERY,
  ENROLLMENTS_QUERY,
  ENROLLMENT_QUERY,
  STORE_PURCHASES_QUERY,
  STORE_PURCHASE_QUERY,
  POLICIES_QUERY,
  POLICY_QUERY,
} from "../../graphql/training.js";
import { tenantQuery } from "../../utils/jit.js";

const mockTenantQuery = vi.mocked(tenantQuery);
const ACCOUNT_ID = 7;
const pagination = { page: 1, pages: 1, per: 100, totalCount: 1 };

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("GraphQL training handler (partner mode)", () => {
  describe("knowbe4_training_campaigns_list", () => {
    const response = {
      trainingCampaigns: { nodes: [{ id: 1, name: "Security Basics", status: "IN_PROGRESS" }], pagination },
    };

    it("queries campaigns with defaults (page 1, per 100, no filters)", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      const result = await handle("knowbe4_training_campaigns_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, TRAINING_CAMPAIGNS_QUERY, {
        per: 100,
        page: 1,
        statuses: undefined,
        search: undefined,
      });
      expect(TRAINING_CAMPAIGNS_QUERY).toContain(
        "trainingCampaigns(per: $per, page: $page, statuses: $statuses, search: $search)"
      );
      expect(result.isError).toBeUndefined();
      const parsed = parse(result);
      expect(parsed.campaigns).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.page).toBe(1);
      expect(parsed.per_page).toBe(100);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps a human status onto TrainingCampaignStatuses and trims search", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      await handle("knowbe4_training_campaigns_list", ACCOUNT_ID, {
        status: "in progress",
        search: "  basics  ",
        page: 2,
        per_page: 50,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, TRAINING_CAMPAIGNS_QUERY, {
        per: 50,
        page: 2,
        statuses: ["IN_PROGRESS"],
        search: "basics",
      });
    });

    it("clamps per_page to KnowBe4's 25..1000 window", async () => {
      mockTenantQuery.mockResolvedValueOnce(response).mockResolvedValueOnce(response);

      await handle("knowbe4_training_campaigns_list", ACCOUNT_ID, { per_page: 5 });
      await handle("knowbe4_training_campaigns_list", ACCOUNT_ID, { per_page: 5000 });

      expect(mockTenantQuery.mock.calls[0][2]).toMatchObject({ per: 25 });
      expect(mockTenantQuery.mock.calls[1][2]).toMatchObject({ per: 1000 });
    });

    it("rejects an unknown status without calling the API", async () => {
      const result = await handle("knowbe4_training_campaigns_list", ACCOUNT_ID, { status: "bogus" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("status must be one of");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("propagates GraphQL errors", async () => {
      mockTenantQuery.mockRejectedValueOnce(new Error("Authentication failed"));
      await expect(handle("knowbe4_training_campaigns_list", ACCOUNT_ID, {})).rejects.toThrow(
        "Authentication failed"
      );
    });
  });

  describe("knowbe4_training_campaigns_get", () => {
    it("requires campaign_id", async () => {
      const result = await handle("knowbe4_training_campaigns_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("campaign_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the campaign", async () => {
      mockTenantQuery.mockResolvedValueOnce({ trainingCampaign: { id: 42, name: "Security Basics" } });

      const result = await handle("knowbe4_training_campaigns_get", ACCOUNT_ID, { campaign_id: 42 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, TRAINING_CAMPAIGN_QUERY, { id: 42 });
      expect(TRAINING_CAMPAIGN_QUERY).toContain("trainingCampaign(id: $id)");
      const parsed = parse(result);
      expect(parsed.campaign.name).toBe("Security Basics");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the campaign is missing", async () => {
      mockTenantQuery.mockResolvedValueOnce({ trainingCampaign: null });

      const result = await handle("knowbe4_training_campaigns_get", ACCOUNT_ID, { campaign_id: 42 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: training campaign 42 not found in account 7");
    });
  });

  describe("knowbe4_training_enrollments_list", () => {
    const response = {
      enrollments: { nodes: [{ id: 100, status: "PAST_DUE", user: { id: 9, email: "a@b.c" } }], pagination },
    };

    it("queries enrollments with defaults", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      const result = await handle("knowbe4_training_enrollments_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ENROLLMENTS_QUERY, {
        per: 100,
        page: 1,
        trainingCampaignId: undefined,
        userId: undefined,
        status: undefined,
      });
      expect(ENROLLMENTS_QUERY).toContain(
        "enrollments(per: $per, page: $page, trainingCampaignId: $trainingCampaignId, userId: $userId, status: $status)"
      );
      const parsed = parse(result);
      expect(parsed.enrollments).toHaveLength(1);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("maps campaign_id, user_id, and status onto EnrollmentStatuses and echoes them", async () => {
      mockTenantQuery.mockResolvedValueOnce(response);

      const result = await handle("knowbe4_training_enrollments_list", ACCOUNT_ID, {
        campaign_id: 3,
        user_id: 9,
        status: "past due",
        page: 2,
        per_page: 5,
      });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ENROLLMENTS_QUERY, {
        per: 25,
        page: 2,
        trainingCampaignId: 3,
        userId: 9,
        status: "PAST_DUE",
      });
      const parsed = parse(result);
      expect(parsed.campaign_id).toBe(3);
      expect(parsed.user_id).toBe(9);
      expect(parsed.status).toBe("PAST_DUE");
      expect(parsed.page).toBe(2);
      expect(parsed.per_page).toBe(25);
    });

    it("rejects an unknown status without calling the API", async () => {
      const result = await handle("knowbe4_training_enrollments_list", ACCOUNT_ID, { status: "finished" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NOT_STARTED, IN_PROGRESS, COMPLETED, INCOMPLETE, PAST_DUE");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });
  });

  describe("knowbe4_training_enrollments_get", () => {
    it("requires enrollment_id", async () => {
      const result = await handle("knowbe4_training_enrollments_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("enrollment_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the enrollment", async () => {
      mockTenantQuery.mockResolvedValueOnce({ enrollment: { id: 100, status: "COMPLETED" } });

      const result = await handle("knowbe4_training_enrollments_get", ACCOUNT_ID, { enrollment_id: 100 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, ENROLLMENT_QUERY, { id: 100 });
      expect(ENROLLMENT_QUERY).toContain("enrollment(id: $id)");
      const parsed = parse(result);
      expect(parsed.enrollment.status).toBe("COMPLETED");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the enrollment is missing", async () => {
      mockTenantQuery.mockResolvedValueOnce({ enrollment: null });

      const result = await handle("knowbe4_training_enrollments_get", ACCOUNT_ID, { enrollment_id: 100 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: enrollment 100 not found in account 7");
    });
  });

  describe("knowbe4_store_purchases_list", () => {
    it("queries store purchases", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        storePurchases: { nodes: [{ id: 5, purchasedCourse: { title: "Phishing 101" } }], pagination },
      });

      const result = await handle("knowbe4_store_purchases_list", ACCOUNT_ID, { page: 3, per_page: 5 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, STORE_PURCHASES_QUERY, { per: 25, page: 3 });
      expect(STORE_PURCHASES_QUERY).toContain("storePurchases(per: $per, page: $page)");
      const parsed = parse(result);
      expect(parsed.purchases).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.page).toBe(3);
      expect(parsed.per_page).toBe(25);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });
  });

  describe("knowbe4_store_purchases_get", () => {
    it("requires purchase_id", async () => {
      const result = await handle("knowbe4_store_purchases_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("purchase_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the purchase, passing only id", async () => {
      mockTenantQuery.mockResolvedValueOnce({ storePurchase: { id: 5, enrollmentCount: 12 } });

      const result = await handle("knowbe4_store_purchases_get", ACCOUNT_ID, { purchase_id: 5 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, STORE_PURCHASE_QUERY, { id: 5 });
      expect(STORE_PURCHASE_QUERY).toContain("storePurchase(id: $id)");
      const parsed = parse(result);
      expect(parsed.purchase.enrollmentCount).toBe(12);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the purchase is missing", async () => {
      mockTenantQuery.mockResolvedValueOnce({ storePurchase: null });

      const result = await handle("knowbe4_store_purchases_get", ACCOUNT_ID, { purchase_id: 5 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: store purchase 5 not found in account 7");
    });
  });

  describe("knowbe4_policies_list", () => {
    it("queries policies", async () => {
      mockTenantQuery.mockResolvedValueOnce({
        policies: { nodes: [{ id: 8, title: "Acceptable Use", status: "PUBLISHED" }], pagination },
      });

      const result = await handle("knowbe4_policies_list", ACCOUNT_ID, {});

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, POLICIES_QUERY, { per: 100, page: 1 });
      expect(POLICIES_QUERY).toContain("policies(per: $per, page: $page)");
      const parsed = parse(result);
      expect(parsed.policies).toHaveLength(1);
      expect(parsed.pagination.totalCount).toBe(1);
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });
  });

  describe("knowbe4_policies_get", () => {
    it("requires policy_id", async () => {
      const result = await handle("knowbe4_policies_get", ACCOUNT_ID, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("policy_id is required");
      expect(mockTenantQuery).not.toHaveBeenCalled();
    });

    it("returns the policy", async () => {
      mockTenantQuery.mockResolvedValueOnce({ policy: { id: 8, title: "Acceptable Use" } });

      const result = await handle("knowbe4_policies_get", ACCOUNT_ID, { policy_id: 8 });

      expect(mockTenantQuery).toHaveBeenCalledWith(ACCOUNT_ID, POLICY_QUERY, { id: 8 });
      expect(POLICY_QUERY).toContain("policy(id: $id)");
      const parsed = parse(result);
      expect(parsed.policy.title).toBe("Acceptable Use");
      expect(parsed.account_id).toBe(ACCOUNT_ID);
    });

    it("errors when the policy is missing", async () => {
      mockTenantQuery.mockResolvedValueOnce({ policy: null });

      const result = await handle("knowbe4_policies_get", ACCOUNT_ID, { policy_id: 8 });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: policy 8 not found in account 7");
    });
  });

  it("rejects unknown tools", async () => {
    const result = await handle("knowbe4_training_nope", ACCOUNT_ID, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Unknown training tool: knowbe4_training_nope");
    expect(mockTenantQuery).not.toHaveBeenCalled();
  });
});
