/**
 * Reporting tools, partner mode.
 *
 * Re-implements the reporting tools from src/domains/reporting.ts over
 * KnowBe4's tenant GraphQL API, authenticated with a JIT token for one
 * managed account. These tools compute summaries from other data, so each
 * handler runs one or two small queries and aggregates in-process. Tool
 * names, argument names, and output keys match the REST handler so the two
 * can be swapped by mode.
 *
 * Selections are kept small: KnowBe4 caps query complexity at 150 lines.
 */

import type { CallToolResult } from "../utils/types.js";
import { tenantQuery } from "../utils/jit.js";
import { logger } from "../utils/logger.js";

/** KnowBe4 GraphQL enforces a minimum page size of 25 on paginated cursors. */
const MIN_PER_PAGE = 25;
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 500;

/** `enum TrainingCampaignStatuses` values that mean the campaign is finished. */
const COMPLETED_TRAINING_STATUSES = new Set(["CLOSED", "COMPLETED"]);

const RECENT_HISTORY_LIMIT = 10;
const TOP_GROUPS_LIMIT = 5;
const GROUPS_PAGE_SIZE = 500;

export const PHISHING_RUNS_QUERY = `query TenantPhishingRunsSummary($per: Int, $page: Int) {
  phishingCampaignRuns(per: $per, page: $page) {
    nodes {
      id totalDelivered totalOpened totalClicked totalReported phishPronePercentage
    }
    pagination { page pages per totalCount }
  }
}`;

export const TRAINING_CAMPAIGNS_QUERY = `query TenantTrainingCampaignsSummary($per: Int, $page: Int) {
  trainingCampaigns(per: $per, page: $page) {
    nodes { id name status }
    pagination { page pages per totalCount }
  }
}`;

export const ACCOUNT_RISK_QUERY = `query TenantAccountRisk {
  account {
    companyName displayName riskScore latestRiskScore
    numberOfStandardSeats allUserCount phishPronePercentage partnerSubscriptionType
    accountRiskScoreHistories(fullHistory: false) { id riskScore createdAt }
  }
}`;

export const GROUP_RISK_QUERY = `query TenantGroupRisk($per: Int, $page: Int) {
  groups(per: $per, page: $page) {
    nodes { id name riskScore memberCount }
    pagination { page pages per totalCount }
  }
}`;

interface Cursor<T> {
  nodes: T[];
  pagination: unknown;
}

interface PhishingRunNode {
  id?: number;
  totalDelivered?: number | string | null;
  totalOpened?: number | string | null;
  totalClicked?: number | string | null;
  totalReported?: number | string | null;
  phishPronePercentage?: number | string | null;
}

interface TrainingCampaignNode {
  id?: number;
  name?: string;
  status?: string | null;
}

interface RiskHistoryNode {
  id?: number;
  riskScore?: number | string | null;
  createdAt?: string | null;
}

interface AccountNode {
  companyName?: string | null;
  displayName?: string | null;
  riskScore?: number | string | null;
  latestRiskScore?: number | string | null;
  numberOfStandardSeats?: number | null;
  allUserCount?: number | null;
  phishPronePercentage?: number | string | null;
  partnerSubscriptionType?: string | null;
  accountRiskScoreHistories?: RiskHistoryNode[] | null;
}

interface GroupNode {
  id?: number;
  name?: string;
  riskScore?: number | string | null;
  memberCount?: number | null;
}

function clampPerPage(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, n));
}

