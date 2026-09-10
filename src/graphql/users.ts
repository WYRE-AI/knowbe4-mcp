/**
 * Users tools, partner mode.
 *
 * Re-implements the users tools from src/domains/users.ts over KnowBe4's
 * tenant GraphQL API, authenticated with a JIT token for one managed
 * account. Tool names, argument names, and validation messages match the
 * REST handler so the two can be swapped by mode.
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

/** Tool `status` argument -> `enum UserStatusFilters` value. */
const STATUS_FILTERS: Record<string, string> = {
  active: "ACTIVE",
  archived: "ARCHIVED",
};

export const USERS_QUERY = `query TenantUsers($per: Int, $page: Int, $status: UserStatusFilters, $group: Int) {
  users(per: $per, page: $page, status: $status, group: $group) {
    nodes {
      id email firstName lastName displayName
      department jobTitle managerName managerEmail
      riskScore currentPpp archived groupIds
      lastSignInAt createdAt
    }
    pagination { page pages per totalCount }
  }
}`;

export const USER_QUERY = `query TenantUser($id: Int!) {
  user(id: $id) {
    id email firstName lastName displayName
    department jobTitle division location employeeNumber
    managerName managerEmail
    riskScore currentPpp role admin archived
    groupIds groups { id name }
    lastSignInAt createdAt
  }
}`;

export const RISK_SCORE_HISTORY_QUERY = `query TenantUserRiskScoreHistory($per: Int, $page: Int, $userId: Int!) {
  riskScoreHistories(per: $per, page: $page, userId: $userId) {
    nodes { id riskScore createdAt }
    pagination { page pages per totalCount }
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

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handle(
  toolName: string,
  accountId: number,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_users_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const status = typeof args.status === "string" ? STATUS_FILTERS[args.status.toLowerCase()] : undefined;
      const group = (args.group_id as number) || undefined;

      logger.info("API call: users.list (partner)", { accountId, page, per, status, group });

      const data = await tenantQuery<{ users: Cursor }>(accountId, USERS_QUERY, { per, page, status, group });

      logger.debug("API response: users.list (partner)", { accountId, count: data.users.nodes.length });

      return jsonResult({
        users: data.users.nodes,
        pagination: data.users.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_users_get": {
      const userId = args.user_id as number;
      if (!userId) return errorResult("Error: user_id is required");

      logger.info("API call: users.get (partner)", { accountId, userId });

      const data = await tenantQuery<{ user: unknown | null }>(accountId, USER_QUERY, { id: userId });

      if (!data.user) {
        return errorResult(`Error: user ${userId} not found in account ${accountId}`);
      }

      return jsonResult({ user: data.user, account_id: accountId });
    }

    case "knowbe4_users_risk_score_history": {
      const userId = args.user_id as number;
      if (!userId) return errorResult("Error: user_id is required");

      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: users.riskScoreHistory (partner)", { accountId, userId, page, per });

      const data = await tenantQuery<{ riskScoreHistories: Cursor }>(accountId, RISK_SCORE_HISTORY_QUERY, {
        per,
        page,
        userId,
      });

      logger.debug("API response: users.riskScoreHistory (partner)", {
        accountId,
        userId,
        count: data.riskScoreHistories.nodes.length,
      });

      return jsonResult({
        risk_score_history: data.riskScoreHistories.nodes,
        pagination: data.riskScoreHistories.pagination,
        user_id: userId,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    default:
      return errorResult(`Unknown users tool: ${toolName}`);
  }
}
