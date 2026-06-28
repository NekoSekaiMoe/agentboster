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
> Before 1.0, APIs and behavior may change. Upgrade compatibility is not guaranteed.

AgentBoster is a multi-surface AI platform made of **three independently deployable parts**:

- **Web (Next.js 15)**: browser UI, sessions and config, IM integration, durable Workflow orchestration, L2 approvals, and node registry (Postgres)
- **agentd (Go)**: Linux daemon for sandboxed tools, L0/L1/L2 security, local session runtime, and multi-node heartbeats
- **CLI (`agentboster`)**: terminal coding agent; direct provider APIs or the same Web streaming backend via `login` + `AGENTBOSTER_URL`

Web owns UX and orchestration, the daemon owns execution isolation and safety, and the CLI owns local developer terminals. They cooperate over HTTPS APIs and can be upgraded on different schedules.

---

## Platform architecture

```mermaid
flowchart TB
  subgraph tier1["① Web — Next.js 15 / Vercel"]
    direction TB
    UI["App Router UI"]
    API["app/api/*"]
    WF["Workflow DevKit"]
    DB[("Postgres + pgvector")]
    UI --> API --> WF --> DB
  end

  subgraph tier2["② agentd — Linux daemon (multi-node)"]
    direction TB
    AD["agentd"]
    SB["Sandboxes docker / lxc"]
    AD --> SB
  end

  subgraph tier3["③ CLI — agentboster terminal"]
    CLI["coding-agent + adapter"]
  end

  subgraph clients["User entry"]
    Browser["Browser"]
    IM["IM bots"]
  end

  Browser --> UI
  IM --> API
  CLI -->|"login + AGENTBOSTER_URL\nstreaming API"| API

  AD -->|"always HTTPS + API Key"| API
  API -->|"optional mTLS tools"| AD
```

### Responsibility split

| Layer | Owns | Does not own |
|-------|------|----------------|
| **Web** | Sessions, IM routing, config UI, workflow state, L2 UX, node table | Long-lived shell in your VPC (unless delegated to agentd) |
| **agentd** | Sandbox exec/file/browser tools, host L0/L1, local cache and metrics | Primary DB persistence (syncs via Web APIs) |
| **CLI** | TUI / print mode, local provider keys, `agentboster login` remote stream | Server-side IM or authoritative workflow state |

### Communication directions (required reading)

```mermaid
sequenceDiagram
  participant D as agentd
  participant W as Web

  Note over D,W: Always: Daemon → Web
  D->>W: POST /api/agentd/v1/nodes/register
  D->>W: POST /api/agentd/v1/nodes/heartbeat
  D->>W: L1 / review / tool callbacks
  Note right of D: HTTPS + API Key only<br/>No outbound mTLS client cert to Vercel

  Note over D,W: Optional: Web → Daemon
  W->>D: POST /api/v1/tools/exec
  Note right of W: mTLS when daemon has public URL or frp
```

- **Daemon → Web**: always `HTTPS` + `AGENTD_API_KEY` (same as `clawless_api_key`). On Vercel, **do not** set `[clawless].ca_path` or other custom CA on this path — TLS validation will fail.
- **Web → Daemon**: only when the node URL is reachable; Web uses `AGENTD_CLIENT_*` env vars for mTLS client certificates.

### Typical path: Web chat

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Chat UI
  participant API as Web API
  participant WF as Workflow
  participant D as agentd

  U->>UI: Send message
  UI->>API: Stream request
  API->>WF: Start / resume
  loop Tool loop
    WF->>D: Tools (selected node)
    D-->>WF: Result
  end
  WF-->>UI: Token stream
```

### Typical path: CLI remote mode

```mermaid
sequenceDiagram
  participant U as Developer
  participant CLI as agentboster CLI
  participant API as Web API
  participant WF as Workflow
  participant D as agentd

  U->>CLI: TUI / --print prompt
  CLI->>API: Adapter stream
  API->>WF: Same orchestration as Web
  loop Tool loop
    WF->>D: Sandbox tools when needed
    D-->>WF: Result
  end
  WF-->>CLI: Token stream
  CLI-->>U: Terminal output
