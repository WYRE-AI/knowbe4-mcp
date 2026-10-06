# KnowBe4 MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for KnowBe4 security awareness training. Enables AI assistants to manage phishing simulations, training campaigns, user risk scoring, and security awareness reporting.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects Claude (or any MCP-compatible AI) to your KnowBe4 environment.

> **Part of the [MSP Claude Plugins](https://github.com/WYRE-AI) ecosystem** — a growing suite of AI integrations for the MSP stack. Built by MSPs, for MSPs.

## Installation

```bash
npm install @wyre-ai/knowbe4-mcp
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `KNOWBE4_API_KEY` | One of the three keys | Your KnowBe4 Reporting API key for a single tenant |
| `KNOWBE4_PARTNER_API_KEY` | One of the three keys | Your KnowBe4 partner Product API key (see [Partner mode](#partner-mode-one-key-for-every-managed-tenant)) |
| `KNOWBE4_PRODUCT_API_KEY` | One of the three keys | Your own tenant's Product API key, to opt into GraphQL instead of REST without partner mode (see [Opt-in tenant GraphQL](#opt-in-tenant-graphql)) |
| `KNOWBE4_REGION` | No | API region: us, eu, ca, uk, de (default: us). Selects both the REST and GraphQL endpoints |
| `KNOWBE4_BASE_URL` | No | Custom REST base URL (overrides region) |
| `KNOWBE4_GRAPHQL_URL` | No | Custom GraphQL endpoint (overrides region) |
| `MCP_TRANSPORT` | No | Transport mode: stdio (default) or http |

## Partner mode (one key for every managed tenant)

MSPs and multi-account admins normally need one Reporting API key per customer
tenant. Partner mode replaces that with a single partner Product API key from
the KnowBe4 partner (management) console:

1. Set `KNOWBE4_PARTNER_API_KEY` (or send the `X-KnowBe4-Partner-API-Key`
   header in gateway mode). `KNOWBE4_API_KEY` becomes optional.
2. Call `knowbe4_partner_accounts_list` to see every managed account with its
   risk score, phish-prone percentage, percent trained, seats, and
   subscription end date. Filter with `search` by company name or domain.
3. Pass the account's `id` as `account_id` to any tenant tool, for example
   `knowbe4_users_list` with `account_id: 12345`. The server mints a
   just-in-time (JIT) token for that tenant through the partner API, caches it
   for 14 minutes, and runs the query against KnowBe4's tenant GraphQL API.

Without `account_id`, tenant tools keep using the REST Reporting API and
`KNOWBE4_API_KEY` exactly as before. `account_id` never falls back to the
single-tenant key: if partner mode is not configured the tool returns an error
instead of silently answering from the wrong tenant.

Notes:

- The partner API requires a Diamond-level partner subscription; the tenant
  GraphQL API requires Diamond or SAT Advanced on the managed account.
- KnowBe4 limits GraphQL to 4 requests/second and 10 requests per licensed
  user per day, with a 150-line complexity cap per query.
- Partner-mode results use KnowBe4's GraphQL field names (camelCase), so
  they differ in shape from the REST results of the same tool. The
  interactive user card and the user-list filter prompt work in both modes.

## Opt-in tenant GraphQL

A single tenant can serve every tenant tool over GraphQL instead of the REST
Reporting API, without partner mode and without `account_id`:

1. Set `KNOWBE4_PRODUCT_API_KEY` (or send the `X-KnowBe4-Product-API-Key`
   header in gateway mode) to your own tenant's Product API key, from
   Account Settings > API in your KnowBe4 console. This is a different key
   from the Reporting API key `KNOWBE4_API_KEY` uses.
2. That's it -- every tenant tool (`account`, `users`, `groups`, `phishing`,
   `training`, `reporting`) now runs over GraphQL with that key directly. No
   JIT token is minted; the key is already scoped to your tenant.

This is non-breaking and opt-in: `KNOWBE4_API_KEY`/REST stays the default,
and nothing changes unless `KNOWBE4_PRODUCT_API_KEY` is explicitly set. The
tenant GraphQL API requires a Diamond or SAT Advanced subscription -- on a
lower tier, keep using `KNOWBE4_API_KEY`/REST. Results use GraphQL field
names (camelCase), same as partner mode, so they differ in shape from REST.
`account_id` still takes priority if both it and this key are configured
(use `knowbe4_partner_accounts_list` with a partner key for multi-tenant;
this mode is for a single tenant serving itself).

## Usage

### Running with Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowbe4-mcp": {
      "command": "npx",
      "args": ["@wyre-ai/knowbe4-mcp"],
      "env": {
        "KNOWBE4_API_KEY": "your-knowbe4-api-key"
      }
    }
  }
}
```

### Running with Claude Code (CLI)

```bash
claude mcp add knowbe4-mcp \
  -e KNOWBE4_API_KEY=your-value \
  -- npx -y @wyre-ai/knowbe4-mcp
```

### Docker

```bash
docker build -t knowbe4-mcp .
docker run \
  -e KNOWBE4_API_KEY=your-value \
  -p 8080:8080 knowbe4-mcp
```

## Available Domains

### Account
Account information and settings

### Groups
User group management

### Phishing
Phishing simulation campaigns

### Reporting
Security awareness reports

### Training
Training campaign management

### Users
User management and risk scoring

### Partner
Managed accounts (customer tenants) and fleet-wide risk metrics. Requires
`KNOWBE4_PARTNER_API_KEY`; see [Partner mode](#partner-mode-one-key-for-every-managed-tenant).

## Interactive User Card (MCP Apps)

`knowbe4_users_get` renders as an interactive card in MCP Apps hosts
(Claude Desktop/web) showing the user's risk score, phish-prone percentage,
risk-score trend, and profile details; plain-JSON behavior is unchanged in
other hosts, and the card is read-only (no write round-trip). The card is
neutral by default and brandable via `window.__BRAND__` injection or
`MCP_BRAND_*` env vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`,
`MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`,
`MCP_BRAND_TEXT`) — no rebuild needed.

## Development

```bash
# Clone the repository
git clone https://github.com/WYRE-AI/knowbe4-mcp.git
cd knowbe4-mcp

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) if present, or open an issue to discuss changes.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
