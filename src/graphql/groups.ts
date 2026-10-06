/**
 * Groups domain, partner mode.
 *
 * Mirrors src/domains/groups.ts tool-for-tool, but runs against the KnowBe4
 * tenant GraphQL API for one managed account using a JIT token:
 * - knowbe4_groups_list               -> groups(per, page, status)
 * - knowbe4_groups_get                -> group(id)
 * - knowbe4_groups_members            -> users(per, page, group)
 * - knowbe4_groups_risk_score_history -> groupRiskScoreHistories(per, page, groupId)
 *
 * Selections are kept small: KnowBe4 caps query complexity at 150 lines.
 */

import type { CallToolResult } from "../utils/types.js";
import { tenantQuery } from "../utils/jit.js";
import { logger } from "../utils/logger.js";

/** KnowBe4 GraphQL enforces a minimum page size of 25 on paginated cursors. */
const MIN_PER_PAGE = 25;
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 100;

const GROUP_FIELDS =
  "id name displayName groupType status memberCount riskScore accountId ldapObjectGuid hasCampaignRuns createdAt updatedAt";

const PAGINATION_FIELDS = "pagination { page pages per totalCount }";

export const GROUPS_QUERY = `query GroupsList($per: Int, $page: Int, $status: GroupStatuses) {
  groups(per: $per, page: $page, status: $status) {
    nodes { ${GROUP_FIELDS} }
    ${PAGINATION_FIELDS}
  }
}`;

export const GROUP_QUERY = `query GroupGet($id: Int!) {
  group(id: $id) {
    ${GROUP_FIELDS} userPhishingLocales
  }
}`;

export const GROUP_MEMBERS_QUERY = `query GroupMembers($per: Int, $page: Int, $group: Int!) {
  users(per: $per, page: $page, group: $group) {
    nodes {
      id email firstName lastName displayName jobTitle department location managerEmail
      role archived riskScore currentPpp lastSignInAt
    }
    ${PAGINATION_FIELDS}
  }
}`;

export const GROUP_RISK_SCORE_HISTORY_QUERY = `query GroupRiskScoreHistory($per: Int, $page: Int, $groupId: Int!) {
  groupRiskScoreHistories(per: $per, page: $page, groupId: $groupId) {
    nodes { id riskScore createdAt }
    ${PAGINATION_FIELDS}
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

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handle(
  toolName: string,
  accountId: number | null,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_groups_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const status = (typeof args.status === "string" ? args.status : "active").toUpperCase();

      logger.info("API call: groups.list (partner)", { accountId, page, per, status });

      const data = await tenantQuery<{ groups: Cursor }>(accountId, GROUPS_QUERY, { per, page, status });

      return ok({
        groups: data.groups.nodes,
        pagination: data.groups.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_groups_get": {
      const groupId = args.group_id as number;
      if (!groupId) return fail("Error: group_id is required");

      logger.info("API call: groups.get (partner)", { accountId, groupId });

      const data = await tenantQuery<{ group: unknown | null }>(accountId, GROUP_QUERY, { id: groupId });

      if (!data.group) {
        const scope = accountId === null ? "the configured tenant" : `account ${accountId}`;
        return fail(`Error: group ${groupId} not found in ${scope}`);
      }

      return ok({ group: data.group, account_id: accountId });
    }

    case "knowbe4_groups_members": {
      const groupId = args.group_id as number;
      if (!groupId) return fail("Error: group_id is required");

      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: groups.members (partner)", { accountId, groupId, page, per });

      const data = await tenantQuery<{ users: Cursor }>(accountId, GROUP_MEMBERS_QUERY, {
        per,
        page,
        group: groupId,
      });

      return ok({
        members: data.users.nodes,
        pagination: data.users.pagination,
        group_id: groupId,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_groups_risk_score_history": {
      const groupId = args.group_id as number;
      if (!groupId) return fail("Error: group_id is required");

      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: groups.riskScoreHistory (partner)", { accountId, groupId, page, per });

      const data = await tenantQuery<{ groupRiskScoreHistories: Cursor }>(
        accountId,
        GROUP_RISK_SCORE_HISTORY_QUERY,
        { per, page, groupId }
      );

      return ok({
        risk_score_history: data.groupRiskScoreHistories.nodes,
        pagination: data.groupRiskScoreHistories.pagination,
        group_id: groupId,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    default:
      return fail(`Unknown groups tool: ${toolName}`);
  }
}
