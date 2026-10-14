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

Copy [`.env.example`](.env.example). Stdio and `AUTH_MODE=env` read the KnowBe4 variables. Gateway mode does not.

| Variable | Required | Description |
|----------|----------|-------------|
| `KNOWBE4_API_KEY` | For stdio and `AUTH_MODE=env` | KnowBe4 API key |
| `KNOWBE4_REGION` | No | API region: `us` (default), `eu`, `ca`, `uk`, or `de` |
| `KNOWBE4_BASE_URL` | No | Custom base URL (overrides region) |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `env` (default outside the image) or `gateway`. The container image and Compose default to `gateway`. Gateway mode requires `X-KnowBe4-API-Key` on each `/mcp` request (`X-KnowBe4-Region` is optional) and never falls back to `KNOWBE4_*`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` refuses startup. A known placeholder secret is still refused. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, which is what the container image sets, so container deploys stay on every interface inside the container. Without a secret the dev bypass binds `127.0.0.1` instead. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256 of the exact string `t=<unix seconds>` keyed by `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never written to logs.

```js
import { createHmac } from "node:crypto";

const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.CONDUIT_S2S_SECRET)
  .update(`t=${t}`)
  .digest("hex");
const xGatewayS2s = `t=${t},v1=${v1}`;
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-KnowBe4-API-Key` (`X-KnowBe4-Region` is optional). That header is the only credential source for the request. A request missing it returns 401 and does not read `KNOWBE4_API_KEY` from the environment.

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

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, the KnowBe4 API key arrives on each request as `X-KnowBe4-API-Key`; it is not read from the environment.

```bash
docker build -t knowbe4-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  knowbe4-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not set `KNOWBE4_API_KEY` or `env_file`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `KNOWBE4_API_KEY`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e KNOWBE4_API_KEY=your-value \
  -e KNOWBE4_REGION=us \
  -p 127.0.0.1:8080:8080 \
  knowbe4-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` makes startup exit:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
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
