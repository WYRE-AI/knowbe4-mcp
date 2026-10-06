/**
 * Training domain, partner mode (tenant GraphQL over a JIT token).
 *
 * Mirrors src/domains/training.ts tool-for-tool, but reads from KnowBe4's
 * tenant GraphQL API on behalf of a managed account instead of the legacy
 * REST Reporting API:
 * - List and get training campaigns
 * - List and get training enrollments
 * - List and get store purchases
 * - List and get policies
 *
 * Selections are kept small on purpose: KnowBe4 caps query complexity at
 * 150 lines, and nesting stops at one level.
 */

import type { CallToolResult } from "../utils/types.js";
import { tenantQuery } from "../utils/jit.js";
import { logger } from "../utils/logger.js";

/** KnowBe4 GraphQL enforces a minimum page size of 25 on cursor fields. */
const MIN_PER_PAGE = 25;
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 100;

/** `enum TrainingCampaignStatuses` */
const TRAINING_CAMPAIGN_STATUSES = ["CREATED", "ENROLLING", "IN_PROGRESS", "CLOSED", "COMPLETED", "TESTMODE"];

/** `enum EnrollmentStatuses` */
const ENROLLMENT_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "INCOMPLETE", "PAST_DUE"];

export const TRAINING_CAMPAIGNS_QUERY = `query TrainingCampaigns($per: Int, $page: Int, $statuses: [TrainingCampaignStatuses!], $search: String) {
  trainingCampaigns(per: $per, page: $page, statuses: $statuses, search: $search) {
    nodes {
      id name status active type
      startsAt endsAt durationType enrollmentDuration enrollmentDurationType
      percentComplete totalUsers totalTime autoEnroll allUsers
      createdAt updatedAt
    }
    pagination { page pages per totalCount }
  }
}`;

export const TRAINING_CAMPAIGN_QUERY = `query TrainingCampaign($id: Int!) {
  trainingCampaign(id: $id) {
    id name status active type
    startsAt endsAt durationType enrollmentDuration enrollmentDurationType
    percentComplete totalUsers totalTime autoEnroll allUsers
    allowPastDueCompletions sequentialContent trackScores
    createdAt updatedAt
    groups { id name }
    purchasedCourses { id title duration }
    policies { id title status }
  }
}`;

export const ENROLLMENTS_QUERY = `query Enrollments($per: Int, $page: Int, $trainingCampaignId: Int, $userId: Int, $status: EnrollmentStatuses) {
  enrollments(per: $per, page: $page, trainingCampaignId: $trainingCampaignId, userId: $userId, status: $status) {
    nodes {
      id status completionStatus type enrollmentItemType
      started startedAt completed completedAt expiresAt pastDue
      score timeSpentInSeconds storePurchaseId createdAt updatedAt
      user { id email displayName }
      trainingCampaign { id name }
    }
    pagination { page pages per totalCount }
  }
}`;

export const ENROLLMENT_QUERY = `query Enrollment($id: Int!) {
  enrollment(id: $id) {
    id status completionStatus type enrollmentItemType
    started startedAt lastStartedAt completed completedAt expiresAt
    pastDue forcePassed certificateUrl
    score scoreToDisplay timeSpentInSeconds storePurchaseId
    policyAcknowledged policyAcknowledgedAt createdAt updatedAt
    user { id email displayName }
    trainingCampaign { id name status }
  }
}`;

export const STORE_PURCHASES_QUERY = `query StorePurchases($per: Int, $page: Int) {
  storePurchases(per: $per, page: $page) {
    nodes {
      id storeItemUuid purchasedCourseId purchasedAt enrollmentCount
      hidden policyRequired createdAt updatedAt
      purchasedCourse { id title assetType storeItemType duration publishedAt }
    }
    pagination { page pages per totalCount }
  }
}`;

export const STORE_PURCHASE_QUERY = `query StorePurchase($id: Int!) {
  storePurchase(id: $id) {
    id storeItemUuid purchasedCourseId purchasedAt enrollmentCount
    hidden policyRequired policyLocation createdAt updatedAt
    purchasedCourse { id title description assetType storeItemType duration publishedAt retired }
    trainingCampaigns { id name status }
  }
}`;

export const POLICIES_QUERY = `query Policies($per: Int, $page: Int) {
  policies(per: $per, page: $page) {
    nodes {
      id title status type assetType archived retired
      minimumTime pageCount downloadable defaultLanguage languagesCount
      publishedAt createdAt updatedAt
    }
    pagination { page pages per totalCount }
  }
}`;

export const POLICY_QUERY = `query Policy($id: Int!) {
  policy(id: $id) {
    id title status type assetType description archived retired
    minimumTime pageCount passingScore downloadable defaultLanguage languagesCount
    publishedAt createdAt updatedAt
  }
}`;

interface Cursor {
  nodes: unknown[];
  pagination: unknown;
}

