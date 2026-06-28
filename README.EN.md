# AgentBoster (WIP)

<p align="center">
  <img src="./app/icon.png" alt="agentboster" width="160" />
</p>

<p align="center">
  <a href="./README.md">中文: README</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/node.js-%E2%9C%93-339933?logo=node.js" />
  <img alt="Go" src="https://img.shields.io/badge/go-1.26-00ADD8?logo=go" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-yellow" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
</p>

> [!NOTE]
> Before 1.0, APIs and behavior may change.

AgentBoster is a two-part platform:

- **Web (Next.js 15)**: chat UI, IM integration, configuration, orchestration, and persisted workflows
- **agentd (Go)**: Linux daemon for sandboxed execution, security checks, and task scheduling

Web handles user experience and IM routing, while Daemon handles execution isolation and safety enforcement.

---

## Repository Structure

```
app/                    # Next.js App Router (pages and API)
  (auth)/              # authentication
  (chat)/              # chat and files
  (config)/            # configuration
  (memory)/            # memory and RAG
  (schedule)/          # schedules
  (skill)/             # skill management
  api/                 # web API
  .well-known/workflow/ # workflow callback route
components/             # React UI and shadcn components
hooks/                  # shared hooks
lib/                    # core business and infrastructure
types/                  # TypeScript types
scripts/                # utility scripts
agentd/                 # Go daemon source (Linux-only)
  cmd/agentd            # entrypoint
  internal/             # core modules (agent/sandbox/security/etc.)
```

---

## Core Capabilities

### Web
- Multi-session streaming chat with history search and slash commands
- Multi-channel Bot support (Telegram/Discord/Slack/Feishu/Teams) and unified notifications
- Skills, providers, tools, MCP, Soul, audit and monitoring config
- Workflow execution with L1/L2 security flow
- Builtin memory and RAG management

### Daemon
- File/terminal style tool execution with multi-step agent loop
- Sandboxes: `docker`, `docker-strict`, `lxc`
- Three-layer security: L0 rules, L1 scoring, L2 user approval
- Node registration, heartbeat, and resource reporting
- Event bus and worker pools

---

## Deployment

### 1) Web (Vercel)

1. Set `AUTH_SECRET`, `USERNAME`, `PASSWORD`, `BLOB_ACCESS`
2. Optional: `TAVILY_API_KEY` for web search
3. Deploy to Vercel

### 2) Daemon (Linux)

```bash
cd agentd
go build -o agentd ./cmd/agentd/
cp agentd.toml.example agentd.toml
cp agentd.toml /etc/agentd/agentd.toml   # example
sudo ./agentd -config /etc/agentd/agentd.toml
```

Linux and Docker/LXC runtime are required only as needed by your sandbox strategy.

> Communication direction:
> - **Daemon -> Web** uses HTTPS + API Key
> - **Web -> Daemon** uses mTLS when the daemon is externally reachable

For full daemon setup, see [`agentd/README.md`](./agentd/README.md).

---

## Web Environment Variables

- `AUTH_SECRET`, `USERNAME`, `PASSWORD`
- `DATABASE_URL` (required in production)
- `BLOB_ACCESS`
- `BLOB_READ_WRITE_TOKEN` (if using Vercel Blob)
- `TAVILY_API_KEY` (optional)
- `AGENTD_API_KEY` (must match daemon's `clawless_api_key`)
- `AGENTD_CLIENT_CERT_PATH` / `AGENTD_CLIENT_KEY_PATH` / `AGENTD_CA_PATH` (only if Web calls daemon directly)

---

## Common Commands

- `yarn dev`: run web dev server
- `yarn build`: build web app
- `yarn lint:check`: run `tsc --noEmit && biome check .`
- `yarn test`: run web tests
- `yarn db:generate`: generate DB migration
- `yarn db:push`: push schema migration
- `go test ./...`: run daemon tests (inside `agentd/`)
- `go build -o agentd ./cmd/agentd/`: build daemon

---

## IM Commands (selected)

`/start`, `/new`, `/session`, `/stop`, `/cancel`, `/retry`, `/model`, `/approve`, `/reject`, `/compact`, `/help`, `/memory`

---

## Contribution

Open issues or submit PRs. This project is MIT licensed.
