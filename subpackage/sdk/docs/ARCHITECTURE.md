# Architecture

This document explains the **product architecture** the SDK covers — not deep
code internals of any single tier.

## Mental model

AgentBoster is a multi-surface platform made of three independently
deployable parts (Web, agentd, CLI/Desktop). The SDK is the **single
curated surface** where the public contracts of all three meet, so that
external code only has to depend on one package regardless of which tier
it integrates with.

```text
                     @agentboster/sdk
                            |
        ┌───────────────────┼───────────────────┐
        |                   |                   |
   CLI runtime          Web API           Desktop host
   (extensions,         (HTTP + SSE,      (Tauri shell,
   skills, prompts,     Workflow DevKit,  RPC bridge, panes,
   themes, agent/tools) auth, sessions)   settings, tray)
        |                   |                   |
        v                   v                   v
   agentboster CLI     Next.js Web        Tauri Desktop
   (jiti-loaded)       (Vercel/self-host) (Lit renderer + Rust)
                            |
                            v
                       agentd daemon
                  (sandboxed tools, L0/L1/L2,
                   node register/heartbeat)
```

The SDK is consumed as TypeScript source. The CLI runtime compiles
extensions on load via jiti; the other surfaces are pure type re-exports
consumed at type-check time.

## Surfaces and maturity

The SDK is split into five surfaces. Each has a maturity level — **ready**
(re-exported today, additive within a major version) or **roadmap** (types
still being sourced; expect churn between minor versions).

| Surface | Covers | Maturity |
|---|---|---|
| **CLI runtime** | Extension/skill/prompt/theme authoring, tool and agent primitives, session lifecycle. Re-exported from `@agentboster-cli/core`. | Ready |
| **Web HTTP API** | Request/response shapes for `/api/cli/*`, `/api/agentd/v1/*`, the four auth patterns (cookie / CLI token / agentd-key / signed URL), chat and session-events SSE, subagent stream. | Roadmap |
| **Workflow DevKit** | Step definitions, event persistence, hook builders, run identity — lets external schedulers or tests construct and resume workflow runs against the Web runtime. | Roadmap |
| **Desktop IPC & bridge** | Tauri `invoke` contracts, RPC bridge messages (Desktop ↔ CLI `--mode rpc`), pane/workspace state, settings schema (`close_action`, `screenshot_format`, `screenshot_quality`). | Roadmap |
| **Agentd tool protocol** | Tool exec envelope `{ success, data, error }`, sandbox profiles (`docker` / `docker-strict` / `lxc`), L0/L1/L2 event schema, node register/heartbeat shapes. | Roadmap |

## Why one SDK, not five

Today the surfaces are split across five places:

- CLI runtime exports live in `cli/packages/coding-agent/src/`.
- Web HTTP contracts live implicitly in `app/api/**/route.ts` handlers.
- Workflow types live in `lib/workflow/**`.
- Desktop IPC lives in `src-tauri/src/lib.rs` and `src/rpc/bridge.ts`.
- Agentd protocol lives in Go structs under `subpackage/agentd/`.

Each of those is a tier-local source of truth and they are **allowed to
diverge at the implementation level**. The SDK does not try to merge the
implementations — it only mirrors the **public contract** of each tier
into one npm-installable package so that:

- Extension authors do not need to know whether a type comes from the CLI
  runtime or from the Web API.
- External integrators (a CI script calling the Web API, an agentd
  sidecar, a custom Desktop embedder) get the same types the runtime
  uses, without forking the runtime's source tree.
- Cross-tier flows (e.g. a Desktop extension that calls a Web endpoint
  and consumes a Workflow event stream) can be fully typed end-to-end.

## Layer responsibilities

### 1) CLI runtime

Owns:
- model execution inside a CLI process
- conversation/session primitives exposed to extensions
- tool execution pipeline and `local_*` tool routing
- package / extension / skill / prompt / theme loading via jiti
- TUI and `--print` non-interactive mode

Re-exports its public surface through the SDK today.

### 2) Web

Owns:
- authoritative session, message, workflow state (Postgres + pgvector)
- HTTP and SSE entrypoints under `app/api/**`
- durable Workflow DevKit orchestration
- L2 approval UX and node registry
- IM bot routing and notifications

SDK surface for Web is on the roadmap. When it lands, integrators will
get typed shapes for `/api/cli/*` and `/api/agentd/v1/*` requests and
responses, the four auth patterns, and the event schemas used by the
chat, session-events, and subagent streams.

### 3) Desktop host

Owns:
- windowing, panes, tabs, sidebar
- native integrations (filesystem, window focus, notifications bridge)
- workspace / project / session navigation
- resilient runtime orchestration across sessions (RPC bridge to CLI)
- rendering extension UI primitives (`notify`, `select`, `confirm`,
  `input`, `editor`, etc.)

Does **not** try to own all agent workflow policy.

SDK surface for Desktop is on the roadmap. When it lands, embedders and
extensions will get typed shapes for the Tauri `invoke` commands, the
RPC bridge messages, pane/workspace state, and the persisted settings
schema.

### 4) agentd daemon

Owns:
- sandboxed tool execution (`docker` / `docker-strict` / `lxc`)
- host-side L0 rules and L1 LLM scoring
- node registration and heartbeats to the Web
- local session runtime and worker pool
- `{ success, data, error }` envelope for every tool response

SDK surface for agentd is on the roadmap. When it lands, third-party
execution nodes and tool authors will be able to share the exact
protocol types the daemon uses.

## Practical direction for ongoing development

- Keep each tier's implementation as the source of truth for its own
  internals.
- When a public contract in one tier changes, regenerate the SDK's
  re-export for that surface (today: CLI; later: a per-surface regen
  script).
- Prefer adding new user-facing workflows through extensions first;
  promote a type into the SDK only when it is genuinely shared across
  tiers or consumed by external code.

For the extension-side host contract and capability list today, see
[`CAPABILITY_MODEL.md`](./CAPABILITY_MODEL.md). For step-by-step
extension authoring, see [`PACKAGE_CAPABILITY_TEMPLATE.md`](./PACKAGE_CAPABILITY_TEMPLATE.md).

## Security boundary

Each tier keeps its own security boundary:

- **CLI** extensions run inside the CLI process; the runtime injects
  types via virtual-module aliases, so extensions never need to ship
  the runtime themselves.
- **Web** endpoints enforce their own auth (cookie / CLI token /
  agentd-key / signed URL); SDK types do not grant access, they only
  describe the shapes.
- **Desktop** requires Tauri permissions declared in
  `src-tauri/capabilities/default.json`; the shell intentionally needs
  shell/fs access to operate as a local coding agent host.
- **agentd** enforces L0/L1/L2 security checks and sandbox isolation
  regardless of who is calling it.

Validate each tier's permission model against your environment policy
before deployment.
