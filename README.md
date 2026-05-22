# KnowBe4 MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server for KnowBe4 security awareness training. Enables AI assistants to manage phishing simulations, training campaigns, user risk scoring, and security awareness reporting.

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects Claude (or any MCP-compatible AI) to your KnowBe4 environment.

> **Part of the [MSP Claude Plugins](https://github.com/wyre-technology) ecosystem** — a growing suite of AI integrations for the MSP stack. Built by MSPs, for MSPs.

## Installation

```bash
npm install @wyre-technology/knowbe4-mcp
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `KNOWBE4_API_KEY` | Yes | Your KnowBe4 API key |
| `KNOWBE4_REGION` | No | API region: us, eu, ca, uk, de (default: us) |
| `KNOWBE4_BASE_URL` | No | Custom base URL (overrides region) |
| `MCP_TRANSPORT` | No | Transport mode: stdio (default) or http |

## Usage

### Running with Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "knowbe4-mcp": {
      "command": "npx",
      "args": ["@wyre-technology/knowbe4-mcp"],
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
  -- npx -y @wyre-technology/knowbe4-mcp
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


## Development

```bash
# Clone the repository
git clone https://github.com/wyre-technology/knowbe4-mcp.git
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
