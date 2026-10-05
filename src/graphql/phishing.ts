/**
 * Phishing domain over the KnowBe4 tenant GraphQL API (partner mode)
 *
 * Mirrors src/domains/phishing.ts, but every call runs against one managed
 * account with a JIT token minted from the partner key. In GraphQL terms a
 * REST "phishing security test (PST)" is a PhishingCampaignRun and a PST
 * recipient is a PhishingCampaignRecipient.
 *
 * Selections are kept small on purpose: KnowBe4 enforces a 150-line
 * complexity cap per query.
 */

import type { CallToolResult } from "../utils/types.js";
import { tenantQuery } from "../utils/jit.js";
import { logger } from "../utils/logger.js";

/** KnowBe4 GraphQL enforces a minimum page size of 25. */
const MIN_PER_PAGE = 25;
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 100;

/** Values of `enum PhishingCampaignFilters`. */
const CAMPAIGN_FILTERS = new Set(["ACTIVE", "INACTIVE", "HIDDEN", "PHISHFLIP", "ALL"]);

const CAMPAIGN_FIELDS = `id name active campaignType frequencyPeriod isRecurring isPhishflip hideFromReports
      phishingCampaignRunCount lastRunDate nextRun createdAt updatedAt`;

const RUN_FIELDS = `id status startedAt completedAt duration groupNames phishDomain
      phishPronePercentage reportedPercentage recipientCount
      totalDelivered totalOpened totalClicked totalReplied totalDataEntered totalAttachmentOpen
      totalReported totalBounced
      campaign { id name }`;

const RECIPIENT_FIELDS = `id email scheduledAt delivered opened clicked clickedCount replied dataEntered
      attachmentOpen macroEnabled qrCodeScanned reported bounced ipAddress browser os
      user { id email displayName }`;

const PAGINATION_FIELDS = `pagination { page pages per totalCount }`;

export const PHISHING_CAMPAIGNS_QUERY = `query PhishingCampaigns($per: Int, $page: Int, $filter: PhishingCampaignFilters, $search: String) {
  phishingCampaigns(per: $per, page: $page, filter: $filter, search: $search) {
    nodes { ${CAMPAIGN_FIELDS} }
    ${PAGINATION_FIELDS}
  }
}`;

export const PHISHING_CAMPAIGN_QUERY = `query PhishingCampaign($id: Int!) {
  phishingCampaign(id: $id) { ${CAMPAIGN_FIELDS} }
}`;

/** Serves both "all runs" (campaignId omitted) and "runs for one campaign". */
export const PHISHING_CAMPAIGN_RUNS_QUERY = `query PhishingCampaignRuns($per: Int, $page: Int, $campaignId: Int) {
  phishingCampaignRuns(per: $per, page: $page, campaignId: $campaignId) {
    nodes { ${RUN_FIELDS} }
    ${PAGINATION_FIELDS}
  }
}`;

export const PHISHING_CAMPAIGN_RUN_QUERY = `query PhishingCampaignRun($id: Int!) {
  phishingCampaignRun(id: $id) { ${RUN_FIELDS} }
}`;

export const PHISHING_CAMPAIGN_RECIPIENTS_QUERY = `query PhishingCampaignRecipients($per: Int, $page: Int, $campaignRunId: Int!) {
  phishingCampaignRecipients(per: $per, page: $page, campaignRunId: $campaignRunId) {
    nodes { ${RECIPIENT_FIELDS} }
    ${PAGINATION_FIELDS}
  }
}`;

export const PHISHING_CAMPAIGN_RECIPIENT_QUERY = `query PhishingCampaignRecipient($campaignRunId: Int, $id: ID!) {
  phishingCampaignRecipient(campaignRunId: $campaignRunId, id: $id) { ${RECIPIENT_FIELDS} }
}`;

interface Cursor {
  nodes: unknown[];
  pagination: unknown;
}

function clampPerPage(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, n));
}

