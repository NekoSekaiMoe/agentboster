# AGENTS.md — agentd/

Compact guide for OpenCode sessions working in `agentd/`. This is a separate Go module from the repo-root Web app and `cli/` workspace.

## Read first

- `agentd/README.md` is the best map for runtime flow, config shape, and transport direction.
- The daemon is the Linux execution plane: sandboxed tool execution, L0/L1/L2 enforcement, node registration, and heartbeats.
- Web owns durable state and orchestration; `agentd` should not grow Web-side responsibilities.

## Commands

- `go build -o agentd ./cmd/agentd/` builds the daemon.
- `go test ./...` is the standard verification pass.
- `go vet ./... && go build ./...` is the broader static/build check.
- `sudo ./agentd -config agentd.toml` runs locally; startup requires root.
- `sudo ./agentd -gen-certs ./certs` generates the mTLS cert bundle.
- From repo root, `yarn build:agentd` builds `agentd` without entering the subdir.

## Non-obvious constraints

- Linux only: the module targets `//go:build linux`; do not treat macOS/Windows as supported dev targets.
- Root is required at startup for cgroups/namespaces, then the process drops to `[security].run_as_user`.
- Config is TOML via `agentd.toml`; `agentd.toml.example` is the template and env overrides use the `AGENTD_` prefix.
- Node identity is persisted via `clawless.node_id_file`; reusing that file preserves the daemon identity across restarts.
- The daemon uses a three-layer singleton lock under `/var/run` plus a port probe; duplicate launches are expected to fail early.

## Transport gotchas

- Daemon → Web always uses HTTPS + API key for register/heartbeat/callback traffic.
- Web → Daemon is the only direction that uses mTLS, and only when the daemon is network reachable.
- On Vercel-backed Web deployments, do not set `[clawless].client_cert_path`, `client_key_path`, or `ca_path` for outbound daemon traffic; custom CA config breaks normal public cert validation.

## Code map

- `cmd/agentd/main.go` is the entrypoint for flags, lifecycle, and privilege drop.
- `internal/config/config.go` owns TOML loading, defaults, validation, and config watching.
- `internal/server/routes.go` and `internal/server/middleware.go` own HTTP surface, API key, and mTLS enforcement.
- `internal/agent/` owns the agent loop and tool registry.
- `internal/security/` owns L0/L1/L2 policy, privilege handling, and OS enforcement.
- `internal/sandbox/` owns Docker/LXC execution backends and related health/egress logic.

## Useful pointers

- Rootless Docker is the preferred local setup; rootful Docker requires explicit config opt-in.
- All HTTP responses use the `{ success, data, error }` envelope.
- If you change on-disk cache format or HTTP contract, bump the daemon version in `cmd/agentd/main.go`.