```

Browser, IM, and CLI all converge on **Web API + Workflow**; **agentd** is used when orchestration dispatches sandbox tools. See [`cli/README.md`](./cli/README.md).

---

## Repository layout

```
app/                    # Next.js App Router (pages + API)
  (auth)/              # Login
  (chat)/              # Chat, files
  (config)/            # System config
  (memory)/            # Memory & RAG
  (schedule)/          # Schedules / tasks
  (skill)/             # Skills
  api/                 # Web API (agentd callbacks, IM webhooks)
  .well-known/workflow/ # Workflow callbacks (auth bypass)
components/             # React + shadcn
hooks/
lib/                    # Core logic (workflow, chat, db, …)
types/
scripts/
agentd/                 # Go daemon (Linux only)
  cmd/agentd
  internal/
cli/                    # agentboster CLI monorepo
  packages/coding-agent       # Command entry
  packages/agentboster-adapter # Web adapter
```

---

## Core capabilities (summary)

### Web

- Multi-session streaming chat, search, slash commands
- Multi-channel bots (Telegram/Discord/Slack/Feishu/Teams) and unified notifications
- Skills, providers, tools, MCP, Soul, audit and monitoring
- Durable workflows with L1/L2 security
- RAG / builtin memory; multi-node scheduling (`MULTI-NODE-SCHEDULING.md`)

### Daemon

- Multi-step agent and CodeAct-style tool loop
- Sandboxes: `docker`, `docker-strict`, `lxc`
- L0 rules → L1 scoring → L2 user approval
- Node registration, heartbeats, resource metrics
- Event bus and dynamic worker pools

### CLI

- Interactive TUI and `--print` non-interactive mode
- `agentboster login` → `~/.agentboster/config.json`
- `AGENTBOSTER_URL` and related env for Web; or local provider API keys only
- Release: `npm run bundle` / `npm run package` under `cli/`

---

## Quick deployment

### 1) Web (Vercel)

1. Set `AUTH_SECRET`, `USERNAME`, `PASSWORD`, `BLOB_ACCESS`
2. Set `DATABASE_URL` in production (Neon, etc.)
3. Set `AGENTD_API_KEY` when using agentd
4. Optional `TAVILY_API_KEY` for web search
5. Deploy to Vercel

### 2) Daemon (Linux)

```bash
cd agentd
go build -o agentd ./cmd/agentd/
cp agentd.toml.example agentd.toml
# Edit base_url, clawless_api_key, sandbox
sudo ./agentd -config agentd.toml
```

Full guide: [`agentd/README.md`](./agentd/README.md).

### 3) CLI (local)

```bash
cd cli
npm install
npm run build
node packages/coding-agent/dist/cli.js --help
agentboster login   # when using Web backend
```

Full guide: [`cli/README.md`](./cli/README.md).

---

## Environment variables (Web)

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET`, `USERNAME`, `PASSWORD` | Login and cookies |
| `DATABASE_URL` | Required in production |
| `BLOB_ACCESS` / `BLOB_READ_WRITE_TOKEN` | Attachments |
| `AGENTD_API_KEY` | Must match daemon `clawless_api_key` |
| `AGENTD_CLIENT_CERT_PATH`, etc. | Only when Web calls daemon directly |
| `TAVILY_API_KEY` | Optional |

CLI: `AGENTBOSTER_URL`, `AGENTBOSTER_SESSION_ID`, `AGENTBOSTER_CLIENT_ID` (see cli README).

---

## Common commands

| Scope | Commands |
|-------|----------|
| Web | `yarn dev`, `yarn build`, `yarn lint:check`, `yarn test`, `yarn db:push` |
| agentd | `go test ./...`, `go build -o agentd ./cmd/agentd/` (from `agentd/`) |
| CLI | `npm run build`, `npm run check` (from `cli/`) |

---

## IM commands (selected)

`/start`, `/new`, `/session`, `/stop`, `/cancel`, `/retry`, `/model`, `/approve`, `/reject`, `/compact`, `/help`, `/memory`

---

## Related documentation

| Document | Content |
|----------|---------|
| [`README.md`](./README.md) | Chinese README (same scope) |
| [`agentd/README.md`](./agentd/README.md) | Daemon |
| [`cli/README.md`](./cli/README.md) | Terminal CLI |
| [`AGENTS.md`](./AGENTS.md) | Contributors and OpenCode notes |

---

## Contributing

Open issues or submit PRs. MIT licensed.