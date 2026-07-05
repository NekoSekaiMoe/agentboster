# AGENTS.md

This file provides guidance to LLM when working with code in this repository.

## What this is

`agentd` is the Linux execution plane for AgentBoster — a Go daemon that runs sandboxed tool calls, enforces L0/L1/L2 security policy, registers with the Web service, and maintains local session state. It is a standalone Go module (Go 1.26.4), separate from the root Web app and CLI.

## Commands

```bash
# Build
go build -o agentd ./cmd/agentd/          # standard build
python3 build.py                           # build + strip binary

# Verify
go vet ./... && go build ./...             # static check + build
go test ./...                              # all tests

# Run single test / package
go test ./internal/config/...              # one package
go test ./internal/agent/... -run TestName # one test by name
go test -v ./internal/security/...         # verbose output

# Run
sudo ./agentd -config agentd.toml          # requires root for cgroups/namespaces
sudo ./agentd -gen-certs ./certs           # generate mTLS cert bundle
./agentd -tui                              # interactive terminal setup (no root needed)
```

From repo root: `yarn build:agentd` builds without entering the subdir.

## Non-obvious constraints

- **Linux only**: all source files have `//go:build linux`; macOS/Windows are not supported dev targets.
- **Root at startup**: required for cgroups/namespaces/sandbox setup, then drops to `[security].run_as_user`.
- **Config**: TOML via `agentd.toml` (template: `agentd.toml.example`); env overrides use `AGENTD_<SECTION>_<KEY>` (Viper).
- **Singleton lock**: three layers (`/var/run/agentd.sock`, PID file, TCP port probe) prevent duplicate daemons.
- **Version bumps**: change `version` in `cmd/agentd/main.go` when the on-disk cache format or HTTP contract changes.
- **HTTP envelope**: all API responses use `{ "success": bool, "data": any, "error": any }`.

## Transport directions

| Direction | Transport | When |
|-----------|-----------|------|
| Daemon → Web | HTTPS + API key | Always (heartbeat, L1, uploads, callbacks) |
| Web → Daemon | HTTPS + mTLS + API key | Only when daemon is network-reachable |

On Vercel-backed Web: leave `[clawless].client_cert_path`, `client_key_path`, `ca_path` **empty** — custom CA config replaces system trust and breaks public cert validation.

## Code map (high-signal entrypoints)

- `cmd/agentd/main.go` — entrypoint, flags, lifecycle, signal handling, privilege drop, `version` constant
- `cmd/agentd/tui/` — interactive terminal setup wizard (charmbracelet/huh)
- `internal/config/config.go` — Viper TOML loader, defaults, validation, config watching
- `internal/server/routes.go` + `middleware.go` — Gin HTTP surface, API key + mTLS enforcement
- `internal/agent/` — CodeAct loop, tool registry, context compaction, sub-agent runner
- `internal/agent/browser/` — in-sandbox Playwright bridge (`bridge.js` over unix socket)
- `internal/lsp/` — LSP (Language Server Protocol) client, manager, and auto-detection for code intelligence
- `internal/security/gatekeeper.go` — L0 → L1 → L2 orchestration + output audit
- `internal/security/l0_rules/` — regex deny presets (command, path, network, output)
- `internal/security/l2_auth/` — user confirmation flow (IM/UI → `/l2-confirm`)
- `internal/sandbox/` — Docker/LXC execution backends + health/egress
- `internal/clawless/` — Web API REST client + L1 scorer client
- `internal/worker/` — dynamic goroutine pool, event dispatcher, per-event handlers

Full per-file annotations: `LAYOUT.MD`. Runtime flow and config shape: `README.md`.

## LSP integration

The `internal/lsp/` package provides automatic Language Server Protocol support for agents working in sandboxes:

- **Auto-detection**: Scans project files (Cargo.toml, go.mod, package.json, etc.) to detect project type
- **Auto-installation**: If the LSP server is missing, automatically installs it in the sandbox (rust-analyzer, gopls, clangd, pyright, typescript-language-server)
- **Container-isolated execution**: LSP servers run **inside the LXC container**, not on the host, ensuring full isolation
- **Process management**: Starts LSP servers on-demand, keeps them alive during the session, and closes idle servers after 10 minutes
- **Tools exposed to agents**:
  - `lsp_definition` — find symbol definition (go-to-definition)
  - `lsp_hover` — get type information and documentation
  - `lsp_references` — find all references to a symbol
  - `lsp_symbols` — list all symbols in a file (functions, classes, variables)

Supported languages: Rust, Go, C/C++, Python, TypeScript, JavaScript.

The LSP client uses JSON-RPC 2.0 over stdio, bridged through `lxc-attach` to communicate with language servers running inside the container. This ensures that LSP servers have the same view of the filesystem and environment as the agent's other tools.

## Key dependencies

- **gin** (HTTP framework), **viper** (config), **charmbracelet/huh + lipgloss** (TUI)
- **dbushelper** (sibling Go module at `../dbushelper`) — AT-SPI2 D-Bus client consumed via the `a11y-helper` CLI binary in `tools_a11y.go`

## dbushelper integration

The `a11y-helper` binary emits one JSON object on stdout (parsed verbatim by agentd); diagnostics go to stderr only. Refs are written to `/tmp/agentd-a11y-refs.json` (override via `AGENTD_A11Y_REFS`). Tiered refs: `eN` = interactive (click/type/fill target), `xN` = group (inspect-only).
