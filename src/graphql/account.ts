/**
 * Account tools over the tenant GraphQL API (partner mode).
 *
 * Mirrors src/domains/account.ts, but every call runs against one managed
 * account using a JIT token minted from the partner key (see utils/jit.ts).
 *
 * Tools:
 * - knowbe4_account_get: the current account's profile and risk metrics
 * - knowbe4_account_risk_score_history: account-level Risk Score history
 */

import type { CallToolResult } from "../utils/types.js";
import { tenantQuery } from "../utils/jit.js";
import { logger } from "../utils/logger.js";

const DEFAULT_PER_PAGE = 100;

export const ACCOUNT_QUERY = `query TenantAccount {
  account {
    id companyName displayName displayNameWithDomain
    riskScore latestRiskScore ppp currentPpp phishPronePercentage
    percentageUsersPhished percentageUsersTrained
    numberOfStandardSeats allUserCount standardUserCount
    pstCount phishingCampaignRunCount trainingCampaignCount purchasedCourseCount
    partnerDisplayName partnerSubscriptionHasApiv2
    timeZone defaultLocale createdAt
    accountOwner { id email firstName lastName }
  }
}`;

/**
 * The tenant schema has no top-level account risk history query; the only
 * source is the (deprecated but present) `Account.accountRiskScoreHistories`
 * field. It is not paginated, so page/per_page are applied client-side.
 */
export const ACCOUNT_RISK_HISTORY_QUERY = `query TenantAccountRiskScoreHistory {
  account {
    id
    accountRiskScoreHistories(fullHistory: true) { id riskScore createdAt }
  }
}`;

interface AccountData {
  account: Record<string, unknown> | null;
}

interface AccountRiskHistoryData {
  account: { id: number; accountRiskScoreHistories: unknown[] | null } | null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function noAccountError(accountId: number): CallToolResult {
  return {
    content: [{ type: "text", text: `Error: account ${accountId} returned no data` }],
    isError: true,
  };
}

function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export async function handle(
  toolName: string,
  accountId: number,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_account_get": {
      logger.info("API call: account.get (partner)", { accountId });

      const data = await tenantQuery<AccountData>(accountId, ACCOUNT_QUERY);
      if (!data.account) return noAccountError(accountId);

      return jsonResult({ account: data.account, account_id: accountId });
    }

    case "knowbe4_account_risk_score_history": {
      const page = positiveInt(args.page, 1);
      const perPage = positiveInt(args.per_page, DEFAULT_PER_PAGE);

      logger.info("API call: account.riskScoreHistory (partner)", { accountId, page, perPage });

      const data = await tenantQuery<AccountRiskHistoryData>(accountId, ACCOUNT_RISK_HISTORY_QUERY);
      if (!data.account) return noAccountError(accountId);

      const all = data.account.accountRiskScoreHistories ?? [];
      const start = (page - 1) * perPage;
      const history = all.slice(start, start + perPage);

      logger.debug("API response: account.riskScoreHistory (partner)", {
        total: all.length,
        returned: history.length,
      });

      return jsonResult({
        risk_score_history: history,
        total: all.length,
        page,
        per_page: perPage,
        account_id: accountId,
      });
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown account tool: ${toolName}` }],
        isError: true,
      };
  }
}
