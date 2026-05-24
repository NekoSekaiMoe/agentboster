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
>
> Until version 1.0 is released, I suggest you treat this as a preview. We cannot guarantee backwards compatibility at this stage.
>
> 在版本号没有达到 1.0 之前，我建议你可以把本项目当作一个尝鲜，我们不保证向前的兼容性。

![AgentBoster](.docs/public/images/preview.png)

AgentBoster is a **Serverless AI Agent platform** consisting of two parts:

- **AgentBoster Web** — A Next.js-based frontend Dashboard deployed on Vercel, providing a chat UI, configuration management, and Bot adapters
- **Agent Daemon** — A Go-based Linux daemon running on the user's Linux server, providing sandbox execution, security review, and task scheduling. The Daemon does not interact with IM or send notifications; all IM notifications are handled by AgentBoster Web

AgentBoster covers the core features you need from an AI Agent: Chat, Skills, Memory (with RAG), Multi-Channel Bot, Sandbox execution, Workflow — and it's **Serverless**.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Vercel (Serverless)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Next.js Web  │  │  API Routes  │  │  Workflow (Cron)  │  │
│  │  Dashboard    │  │  /api/*      │  │  DevKit           │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────┘  │
│         │                  │                                  │
│         │    mTLS + API Key │                                  │
│         ▼                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              AgentBoster API Gateway                        ││
│  └──────────────────────────┬───────────────────────────────┘│
└─────────────────────────────┼─────────────────────────────────┘
                              │ mTLS
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   User's Linux Server                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Agent Daemon (Go)                      │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │ │
│  │  │ LLM Loop │ │ Sandbox  │ │ Security │ │ Session   │  │ │
│  │  │ Agent    │ │ Manager  │ │ L0/L1/L2 │ │ Manager   │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │ │
│  │                                                         │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              Sandbox Providers                     │  │ │
│  │  │  tmpfs  │  chroot  │  Docker                      │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  │                                                         │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              IM Channels                           │  │ │
│  │  │  Telegram  │  Discord  │  Slack  │  Feishu        │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Features

### AgentBoster Web (Next.js)
- **Chat** — Multi-session chat with streaming responses, message history, session search/pin
- **Skills** — Skill management with dynamic loading
- **Memory** — RAG vector search memory
- **Config** — Provider, Channel, and Agent configuration
- **Sandbox** — Sandbox management and monitoring
- **Multi-Channel Bot** — Slack, Teams, Google Chat, and Telegram adapters

### Agent Daemon (Go)
- **LLM Agent Loop** — Tool calling, multi-step reasoning, Sub-agents
- **20+ MVP Tools** — File read/write, Shell execution, Git, Web search/scrape, Sub-agents, and more
- **Three-Layer Security** — L0 rule filtering → L1 AI scoring → L2 user authorization
- **Unified Decision Queue** — L2 security authorization + LLM questions + conflict resolution + task branching, with serial/concurrent hybrid scheduling
- **Three Sandboxes** — tmpfs (AI-dynamic sizing), chroot (persistent), Docker (strong isolation)
- **Webhook Callbacks** — Notifies AgentBoster Web via HTTP callbacks when tasks complete or user decisions are needed; the Web side handles IM notifications
- **Session Management** — Session persistence, LRU eviction, archiving, and abort control

---

## Tech Stack

### AgentBoster Web
| Category | Technology |
|----------|------------|
| Framework | Next.js 15.5.9 (App Router, RSC) |
| UI | React 19, Tailwind CSS 3, shadcn/ui, Framer Motion |
| AI | Vercel AI SDK 6 (Anthropic, Google, OpenAI) |
| Chat | Chat SDK (Slack, Teams, GChat, Telegram) |
| Database | Drizzle ORM + Neon Postgres |
| Cache | Upstash Redis |
| Storage | Vercel Blob |
| Workflow | Vercel Workflow DevKit |
| Sandbox | Vercel Sandbox |
| Tools | Biome (lint/format), Node.js (runtime) |

### Agent Daemon
| Category | Technology |
|----------|------------|
| Language | Go 1.26.2 (Linux-only) |
| HTTP | Gin |
| Config | Viper (TOML) |
| Events | Custom Event Bus |
| Communication | mTLS + API Key |

---

## Deploy

### AgentBoster Web → Vercel

You don't need to download the project locally or own a VPS. You only need:

- A Vercel account (the free tier is sufficient)
- An API key compatible with OpenAI/Anthropic/Gemini
- Click the deploy button below

<p align="center">
	<a href=https://vercel.com/new/clone?repository-url=https://github.com/Niapya/agentboster&stores=[{"type":"blob"},{"type":"integration","productSlug":"upstash-kv","integrationSlug":"upstash"},{"type":"integration","protocol":"storage","productSlug":"neon","integrationSlug":"neon"}]&env=AUTH_SECRET,USERNAME,PASSWORD&envDescription=Do_not_disclose_them_and_keep_them_safe.&project-name=agentboster&repository-name=agentboster&redirect-url=https://niapya.github.io/agentboster target="_blank">
		<img src="https://vercel.com/button" alt="Deploy with Vercel" width="120" />
	</a>
</p>

### Agent Daemon → Linux Server

On your Linux server:

```bash
# Clone the repository
git clone https://github.com/Niapya/agentboster.git
cd agentboster/agentd

# Build (requires Go 1.26+)
go build -o agentd ./cmd/agentd/

# Generate default config on first run
./agentd -config agentd.toml

# Edit the configuration
vim agentd.toml

# Start
./agentd
```

---

## Quick Start

### 1. Configure Environment Variables

Deployment requires three environment variables: `AUTH_SECRET`, `USERNAME`, and `PASSWORD`. **Do not expose them.**

### 2. Log In and Configure

Open the deployment link → Log in → Go to "Config" → Add a Provider (OpenAI Compatible) → Set `Default Model` and `Embedding Model`.

### 3. Configure Agent Daemon

In `agentd.toml`:

```toml
[server]
listen = ":18732"
agentboster_api_key = "your-api-key"

[agentboster]
base_url = "https://your-agentboster.vercel.app"
client_cert_path = "/path/to/client.crt"
client_key_path = "/path/to/client.key"
ca_path = "/path/to/ca.crt"

[sandbox]
default = "tmpfs"
chroot_base = "/var/lib/agentd/chroots"
docker_socket = "unix:///var/run/docker.sock"
allowed_images = ["ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "golang:1.22", "node:20", "python:3.12"]
```

### 4. Connect IM

Go to Channel configuration → Set up IM Bot Token → Configure Webhook → Set up whitelist.

### 5. Start Chatting

Chat with the Agent via Web Chat or IM.

---

## Sandbox

| Type | Isolation Level | Persistence | Sizing Strategy | Use Case |
|------|----------------|-------------|-----------------|----------|
| **tmpfs** | Low (in-memory directory) | Optional | AI-dynamic evaluation + Daemon memory probing | Lightweight temporary tasks |
| **chroot** | Medium (filesystem isolation) | Always persistent | Multiple rootfs sources (URL/local/preset) | Development tasks requiring persistent filesystem |
| **Docker** | High (full container isolation) | Optional | Image whitelist + resource limits | High-risk commands, tasks requiring strong isolation |

tmpfs size is evaluated by AI (light tasks 15-50MB, medium tasks 50-200MB, heavy tasks 200-500MB). The Daemon probes available space in three tiers: zram → physical memory → swap, then determines the final allocation. Auto-scaling occurs when space runs low during execution (upper limit = min(current × 3, available memory × 60%)).

chroot rootfs supports 6 sources (by priority): user-specified path → user-specified URL → presets → local preset → default URL download → copy host binaries. Downloaded rootfs files are automatically cached, with background cleanup of expired files (default 30 days).

---

## Security

- **L0** — Predefined rules that directly reject dangerous commands (`rm -rf /`, `chmod 777`, etc.)
- **L1** — LLM scoring that assesses command risk levels (low/medium/high)
- **L2** — High-risk commands require user confirmation via Web UI or IM buttons (pass_once/pass_until/reject_once/reject_until)
- **Decision Queue** — Unified decision queue for L2 authorization + LLM questions + conflict resolution + task branching
- **Prompt Injection Defense** — Built-in injection defense rules in System Prompt
- **Docker Whitelist** — Only whitelisted images are allowed
- **mTLS** — Bidirectional TLS authentication between AgentBoster Web ↔ Agent Daemon. The Daemon does not store any IM tokens and is unaware of the user's IM platform

---

## Development

```bash
cd your-agentboster

yarn install
yarn vercel pull   # Pull environment variables
yarn dev           # Start the development server
```

If you encounter database schema errors, run `yarn postbuild` to apply database migrations.

Agent Daemon development:

```bash
cd agentd
go build -o agentd ./cmd/agentd/
./agentd -config agentd.toml
```

---

## Others

I'm currently looking for work — feel free to contact me if you're interested.

If you have ideas or find issues, please open a Pull Request or create an Issue. Contributions are welcome in any form.

The frontend UI is based on [ClawLess](https://github.com/Niapya/clawless). Thanks to the ClawLess project for providing the Dashboard foundation and inspiration.

Thanks to OpenClaw and Manus for inspiration, to Vercel as the deployment platform, to all the open source projects used here — and to **you**.

This project is licensed under the MIT License.