# AGENTS.md — agentd (Go daemon)

Compact guide for OpenCode sessions working in the `agentd/` Go module. This is a separate codebase from the repo-root Web app — read the root `AGENTS.md` for Web-side tasks.

## Commands

```bash
go build -o agentd ./cmd/agentd/         # build binary (use build.py to also strip)
go test ./...                            # run all tests
go vet ./... && go build ./...           # static checks + build validation
sudo ./agentd -config agentd.toml        # run (must be root, Linux only)
sudo ./agentd -gen-certs ./certs         # generate mTLS cert bundle and exit
```

From repo root: `yarn build:agentd` runs `cd agentd && go build -o agentd ./cmd/agentd/main.go`.

## Non-obvious constraints

- **Linux only** — `//go:build linux` build tag. Cross-compiling to macOS/Windows is not supported.
- **Root at startup** — needed for cgroups/namespaces. Drops privileges to `[security].run_as_user` after setup (`internal/security/privilege.go`). Non-root launch is refused at `os.Getuid() != 0`.
- **Config** — TOML (`agentd.toml.example` is the template). Env override prefix `AGENTD_`, e.g. `AGENTD_SERVER_LISTEN=:28732`.
- **Version** — constant at `cmd/agentd/main.go` line ~100. Bump when HTTP contract or on-disk cache format changes.

## mTLS direction gotcha

**Daemon → Web** (heartbeat, L1 scores, tool callbacks) always uses **plain HTTPS + `X-API-Key`** when the Web is on Vercel. Never set `[clawless].client_cert_path` / `client_key_path` / `ca_path` on Vercel deployments — doing so replaces the system root store and kills validation of Vercel's Let's Encrypt cert (see `README.md` troubleshooting table).

mTLS only applies to **Web → Daemon** direction (inbound tool execution), and only when the daemon is network-exposed (public IP or frp tunnel). Otherwise the daemon is heartbeat-only and `[server].tls_*_path` / `ca_path` stay empty (plain HTTP on localhost/firewall).

## Project layout

Detailed package map in `LAYOUT.MD`. Key entrypoints:

| Path | Role |
|------|------|
| `cmd/agentd/main.go` | Entry point, CLI flags (`-config`, `-gen-certs`), lifecycle, signal handling |
| `internal/config/config.go` | Viper-backed TOML loader, defaults, validation |
| `internal/server/routes.go` | Gin HTTP routes, middleware (mTLS, API key, CORS) |
| `internal/agent/loop.go` | Core think → act → observe agent loop |
| `internal/agent/tools_register.go` | Tool registry (18+ tools), one file per tool family |
| `internal/security/gatekeeper.go` | L0 → L1 → L2 orchestration pipeline |
| `internal/worker/pool.go` | Dynamic goroutine pools (Asika-style auto-scaling) |
| `internal/eventbus/bus.go` | In-process pub/sub for async event-driven dispatch |
| `internal/sandbox/` | Docker (light/strict) and LXC sandbox providers |
| `internal/certs/certs.go` | Self-signed ECDSA P-384 cert generation |
| `internal/lifecycle/singleton.go` | Three-layer singleton lock (socket + PID + port probe) |

## Key conventions

- **Logging** — structured slog: `<timestamp> [<module>] [<func:line>] <level> <message> <key=val>...`. Module name from `[logging].module` config.
- **JSON responses** — all HTTP routes return `{ "success": bool, "data": ..., "error": ... }`.
- **Hot-reload** — wired in `internal/config/config.go` via Viper `WatchConfig`, but **disabled** in default `main.go`. Enable by calling `config.Watch(viper, onChange)` from a custom entry point.
- **Unsandboxed local dev** — add `--danger-skip-sandbox` flag to `main.go` (check for existence, not a current feature).
- **Node identity** — persisted at `clawless.node_id_file` (default `/var/run/agentd.node_id`). Reusing the file preserves identity across restarts.
- **Singleton lock** — three layers: unix socket (`/var/run/agentd.sock`), PID file (`/var/run/agentd.pid`), TCP port probe on `server.listen`. Survives `kill -9` / OOM / power loss via PID liveness probe on startup.

## Testing

Standard Go test (`go test ./...`). No special test runner, framework, or fixtures. No integration test prerequisites beyond Docker/LXC being available (tests skip if missing).
