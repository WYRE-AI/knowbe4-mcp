# Partner mode: one partner key for every managed tenant

**Date:** 2026-09-09
**Status:** approved (user: "let's get this built")

## Problem

MSPs hold one KnowBe4 tenant per customer. The server authenticates with a
single tenant Reporting API key, so serving N customers means N keys and N
server instances (or N gateway connectors). KnowBe4's answer is the
partner-level GraphQL API: one partner Product API key lists every managed
account and mints a 15-minute Just-In-Time (JIT) token per tenant.

## Verified facts (introspection + docs, 2026-09-09)

- Partner and tenant GraphQL share a regional base URL:
  `https://training.knowbe4.com/graphql` (US), `eu.`, `ca.`, `uk.`, `de.knowbe4.com/graphql`.
  Auth is `Authorization: Bearer <Product API key>`.
- Partner query `accounts(per, page, cursor, status, search, ...)` returns
  managed accounts with `id`, `companyName`, `domain`, `riskScore`,
  `phishPronePercentage`, `percentageUsersTrained`, `numberOfAllSeats`,
  `subscriptionEndDate`, `pstCount`, `trainingCampaignCount`, `hasApi`.
  `per` minimum is 25.
- Partner mutation `apiTokensGenerateJit(accountId: Int!)` returns
  `{ node: String (JWT), errors: [Error] }`. Token valid 15 minutes, documented
  for the tenant GraphQL API ("account-level queries and mutations").
- Tenant GraphQL API: 98 queries, 172 mutations. Every existing REST tool has
  a direct query equivalent.
- Limits: 150-line complexity per query, 4 req/s, 10 req per licensed user/day.
  Partner API needs Diamond; tenant GraphQL needs Diamond or SAT Advanced.
- Not verified (no partner key available): whether a JIT JWT works against the
  legacy REST Reporting API. Design assumes it does not.

## Design

Additive. The existing single-tenant REST path is untouched.

### Credentials

| Mode | Tenant (existing) | Partner (new) |
|------|-------------------|---------------|
| env | `KNOWBE4_API_KEY` | `KNOWBE4_PARTNER_API_KEY` |
| gateway | `X-KnowBe4-API-Key` | `X-KnowBe4-Partner-API-Key` |

`KNOWBE4_REGION` / `X-KnowBe4-Region` select both the REST base and the
GraphQL base. `KNOWBE4_GRAPHQL_URL` overrides the GraphQL base (mirrors
`KNOWBE4_BASE_URL`). Gateway mode accepts either key; at least one is required.

`KnowBe4Credentials` gains optional `partnerApiKey` and `graphqlUrl` so the
per-request `AsyncLocalStorage` store carries both. `getPartnerCredentials()`
in `src/utils/graphql.ts` reads the store first, then env.

### Components

- `src/utils/graphql.ts`: `graphqlRequest(url, token, query, variables)`.
  POST JSON, Bearer auth, throws on HTTP error or non-empty `errors`.
- `src/utils/jit.ts`: `getJitToken(accountId)` with an in-memory cache keyed by
  `sha256(partnerKey)[:16] + ":" + accountId`, TTL 14 minutes, in-flight
  de-duplication. `tenantQuery(accountId, query, variables)` mints (or reuses)
  the JIT token and runs the query. JWTs are never logged.
- `src/domains/partner.ts`: new `partner` domain with
  `knowbe4_partner_accounts_list(search?, status?, page?, per_page?)` and
  `knowbe4_partner_account_get(account_id)`. Uses the partner key directly.
- `src/graphql/{account,users,groups,phishing,training,reporting}.ts`:
  tenant tools re-implemented over GraphQL. Each exports
  `handle(toolName, accountId, args): Promise<CallToolResult>` and reuses the
  existing tool names and argument names.
- `src/graphql/index.ts`: `isPartnerScoped(args)`, `withAccountIdArg(tools)`
  (adds an optional `account_id` property to every tenant tool schema), and
  `callViaPartner(name, args)` which routes by tool-name prefix.
- `src/index.ts`: tools list = augmented tenant tools + partner tools. Dispatch:
  if `account_id` is present, route to `callViaPartner`; otherwise existing REST
  routing. Same hook in the lazy-mode `knowbe4_execute_tool`. Status tool
  reports both credentials. Gateway header parsing accepts the partner header.

### Data flow (partner-scoped call)

1. Claude calls `knowbe4_partner_accounts_list(search: "acme")` → account id.
2. Claude calls `knowbe4_users_list(account_id: 123, status: "active")`.
3. Dispatcher sees `account_id` → `callViaPartner` → `src/graphql/users.ts`.
4. `tenantQuery(123, USERS_QUERY, vars)` → cache miss → `apiTokensGenerateJit`
   with the partner key → JWT cached → `users(...)` query with the JWT.
5. Raw GraphQL `data` is returned as JSON, plus `account_id`.

### Error handling

- `account_id` without partner credentials → tool error naming the env var and
  header. No REST fallback (it would silently query the wrong tenant).
- JIT mutation `errors` non-empty or `node` null → tool error with reasons.
- GraphQL `errors` → tool error listing messages; HTTP 401/403/429 mapped like
  the REST client.
- Partner tools without partner credentials → tool error.

### Out of scope

- The MCP Apps user card in partner mode (REST field shapes only).
- Elicitation prompts in partner mode.
- Write mutations. Cross-tenant fan-out helpers beyond `accounts` metrics.
- Migrating the REST path to GraphQL (candidate for 2.0).

### Testing

Vitest, mocked `fetch` / mocked `tenantQuery`. Pins: GraphQL request shape,
JIT cache TTL/keying/de-dup/no-log, partner tools' query documents and
variable mapping, per-domain query documents and variable mapping, dispatcher
routing, tool list augmentation, gateway header handling. No live tests
(no partner key on hand).