function clampPerPage(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, n));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Map a human status ("in progress", "Past Due", "IN_PROGRESS") onto a
 * GraphQL enum value. Returns undefined when no status was given; throws a
 * caller-facing message listing the valid values otherwise.
 */
function toEnum(value: unknown, allowed: string[], argName: string): string | undefined {
  const raw = optionalString(value);
  if (raw === undefined) return undefined;
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!allowed.includes(normalized)) {
    throw new Error(`${argName} must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function notFound(thing: string, id: number, accountId: number | null): CallToolResult {
  const scope = accountId === null ? "the configured tenant" : `account ${accountId}`;
  return error(`${thing} ${id} not found in ${scope}`);
}

export async function handle(
  toolName: string,
  accountId: number | null,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_training_campaigns_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const search = optionalString(args.search);
      let status: string | undefined;
      try {
        status = toEnum(args.status, TRAINING_CAMPAIGN_STATUSES, "status");
      } catch (e) {
        return error((e as Error).message);
      }
      const statuses = status ? [status] : undefined;

      logger.info("API call: training.campaigns.list (partner)", { accountId, page, per, search, status });

      const data = await tenantQuery<{ trainingCampaigns: Cursor }>(accountId, TRAINING_CAMPAIGNS_QUERY, {
        per,
        page,
        statuses,
        search,
      });

      return text({
        campaigns: data.trainingCampaigns.nodes,
        pagination: data.trainingCampaigns.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_training_campaigns_get": {
      const campaignId = args.campaign_id as number;
      if (!campaignId) return error("campaign_id is required");

      logger.info("API call: training.campaigns.get (partner)", { accountId, campaignId });

      const data = await tenantQuery<{ trainingCampaign: unknown | null }>(accountId, TRAINING_CAMPAIGN_QUERY, {
        id: campaignId,
      });
      if (!data.trainingCampaign) return notFound("training campaign", campaignId, accountId);

      return text({ campaign: data.trainingCampaign, account_id: accountId });
    }

    case "knowbe4_training_enrollments_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const campaignId = optionalNumber(args.campaign_id);
      const userId = optionalNumber(args.user_id);
      let status: string | undefined;
      try {
        status = toEnum(args.status, ENROLLMENT_STATUSES, "status");
      } catch (e) {
        return error((e as Error).message);
      }

      logger.info("API call: training.enrollments.list (partner)", {
        accountId,
        page,
        per,
        campaignId,
        userId,
        status,
      });

      const data = await tenantQuery<{ enrollments: Cursor }>(accountId, ENROLLMENTS_QUERY, {
        per,
        page,
        trainingCampaignId: campaignId,
        userId,
        status,
      });

      return text({
        enrollments: data.enrollments.nodes,
        pagination: data.enrollments.pagination,
        campaign_id: campaignId,
        user_id: userId,
        status,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_training_enrollments_get": {
      const enrollmentId = args.enrollment_id as number;
      if (!enrollmentId) return error("enrollment_id is required");

      logger.info("API call: training.enrollments.get (partner)", { accountId, enrollmentId });

      const data = await tenantQuery<{ enrollment: unknown | null }>(accountId, ENROLLMENT_QUERY, {
        id: enrollmentId,
      });
      if (!data.enrollment) return notFound("enrollment", enrollmentId, accountId);

      return text({ enrollment: data.enrollment, account_id: accountId });
    }

    case "knowbe4_store_purchases_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: store.purchases.list (partner)", { accountId, page, per });

      const data = await tenantQuery<{ storePurchases: Cursor }>(accountId, STORE_PURCHASES_QUERY, { per, page });

      return text({
        purchases: data.storePurchases.nodes,
        pagination: data.storePurchases.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_store_purchases_get": {
      const purchaseId = args.purchase_id as number;
      if (!purchaseId) return error("purchase_id is required");

      logger.info("API call: store.purchases.get (partner)", { accountId, purchaseId });

      const data = await tenantQuery<{ storePurchase: unknown | null }>(accountId, STORE_PURCHASE_QUERY, {
        id: purchaseId,
      });
      if (!data.storePurchase) return notFound("store purchase", purchaseId, accountId);

      return text({ purchase: data.storePurchase, account_id: accountId });
    }

    case "knowbe4_policies_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: policies.list (partner)", { accountId, page, per });

      const data = await tenantQuery<{ policies: Cursor }>(accountId, POLICIES_QUERY, { per, page });

      return text({
        policies: data.policies.nodes,
        pagination: data.policies.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_policies_get": {
      const policyId = args.policy_id as number;
      if (!policyId) return error("policy_id is required");

      logger.info("API call: policies.get (partner)", { accountId, policyId });

      const data = await tenantQuery<{ policy: unknown | null }>(accountId, POLICY_QUERY, { id: policyId });
      if (!data.policy) return notFound("policy", policyId, accountId);

      return text({ policy: data.policy, account_id: accountId });
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown training tool: ${toolName}` }],
        isError: true,
      };
  }
}
