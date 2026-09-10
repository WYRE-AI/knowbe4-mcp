/**
 * Partner domain handler
 *
 * Partner-level tools that use the partner API key directly (no JIT token):
 * - List the accounts (tenants) a partner manages, with risk metrics
 * - Get one managed account
 *
 * The account IDs returned here are what tenant tools accept as `account_id`.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler, CallToolResult } from "../utils/types.js";
import { partnerQuery } from "../utils/graphql.js";
import { logger } from "../utils/logger.js";

/** KnowBe4 enforces a minimum page size of 25 on partner `accounts`. */
const MIN_PER_PAGE = 25;
const MAX_PER_PAGE = 1000;
const DEFAULT_PER_PAGE = 100;

export const PARTNER_ACCOUNTS_QUERY = `query PartnerAccounts($per: Int, $page: Int, $search: String, $status: AccountStatuses) {
  accounts(per: $per, page: $page, search: $search, status: $status) {
    nodes {
      id companyName displayName domain archived
      riskScore phishPronePercentage percentageUsersTrained
      numberOfAllSeats subscriptionEndDate pstCount trainingCampaignCount
      hasApi hasApiv2
    }
    pagination { page pages per totalCount }
  }
}`;

export const PARTNER_ACCOUNT_QUERY = `query PartnerAccount($id: Int) {
  account(id: $id) {
    id companyName displayName domain archived
    riskScore latestRiskScore phishPronePercentage percentageUsersPhished percentageUsersTrained
    numberOfAllSeats numberOfStandardSeats allUserCount
    subscriptionEndDate pstCount trainingCampaignCount purchasedCourseCount
    hasApi hasApiv2 hasPhishing hasTraining
    city state country timeZone createdAt
    accountOwner { id email firstName lastName }
  }
}`;

function getTools(): Tool[] {
  return [
    {
      name: "knowbe4_partner_accounts_list",
      description:
        "Partner mode: list the KnowBe4 accounts (customer tenants) this partner manages, with each account's risk score, phish-prone percentage, percent trained, seats, and subscription end date. Use the returned account id as `account_id` on any other tool to query that tenant.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: {
            type: "string",
            description: "Filter accounts by company name, email, or domain",
          },
          status: {
            type: "string",
            enum: ["active", "archived", "all"],
            description: "Account status filter (default: active)",
          },
          page: {
            type: "number",
            description: "Page number for pagination (default: 1)",
          },
          per_page: {
            type: "number",
            description: `Number of results per page (default: ${DEFAULT_PER_PAGE}, min: ${MIN_PER_PAGE}, max: ${MAX_PER_PAGE})`,
          },
        },
      },
    },
    {
      name: "knowbe4_partner_account_get",
      description:
        "Partner mode: get one managed KnowBe4 account (customer tenant) by id, including risk metrics, seat counts, subscription end date, enabled features, and the account owner.",
      inputSchema: {
        type: "object" as const,
        properties: {
          account_id: {
            type: "number",
            description: "The managed account id (from knowbe4_partner_accounts_list)",
          },
        },
        required: ["account_id"],
      },
    },
  ];
}

function clampPerPage(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PER_PAGE;
  return Math.min(MAX_PER_PAGE, Math.max(MIN_PER_PAGE, n));
}

async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "knowbe4_partner_accounts_list": {
      const page = (args.page as number) || 1;
      const per = clampPerPage(args.per_page);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : undefined;
      const status = (typeof args.status === "string" ? args.status : "active").toUpperCase();

      logger.info("API call: partner.accounts.list", { page, per, search, status });

      const data = await partnerQuery<{
        accounts: { nodes: unknown[]; pagination: unknown };
      }>(PARTNER_ACCOUNTS_QUERY, { per, page, search, status });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { accounts: data.accounts.nodes, pagination: data.accounts.pagination, search, status },
              null,
              2
            ),
          },
        ],
      };
    }

    case "knowbe4_partner_account_get": {
      const accountId = args.account_id as number;
      if (!accountId) {
        return {
          content: [{ type: "text", text: "Error: account_id is required" }],
          isError: true,
        };
      }

      logger.info("API call: partner.account.get", { accountId });

      const data = await partnerQuery<{ account: unknown | null }>(PARTNER_ACCOUNT_QUERY, { id: accountId });

      if (!data.account) {
        return {
          content: [
            {
              type: "text",
              text: `Error: account ${accountId} was not found or is not managed by this partner`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ account_id: accountId, account: data.account }, null, 2),
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown partner tool: ${toolName}` }],
        isError: true,
      };
  }
}

export const partnerHandler: DomainHandler = {
  getTools,
  handleCall,
};