/** KnowBe4 sometimes returns numerics (especially percentages) as strings. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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
    case "knowbe4_reporting_phishing_summary": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: reporting.phishingSummary (partner)", { accountId, page, per });

      const data = await tenantQuery<{ phishingCampaignRuns: Cursor<PhishingRunNode> }>(
        accountId,
        PHISHING_RUNS_QUERY,
        { per, page }
      );
      const runs = data.phishingCampaignRuns.nodes;

      let totalDelivered = 0;
      let totalOpened = 0;
      let totalClicked = 0;
      let totalReported = 0;
      let phishProneSum = 0;
      let phishProneCount = 0;

      for (const run of runs) {
        totalDelivered += toNumber(run.totalDelivered) ?? 0;
        totalOpened += toNumber(run.totalOpened) ?? 0;
        totalClicked += toNumber(run.totalClicked) ?? 0;
        totalReported += toNumber(run.totalReported) ?? 0;
        const ppp = toNumber(run.phishPronePercentage);
        if (ppp !== null) {
          phishProneSum += ppp;
          phishProneCount++;
        }
      }

      logger.debug("API response: reporting.phishingSummary (partner)", { accountId, count: runs.length });

      return jsonResult({
        total_security_tests: runs.length,
        total_emails_delivered: totalDelivered,
        total_opened: totalOpened,
        total_clicked: totalClicked,
        total_reported: totalReported,
        average_phish_prone_percentage: phishProneCount > 0 ? round2(phishProneSum / phishProneCount) : null,
        click_rate: totalDelivered > 0 ? round2((totalClicked / totalDelivered) * 100) : null,
        report_rate: totalDelivered > 0 ? round2((totalReported / totalDelivered) * 100) : null,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_reporting_training_summary": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: reporting.trainingSummary (partner)", { accountId, page, per });

      const data = await tenantQuery<{ trainingCampaigns: Cursor<TrainingCampaignNode> }>(
        accountId,
        TRAINING_CAMPAIGNS_QUERY,
        { per, page }
      );
      const campaigns = data.trainingCampaigns.nodes;

      let completedCampaigns = 0;
      for (const campaign of campaigns) {
        if (COMPLETED_TRAINING_STATUSES.has(String(campaign.status ?? "").toUpperCase())) {
          completedCampaigns++;
        }
      }

      logger.debug("API response: reporting.trainingSummary (partner)", { accountId, count: campaigns.length });

      return jsonResult({
        total_campaigns: campaigns.length,
        active_campaigns: campaigns.length - completedCampaigns,
        completed_campaigns: completedCampaigns,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_reporting_risk_overview": {
      logger.info("API call: reporting.riskOverview (partner)", { accountId });

      const [accountData, groupsData] = await Promise.all([
        tenantQuery<{ account: AccountNode | null }>(accountId, ACCOUNT_RISK_QUERY),
        tenantQuery<{ groups: Cursor<GroupNode> }>(accountId, GROUP_RISK_QUERY, { per: GROUPS_PAGE_SIZE, page: 1 }),
      ]);

      const account = accountData.account ?? {};

      // Most recent entries first, capped like the REST endpoint's first page of 10.
      const recentRiskHistory = [...(account.accountRiskScoreHistories ?? [])]
        .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""))
        .slice(0, RECENT_HISTORY_LIMIT)
        .map((entry) => ({ risk_score: toNumber(entry.riskScore), date: entry.createdAt ?? null }));

      const highestRiskGroups = groupsData.groups.nodes
        .map((group) => ({
          id: group.id,
          name: group.name,
          risk_score: toNumber(group.riskScore),
          member_count: group.memberCount ?? null,
        }))
        .filter((group): group is typeof group & { risk_score: number } => group.risk_score !== null && group.risk_score > 0)
        .sort((a, b) => b.risk_score - a.risk_score)
        .slice(0, TOP_GROUPS_LIMIT);

      logger.debug("API response: reporting.riskOverview (partner)", {
        accountId,
        historyCount: recentRiskHistory.length,
        groupCount: groupsData.groups.nodes.length,
      });

      return jsonResult({
        account_name: account.companyName ?? account.displayName ?? null,
        current_risk_score: toNumber(account.riskScore) ?? toNumber(account.latestRiskScore),
        number_of_seats: account.numberOfStandardSeats ?? null,
        subscription_level: account.partnerSubscriptionType ?? null,
        recent_risk_history: recentRiskHistory,
        highest_risk_groups: highestRiskGroups,
        account_id: accountId,
      });
    }

    default:
      return errorResult(`Unknown reporting tool: ${toolName}`);
  }
}
