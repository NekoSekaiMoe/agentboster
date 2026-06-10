# Agent Daemon (`agentd`)

The Linux-side half of [AgentBoster](https://github.com/NekoSekaiMoe/agentboster). Runs sandboxed
LLM agents on a user-controlled server, talks back to the [AgentBoster Web](../README.md) (Next.js
on Vercel) over mTLS.

```
+-----------------+        mTLS + API key        +-----------------+
|  AgentBoster    | <--------------------------> |     agentd      |
|   Web (Vercel)  |   callbacks, L2 auth,        |  (this repo,    |
|  Next.js 15     |   tool proxy, telemetry      |   Go 1.26)      |
+-----------------+                              +-----------------+
                                                          |
                                                  +-------+-------+
                                                  | sandbox       |
                                                  |  - docker     |
                                                  |  - docker-    |
                                                  |    strict     |
                                                  |  - lxc        |
                                                  +---------------+
```

**Hard requirements**

- Linux (build tags enforce this — `//go:build linux`)
- Root at startup — needed to create cgroups, mount namespaces, drop to `run_as_user` afterwards
- Go 1.26.2 to build, Docker or LXC at runtime depending on the sandbox types you enable

The daemon is stateless from a database perspective. All persistent state (sessions, tasks,
review logs, memories, agent configs) lives in the AgentBoster Web Postgres. Agentd caches a
small amount of state locally (background task recovery, session blob, L2 auth cache) and
syncs with the Web API.

---

## Version

`0.1.0` — set in `cmd/agentd/main.go`. Bump it as part of any release that changes the HTTP
contract or the on-disk cache format.

---

## Build

```bash
cd agentd
go build -o agentd ./cmd/agentd/
```

Produces a single static-ish binary at `./agentd`. Cross-compiling is **not** supported —
build tags restrict the target to `GOOS=linux`.

Run with `go run` for development:

```bash
sudo go run ./cmd/agentd/ -config agentd.toml
```

Verify daemon changes with `go test ./...`. Use `go vet ./...` and `go build ./...` when
you need broader static checks or build validation.

---

## CLI

```
agentd -config <path>     # path to agentd.toml (defaults: ./agentd.toml, /etc/agentd/agentd.toml)
agentd -gen-certs <dir>   # generate self-signed mTLS bundle (CA + server + client) and exit
agentd -cert-dir <dir>    # where -gen-certs writes files (default: ./certs)
```

The binary refuses to start unless both `runtime.GOOS == "linux"` and `os.Getuid() == 0`.
The root check happens **before** privilege drop — `run_as_user` from config is applied via
`security.DropPrivileges` shortly after the gatekeeper and sandbox manager are constructed,
so internal setup can do privileged work (mounting, cgroup creation) but the long-running
event loop runs unprivileged.

On `SIGINT` / `SIGTERM` the daemon:

1. Stops the dispatcher (drains worker pools).
2. Shuts down the HTTP server with a 10s grace period.
3. Stops the metrics collector, L0 rule loader, and L2 cleanup ticker.

---

## Configuration

Copy `agentd.toml.example` to `agentd.toml` and edit. Sections (all are mapstructure-tagged
struct fields in [`internal/config/config.go`](internal/config/config.go)):

| Section | Purpose |
|---|---|
| `[server]` | Listen address, mTLS cert paths, API key the Web side uses to authenticate |
| `[clawless]` | Web base URL, client mTLS cert for Daemon → Web calls, heartbeat interval, node ID file |
| `[security]` | L1 LLM scorer endpoint, `run_as_user`, risk-score thresholds (`l1_threshold`) |
| `[security.l1_threshold]` | `low` / `medium` / `high` / `critical` cutoffs the gatekeeper uses to map L1 scores to decisions |
| `[sandbox]` | Default provider, Docker socket/image, LXC distro, allowed images, OS enforcement flags |
| `[sandbox.lxc]` | Init commands run on first LXC container creation |
| `[cache]` | Local cache dir, max session size, sync interval, retry attempts |
| `[session]` | Max active sessions, idle timeout, store path |
| `[worker]` | Static pool sizes (`0` = auto from CPU count) — fallback if `[worker_pool]` is empty |
| `[worker_pool]` | Dynamic pool sizing — `min_workers`, `max_workers` (`0` = CPU×4), `scale_up_pct`, `scale_down_pct`, `cooldown_secs`, `stats_interval` |
| `[task_summary]` | Auto tidy interval, max decisions kept |
| `[logging]` | `level` (debug/info/warn/error), `module` tag, `add_source` for `[func:line]` |

Environment variable override: any key can be overridden with `AGENTD_<SECTION>_<KEY>` (Viper
`SetEnvPrefix("AGENTD") + AutomaticEnv`). Example: `AGENTD_SERVER_LISTEN=:28732`.

Hot-reload is wired but optional — call `config.Watch(viper, onChange)` from a custom entry
point if you want it. The default `main.go` does **not** enable it, to keep the lifecycle
visible in logs.

---

## mTLS

The Web ↔ Daemon channel is mutually authenticated. The Daemon **generates** the bundle
on first run; copy the client cert to the Web side and the server cert to whoever fronts
the Daemon (typically the Web app on Vercel reaches it directly through a tunnel, not a
public listener — see deployment notes below).

```bash
sudo ./agentd -gen-certs ./certs
# → writes:
#   ca-cert.pem / ca-key.pem        CA
#   server-cert.pem / server-key.pem  Server
#   client-cert.pem / client-key.pem  Client (Web → Daemon)
```

Certs are ECDSA P-384, 1-year validity (10y for the CA), loopback SANs
(`127.0.0.1`, `::1`, `localhost`, `agentd-server`). For non-loopback deployment, edit
`internal/certs/certs.go` to add the right `IPAddresses` / `DNSNames` and regenerate.

If `tls_cert_path` / `tls_key_path` are empty, the daemon falls back to plain HTTP and logs
a warning. **Do not** do this in production.

---

## HTTP API

All routes return JSON of the form `{ "success": bool, "data": ..., "error": ... }`.

### Unauthenticated

| Method | Path | Returns |
|---|---|---|
| `GET` | `/health` | `{ status, timestamp, version, uptime }` |
| `GET` | `/metrics` | Aggregated worker pool metrics (see below) |

### `/api/v1/*` — mTLS + API key (`X-API-Key` or Basic auth) required

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/tasks` | Create a task — publishes `EventTaskCreated` |
| `GET` `/PUT` | `/api/v1/tasks/:id` | Read / update task |
| `GET` `/PUT` `/DELETE` | `/api/v1/sessions/:id` | Session CRUD |
| `GET` | `/api/v1/sessions` | List recent sessions |
| `POST` | `/api/v1/sessions/switch` | Switch active session |
| `POST` | `/api/v1/sessions/close` | Close a session |
| `DELETE` | `/api/v1/sessions/:id` | Destroy session |
| `GET` | `/api/v1/sessions/status` | Status of one or all sessions |
| `POST` | `/api/v1/sessions/:id/abort` | Abort a running session |
| `POST` | `/api/v1/l2-confirm` | Web → Daemon callback for L2 user decisions (`pass_once` / `pass_until` / `reject_once` / `reject_until`) |
| `POST` `/GET` `/DELETE` | `/api/v1/memories[/:id]` | Memory read/write/delete |
| `POST` | `/api/v1/review-logs` | Persist security review logs to Web |
| `GET` | `/api/v1/agent-config/:id` | Fetch agent config from Web |
| `GET` | `/api/v1/l0-rules/:id` | Fetch L0 rules for an agent |
| `POST` `/PUT` | `/api/v1/sandboxes[/:id]` | Register / update sandbox metadata |
| `POST` | `/api/v1/llm-proxy` | Proxy an LLM call (supports SSE streaming) |
| `POST` | `/api/v1/tools/{exec,read,write,edit,ls,grep,glob,patch,git,web-fetch,web-search,memory-search,memory-save,sandbox-install}` | Synchronous single-tool execution (used by Web when Agentd is the primary runner) |

`/metrics` returns:

```json
{
  "task":    { "workers": 4, "total_tasks": 120, "active_tasks": 1, "utilization_pct": 25, "scale_ups": 0, "scale_downs": 1, "goroutines": 87 },
  "review":  { ... },
  "sandbox": { ... },
  "memory":  { ... },
  "cleanup": { ... }
}
```

---

## Three-tier Security

The `security.Gatekeeper` ([`internal/security/gatekeeper.go`](internal/security/gatekeeper.go))
runs every command the agent issues through three layers:

```
            command
               │
        ┌──────▼──────┐
        │  L0 rules   │  regex matchers (cmd/path/network). 21 built-in presets.
        │  (block)    │  Hard block on hit → publish EventSecurityAlert, abort.
        └──────┬──────┘
               │ pass
        ┌──────▼──────┐
        │  L1 scorer  │  LLM-based risk score 0.0–1.0. Thresholds map to:
        │  (score)    │   low → allow
        │             │   medium → allow + notify user
        │             │   high / critical → require L2 authorization
        └──────┬──────┘
               │ high/critical
        ┌──────▼──────┐
        │  L2 auth    │  Web shows user a "Allow / Reject" prompt.
        │  (user)     │  Decision cached as pass/reject with duration
        │             │  (once | until-time | always).
        └─────────────┘
```

L0 presets (full list in [`internal/security/l0_rules/presets.go`](internal/security/l0_rules/presets.go)):

- **Command**: `rm -rf /`, `mkfs.*`, `dd if=.* of=/dev/`, `fdisk`, `wipefs`, `curl|bash`,
  `wget|sh`, `sudo `, `su -`, `chmod 777`, `chown root`, `iptables -F`, `shutdown`,
  `reboot`, `killall`, `pkill`, `nc -l`, `ncat -l`, `python -m http.server`
- **Path**: `/etc/shadow`, `/etc/passwd`, `/etc/ssh/`, `/proc/`, `/sys/`, `~/.ssh/`
- **Network**: `nmap`, `masscan`, `hydra`

L0 **output** rules scan the LLM's response for prompt-leak / credential-leak patterns
(system prompt headers, API keys, private keys, internal paths) — see
`DefaultOutputRules()`.

L1 calls a remote/local scorer (default: local Ollama with `tinyllama:latest`, configurable
in `[security]`). On error, the gatekeeper fails open at "medium" risk and logs.

L2 is event-driven — `EventL2AuthRequired` is published to the bus, the Web side renders
the prompt, the user clicks, the Web calls back via `POST /api/v1/l2-confirm`, the bus
publishes `EventL2AuthApproved` / `EventL2AuthRejected`, and the dispatcher resumes or
cancels the task.

---

## Sandbox Providers

| Provider | Implementation | Isolation | Persistent | Default resources | Use case |
|---|---|---|---|---|---|
| `docker` | `sandbox/docker_light.go` | OS policy + seccomp + cap drop | No (`--rm`) | 0.25 CPU / 256 MB | Daily tasks, code execution |
| `docker-strict` | `sandbox/docker.go` | `--network none`, `--read-only`, cap drop ALL, image whitelist | No | 1.0 CPU / 512 MB | Untrusted / high-risk code |
| `lxc` | `sandbox/lxc_persistent.go` | cgroup + OS policy | Yes | 1.0 CPU / 512 MB | Long-running, stateful tasks |

`SelectSandbox(task, agentCfg)` chooses automatically when the task leaves `SandboxType` empty:

1. Task has explicit `sandbox_type` and it's not `"auto"` → use it
2. Command matches high-risk patterns (`rm -rf`, `mkfs`, `sudo`, …) → `docker-strict`
3. Command matches persistence patterns (`git clone`, `go build`, `npm install`, …) → `lxc`
4. Agent default config → use that
5. Fallback → `docker`

`os_enforce` is generated automatically from L0 rules when enabled — see
`internal/security/os_enforce/policy.go` and the `cap_drop` / `masked_paths` it computes
from the L0 pattern set.

`CheckDockerAvailable` and `CheckLXCAvailable` are called at startup; missing runtimes are
warned but **do not abort** — the daemon will simply refuse to create that sandbox type.

---

## Agent Loop

[`internal/agent/loop.go`](internal/agent/loop.go) implements the think → act → observe cycle:

1. Build system prompt (Soul + context + tool definitions)
2. Call LLM via the Web LLM proxy (`/api/v1/llm-proxy`)
3. **Output audit** — every LLM response is fed through `Gatekeeper.AuditOutput` before
   it reaches the conversation log
4. If a tool call is present, execute it through the `ToolRegistry`
5. Append tool result to message history
6. Repeat until the LLM returns a final answer or `maxSteps` is hit
7. At 50 messages, `compactContext` summarizes older turns via a side-call to the LLM and
   keeps the last 10 — key decisions, file paths, and retry patterns are explicitly preserved
   in the summary

The LLM is called **through the Web proxy**, not directly. The Daemon never holds provider
API keys — they live in the Web's database.

### Tool registry

Tools are registered in [`internal/agent/tools_register.go`](internal/agent/tools_register.go)
and exposed to the LLM as OpenAI-compatible function-calling definitions:

- `file` (`tools_file.go`) — read, write, edit, list, grep, glob, patch
- `exec` (`tools_exec.go`) — sandboxed shell execution, gated through the Gatekeeper
- `git` (`tools_git.go`) — clone, add, commit, push, diff, log
- `web` (`tools_web.go`, `tools_web_rendered.go`) — fetch URL, web search, plus Chromium-rendered fetch/search for JavaScript-heavy pages
- `memory` (`tools_memory.go`) — search, save
- `skills` (`tools_skills.go`) — load a named skill
- `subagent` (`tools_subagent.go`) — spawn a sub-agent with its own session
- `codeact` (`tools_codeact.go`) — structured "think then act" reasoning
- `media` (`tools_media.go`) — image/audio understanding
- `deliver` (`tools_deliver.go`) — collect files for delivery back to the user
- `task_summary` (`tools_task_summary.go`) — generate a structured summary
- `misc` (`tools_misc.go`) — utilities (timestamp, env, etc.)

The same tools are reachable synchronously from the Web side via
`POST /api/v1/tools/{name}` — see [`internal/server/routes.go`](internal/server/routes.go).

`web_fetch_rendered` and `web_search_rendered` run headless Chromium inside the current
sandbox and return text/HTML JSON only. They do not require multimodal message transport.
If Chromium is missing, the tool searches the sandbox package manager (`apk`, `apt`,
`dnf`, `yum`, `pacman`, or `zypper`) and installs a compatible browser package before
rendering. The sandbox must have package-manager permissions and network access, so
disable `sandbox.network_isolate` for tasks that need rendered web access.

---

## Event Bus & Worker Pools

`internal/eventbus` is a simple in-process pub/sub. Subscribers run handlers on one of
five worker pools maintained by `internal/worker`:

| Pool | Drains event | Default min / max |
|---|---|---|
| `task` | `EventTaskApproved` — runs the agent loop | 2 / CPU×4 |
| `review` | `EventTaskCreated`, `EventSecurityAlert`, `EventL2AuthApproved` | 2 / CPU×4 |
| `sandbox` | `EventSandboxCreated` | 2 / CPU×4 |
| `memory` | `EventTaskCompleted`, `EventTaskTidyTick` | 2 / 2 |
| `cleanup` | `EventSandboxDestroyed`, `EventSessionClosed`, `EventSessionArchived` | 1 / 1 |

`Pool.adjustLoop` runs every `stats_interval` and scales each pool up when utilization
crosses `scale_up_pct`, down when it drops below `scale_down_pct`. `cooldown_secs` prevents
flapping. All counters are exposed via `/metrics`.

A `tidy_interval` ticker (default 168h = 7 days) publishes `EventTaskTidyTick` to the
`memory` pool, which calls `workers.RunTaskTidy` to roll up old decision state.

---

## Internal Layout

The detailed package map lives in [LAYOUT.MD](LAYOUT.MD).

---

## Typical End-to-End Flow

1. User sends a message in the Web UI.
2. Web validates, persists, and `POST`s a `Task` to the Daemon (`/api/v1/tasks`).
3. Daemon publishes `EventTaskCreated`. `review` pool calls `Gatekeeper.Audit`:
   - L0: regex match — `curl|bash` → blocked, publish `EventSecurityAlert`, abort.
4. L0 passes; L1 scores `0.3` (medium) → allow + notify. `EventTaskApproved` fires.
5. `task` pool picks it up: creates session, calls `SelectSandbox` (`lxc` because the command
   contains `git clone`), creates the sandbox via `sandbox.Manager`, registers a workspace.
6. `AgentLoop.Run` starts:
   - Step 1: LLM decides to read a file. `file.read` tool runs in the LXC sandbox.
   - Output audit on the LLM's response → clean.
   - Step 2: LLM emits a `bash` command containing `sudo`. L1 scores high → `EventL2AuthRequired`
     published. The user sees an "Authorize?" button in the Web UI.
   - User clicks "Allow once" → Web calls `POST /api/v1/l2-confirm` with `action=pass_once`.
   - `EventL2AuthApproved` → L2 cache updated, the original `EventTaskApproved` is re-fired.
   - The blocked step resumes. The agent completes.
7. `EventTaskCompleted` → `memory` pool extracts a memory, sends a completion notification
   back to the Web (`/api/agentd/v1/notifications/send`).
8. On idle timeout (`session.timeout`, default 30m), `EventSessionArchived` → sandbox destroyed,
   session JSON retained.

---

## Operational Notes

- **Heartbeat**: `clawlessClient.RegisterNode` + a 30s `StartHeartbeat` goroutine. The Web
  side surfaces node health in the dashboard.
- **Singleton lock**: `lifecycle.AcquireSingleton` prevents two Daemons from racing on the
  same `/var/run/agentd.node_id` and local cache directory. Add a `flock`-style lock file
  there if you need to co-locate with another long-running service.
- **Node identity**: written to `clawless.node_id_file` (default `/var/run/agentd.node_id`)
  on first run. Reusing the same file preserves the node's identity across restarts.
- **Background task store** (`internal/persistence/background_task_store.go`): the Daemon
  keeps a small JSON file under `cache.path` for tasks that were mid-flight during a crash,
  and replays them on startup.
- **Logs**: structured slog with the format
  `<timestamp> [<module>] [<file:line>] <level> <message> <key=val>...`. Tune verbosity
  per-module via `[logging] level` and downstream callers (`slog.SetDefault` is the only
  place that swaps the handler).

---

## Related

- [Root README](../README.md) — full platform architecture
- [LAYOUT.MD](LAYOUT.MD) — internal package layout
- [`agentd.toml.example`](agentd.toml.example) — annotated config template
- [AgentBoster Web app](../app/) — the Next.js side that calls into this Daemon
