# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Interactive user card via MCP Apps (SEP-1865).** `knowbe4_users_get` results now render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the user's name, email, status, job title, department, manager, location, and group count, plus their current risk score and phish-prone percentage with a best-effort risk-score trend fetched from `/api/v1/users/{id}/risk_score_history`. The card is read-only — KnowBe4 is a reporting surface here, so there is no write round-trip. Non-App hosts are unaffected: the tool's JSON payload is unchanged apart from a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://knowbe4/user-card.html` resource served as `text/html;profile=mcp-app`. The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/user-card-html.ts`, committed), so plain `npm run build` and CI don't need vite. The server now declares the `resources` capability and answers `resources/list` / `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped `window.__BRAND__` script, so self-hosters can theme the card without rebuilding. No brand configured = HTML served unchanged.
  - The card payload builder is best-effort: a failed risk-history fetch degrades the card (or drops it) without affecting the tool result. New contract tests in `src/__tests__/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://` resource wire shape, the neutral-default/brand-injection behavior, and the card normalization.

### Fixed
- A `KNOWBE4_BASE_URL` containing a path prefix is no longer silently discarded. `apiRequest()` built its request URL with `new URL(path, creds.baseUrl)`, and the two-argument `URL` constructor performs RFC 3986 relative resolution rather than string concatenation. Every call site passes a path-absolute reference (`/api/v1/account`, `/api/v1/phishing/security_tests`, …), which by that rule replaces the base URL's own path entirely — so a base of `https://proxy.corp.example/knowbe4/` produced `https://proxy.corp.example/api/v1/account` and every request went to the wrong place. The bug was invisible by default because the built-in region defaults (`https://us.api.knowbe4.com` and friends) are bare origins with no path to lose; it only bit self-hosters who pointed `KNOWBE4_BASE_URL` at a reverse proxy or API gateway mounted under a path, exactly the use case the README documents as "Custom base URL (overrides region)". The URL is now assembled by explicit slash normalization and concatenation, so the base's path survives regardless of leading/trailing slashes on either side, redundant slashes collapse to one, and query params still append after the joined path. Regression tests in `src/__tests__/client.test.ts` pin the exact URL handed to `fetch` for bare-origin, prefixed-with-trailing-slash, prefixed-without-trailing-slash, doubled-slash, and query-param cases.
- HTTP transport now builds a fresh `Server` + `StreamableHTTPServerTransport` per `/mcp` request (stateless mode, `sessionIdGenerator: undefined`) instead of sharing one stateful transport for the whole process. The shared stateful transport (created with `sessionIdGenerator: () => randomUUID()`) only accepted one `initialize`, so behind the multi-user gateway only the first client since container start received tools — every subsequent client got `-32600 "Server already initialized"` and saw zero tools until a restart. Each request is now independent, so multiple clients work simultaneously. Handler registration was extracted into a `createFreshServer()` factory; stdio mode keeps its single shared server. Per-request server/transport are disposed on response close, and non-`POST` `/mcp` requests now return `405`.
- Hardened the per-request HTTP handler: the whole body is wrapped so any failure returns `500 {"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":null}` and is never rethrown, preventing a single bad request from escaping as an `unhandledRejection` that could crash the container.
- `/health` is now a shallow, unauthenticated liveness probe returning `200 {"status":"ok"}` — it no longer calls `getCredentials()`. In gateway mode (`AUTH_MODE=gateway`) credentials only arrive per-request via the `X-KnowBe4-API-Key` header, so the previous credential-gated `/health` always returned `503`, causing the Azure liveness probe to fail and SIGTERM-kill the container (crash loop). Added `/healthz` as an alias.

### Added
- Lazy-loading meta-tools mode (`LAZY_LOADING=true` env var) as an alternative to decision-tree navigation
  - `knowbe4_list_categories`: Discover available tool categories with descriptions and counts
  - `knowbe4_list_category_tools`: Load full tool schemas for a specific category on demand
  - `knowbe4_execute_tool`: Execute any domain tool by name without navigation
  - `knowbe4_router`: Intent-based tool suggestion from plain-language descriptions
- `src/utils/categories.ts`: Tool category definitions and intent routing logic

## [1.0.0] - 2026-03-10

### Added
- Initial release of KnowBe4 MCP Server
- Decision-tree navigation architecture with six domains:
  - `account`: Account info, subscription details, and account-level risk score history
  - `users`: User listing, details, and individual risk score history
  - `groups`: Group listing, details, member management, and group risk score history
  - `phishing`: Phishing campaigns, Phishing Security Tests (PSTs), and per-recipient results
  - `training`: Training campaigns, enrollments, store purchases (ModStore), and policies
  - `reporting`: Aggregated phishing summaries, training summaries, and risk overview with top-risk groups
- Multi-region support: US, EU, CA, UK, DE (via KNOWBE4_REGION env var)
- Bearer token authentication via KNOWBE4_API_KEY
- Dual transport support: stdio (Claude Desktop) and HTTP streaming (hosted deployment)
- Gateway auth mode: credentials injected via X-KnowBe4-API-Key header
- Health check endpoint at `/health`
- Elicitation support for interactive user filtering
- Structured stderr-only logging with configurable log level
- Comprehensive test suite with vitest
- Docker image with non-root user and health check
- Semantic release CI/CD pipeline
- MCPB manifest for Claude Desktop installation