/** Map an optional status argument onto PhishingCampaignFilters; unknown values are dropped. */
function campaignFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.trim().toUpperCase();
  return CAMPAIGN_FILTERS.has(upper) ? upper : undefined;
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handle(
  toolName: string,
  accountId: number,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_phishing_campaigns_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const filter = campaignFilter(args.status);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : undefined;

      logger.info("API call: phishing.campaigns.list (partner)", { accountId, page, per, filter, search });

      const data = await tenantQuery<{ phishingCampaigns: Cursor }>(accountId, PHISHING_CAMPAIGNS_QUERY, {
        per,
        page,
        filter,
        search,
      });

      return ok({
        campaigns: data.phishingCampaigns.nodes,
        pagination: data.phishingCampaigns.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_phishing_campaigns_get": {
      const campaignId = args.campaign_id as number;
      if (!campaignId) return fail("Error: campaign_id is required");

      logger.info("API call: phishing.campaigns.get (partner)", { accountId, campaignId });

      const data = await tenantQuery<{ phishingCampaign: unknown | null }>(accountId, PHISHING_CAMPAIGN_QUERY, {
        id: campaignId,
      });

      if (!data.phishingCampaign) {
        return fail(`Error: campaign ${campaignId} not found in account ${accountId}`);
      }
      return ok({ campaign: data.phishingCampaign, account_id: accountId });
    }

    case "knowbe4_phishing_campaign_tests": {
      const campaignId = args.campaign_id as number;
      if (!campaignId) return fail("Error: campaign_id is required");

      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: phishing.campaignTests (partner)", { accountId, campaignId, page, per });

      const data = await tenantQuery<{ phishingCampaignRuns: Cursor }>(accountId, PHISHING_CAMPAIGN_RUNS_QUERY, {
        per,
        page,
        campaignId,
      });

      return ok({
        security_tests: data.phishingCampaignRuns.nodes,
        pagination: data.phishingCampaignRuns.pagination,
        campaign_id: campaignId,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_phishing_security_tests_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: phishing.securityTests.list (partner)", { accountId, page, per });

      const data = await tenantQuery<{ phishingCampaignRuns: Cursor }>(accountId, PHISHING_CAMPAIGN_RUNS_QUERY, {
        per,
        page,
        campaignId: undefined,
      });

      return ok({
        security_tests: data.phishingCampaignRuns.nodes,
        pagination: data.phishingCampaignRuns.pagination,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_phishing_security_test_get": {
      const pstId = args.pst_id as number;
      if (!pstId) return fail("Error: pst_id is required");

      logger.info("API call: phishing.securityTest.get (partner)", { accountId, pstId });

      const data = await tenantQuery<{ phishingCampaignRun: unknown | null }>(accountId, PHISHING_CAMPAIGN_RUN_QUERY, {
        id: pstId,
      });

      if (!data.phishingCampaignRun) {
        return fail(`Error: security test ${pstId} not found in account ${accountId}`);
      }
      return ok({ security_test: data.phishingCampaignRun, account_id: accountId });
    }

    case "knowbe4_phishing_security_test_recipients": {
      const pstId = args.pst_id as number;
      if (!pstId) return fail("Error: pst_id is required");

      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);

      logger.info("API call: phishing.securityTest.recipients (partner)", { accountId, pstId, page, per });

      const data = await tenantQuery<{ phishingCampaignRecipients: Cursor }>(
        accountId,
        PHISHING_CAMPAIGN_RECIPIENTS_QUERY,
        { per, page, campaignRunId: pstId }
      );

      return ok({
        recipients: data.phishingCampaignRecipients.nodes,
        pagination: data.phishingCampaignRecipients.pagination,
        pst_id: pstId,
        page,
        per_page: per,
        account_id: accountId,
      });
    }

    case "knowbe4_phishing_security_test_recipient": {
      const pstId = args.pst_id as number;
      const recipientId = args.recipient_id as number | string;
      if (!pstId || !recipientId) return fail("Error: pst_id and recipient_id are required");

      logger.info("API call: phishing.securityTest.recipient (partner)", { accountId, pstId, recipientId });

      // `phishingCampaignRecipient.id` is `ID!`, which GraphQL serializes as a string.
      const data = await tenantQuery<{ phishingCampaignRecipient: unknown | null }>(
        accountId,
        PHISHING_CAMPAIGN_RECIPIENT_QUERY,
        { campaignRunId: pstId, id: String(recipientId) }
      );

      if (!data.phishingCampaignRecipient) {
        return fail(`Error: recipient ${recipientId} not found in security test ${pstId} in account ${accountId}`);
      }
      return ok({ recipient: data.phishingCampaignRecipient, pst_id: pstId, account_id: accountId });
    }

    default:
      return fail(`Unknown phishing tool: ${toolName}`);
  }
}
