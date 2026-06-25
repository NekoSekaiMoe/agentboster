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
- Go 1.26.2 to build
- Docker or LXC at runtime depending on the sandbox types you enable
  - Docker (rootless recommended): `docker`, `libseccomp2`
    - Default config uses rootless Docker at `/run/user/1001/docker.sock` for reduced attack surface
    - Rootful Docker (`/var/run/docker.sock`) requires explicit `allow_rootful_docker = true`
  - LXC requires: `lxc`, `libcap2`, `debootstrap` (or `yum`/`dnf` for non-Debian distros)

The daemon is stateless from a database perspective. All persistent state (sessions, tasks,
review logs, memories, agent configs) lives in the AgentBoster Web Postgres. Agentd caches a
small amount of state locally (background task recovery, session blob, L2 auth cache) and
syncs with the Web API.

**IM Commands** — Users interact with AgentBoster via IM channels (Telegram/Discord/Slack/Feishu/Teams).
All IM traffic is handled by AgentBoster Web; the daemon only receives task execution requests via mTLS.

Common commands: `/start`, `/new`, `/session`, `/stop`, `/cancel`, `/retry`, `/model`,
`/approve`, `/reject`, `/reset`, `/lang`, `/help`. See [main README](../README.md#im-commands) for the full list.

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

## First-Time Deployment

End-to-end setup, in order. The daemon talks back to the Web (Next.js on Vercel) over
HTTPS + shared API key, so the Web side must be reachable **before** you start agentd —
otherwise every heartbeat, L1 score, and L0-rule sync will log `connection refused`
(non-fatal, but nothing will work).

> **Direction matters.** Two directions, two different security stories:
>
> - **Daemon → Web (heartbeat, register, L1, tool callbacks)** — always HTTPS + `X-API-Key`.
>   **No mTLS on this direction** when the Web is on Vercel: Vercel's edge does not request
>   a client cert, and setting `[clawless].ca_path` to your self-signed CA **replaces** the
>   system root store that validates Vercel's Let's Encrypt cert → `x509: certificate signed
>   by unknown authority` → every outbound call fails. Keep `[clawless] client_cert_path` /
>   `client_key_path` / `ca_path` **empty** on Vercel deployments. They exist only for
>   self-hosted Web deployments where you control the Web's TLS stack.
> - **Web → Daemon (tool exec, when the Web actively drives a sandbox)** — mTLS goes here,
>   *if* the daemon is reachable from the Web (public IP or frp tunnel). Daemon's
>   `[server]` TLS config + Web's `AGENTD_CLIENT_CERT_PATH` family. If the daemon is
>   firewalled / not exposed (the common case), the Web simply won't drive it and only the
>   heartbeat direction is active.

### Prerequisites

- **Linux amd64 host** (build tags forbid other OSes; cross-compiling to other architectures
  is unsupported — build on the same arch you deploy on).
- **Go 1.26.2** on the build host.
- **Root at startup** (needed for cgroups / namespaces; drops to `run_as_user` afterwards).
- **Docker** (rootless recommended) — required for `docker` / `docker-strict` sandboxes.
- **LXC** (`lxc-create`, `lxc-start`, `lxc-attach`) — only if you enable the `lxc` provider.
- **Web deployed and reachable** — the daemon calls back to `[clawless].base_url` on boot.

### 1. Build the binary

```bash
cd agentd
go build -o agentd ./cmd/agentd/
file agentd       # MUST read: ELF 64-bit LSB executable, x86-64
```

If `file` reports `ARM aarch64` or anything else, you're on the wrong host — move to an
amd64 Linux machine and rebuild. Don't try to cross-compile; the `//go:build linux` tags
plus CGO dependencies make it unreliable.

### 2. Generate the API key (Web ↔ Daemon shared secret)

Web and Daemon authenticate each other with a single shared key. Generate it once, then set
**the identical value** on both sides:

```bash
openssl rand -hex 32
```

| Side | Where it goes | Name |
|---|---|---|
| Web (Vercel) | Environment variable | `AGENTD_API_KEY` |
| Daemon | `agentd.toml` → `[server]` | `clawless_api_key` |

Both strings must match byte-for-byte. Mismatch → all callbacks (`/api/agentd/v1/*`) get
rejected by `middleware.ts` / `APIKeyMiddleware`.

### 3. (Optional) Generate the mTLS certificate bundle

Only needed if the **Web will actively drive the daemon** (i.e. daemon is exposed via a
public IP or frp tunnel). Skip this section entirely for "heartbeat-only" deployments —
the daemon → Web direction uses plain HTTPS + API key.

```bash
sudo ./agentd -gen-certs ./certs
# → ca-cert.pem / ca-key.pem                 CA (10y)
#   server-cert.pem / server-key.pem         Daemon presents these  (1y)
#   client-cert.pem / client-key.pem         Web presents these     (1y)
```

Certs are ECDSA P-384, loopback SANs only (`127.0.0.1`, `::1`, `localhost`, `agentd-server`).
For non-loopback deployment, edit `internal/certs/certs.go` to add the right `IPAddresses`
/ `DNSNames` (e.g. your frp public hostname) and regenerate. Vercel holds the client pair +
CA via the `AGENTD_CLIENT_*` env vars; the daemon holds the server pair + CA via
`[server] tls_*_path` / `ca_path`.

### 4. Configure the Web side (Vercel)

Set these environment variables on the Web deployment:

| Variable | Required | Value |
|---|---|---|
| `AGENTD_API_KEY` | **yes** | The key from step 2 |
| `AGENTD_CLIENT_CERT_PATH` | mTLS only | Path to `client-cert.pem` (Web → Daemon mTLS) |
| `AGENTD_CLIENT_KEY_PATH` | mTLS only | Path to `client-key.pem` |
| `AGENTD_CA_PATH` | mTLS only | Path to `ca-cert.pem` |

```bash
vercel env add AGENTD_API_KEY
vercel --prod
```

> **Do NOT set `AGENTD_CLIENT_*` for Vercel→Vercel or daemon→Web mTLS.** Those env vars are
> read by `lib/extra/agent/agentd-tools-client.ts` and only attach a client cert on the
> **Web → Daemon** outbound request. The Daemon → Web direction never reads them.

Additionally, if the daemon is reachable via a public URL or frp tunnel, register it in the
dashboard under **Config → AgentD → Nodes**:

```yaml
nodes:
  - id: node-fnnas-1782410757917033429   # MUST match the daemon's node_id (read from /var/run/agentd.node_id on the daemon host)
    url: https://frp.example.com:18732    # the PUBLIC entry point (frp server, not the daemon's LAN IP)
    name: fnnas
```

Without this entry the Web will fall back to the daemon's self-reported LAN `ip:port`, which
is unreachable from Vercel.

### 5. Configure the daemon (`agentd.toml`)

```bash
cp agentd.toml.example agentd.toml
```

**Minimum config (heartbeat-only mode — daemon is NOT reachable from the Web):**

```toml
[server]
listen           = ":18732"
clawless_api_key = "<same value as AGENTD_API_KEY>"   # MUST match the Web side
# tls_cert_path / tls_key_path / ca_path all empty — daemon listens on plain HTTP locally.
# Fine for LAN-only / heartbeat-only deployments.

[clawless]
base_url          = "https://your-agentboster.vercel.app"   # Web deployment URL
# IMPORTANT: leave all three empty on Vercel deployments. Setting ca_path replaces the
# system root store and breaks validation of Vercel's Let's Encrypt cert.
client_cert_path  = ""
client_key_path   = ""
ca_path           = ""

[sandbox]
default              = "docker"
# Rootless recommended: unix:///run/user/<uid>/docker.sock
# Rootful: unix:///var/run/docker.sock + allow_rootful_docker = true
docker_socket        = "unix:///run/user/1001/docker.sock"
allow_rootful_docker = false

[security]
run_as_user = "agentd"   # unprivileged user to drop to after root setup
```

**Full config (daemon exposed via frp — Web actively drives it):**

```toml
[server]
listen           = ":18732"
tls_cert_path    = "./certs/server-cert.pem"   # mTLS server (Web authenticates to daemon)
tls_key_path     = "./certs/server-key.pem"
ca_path          = "./certs/ca-cert.pem"        # daemon validates Web's client cert
clawless_api_key = "<same value as AGENTD_API_KEY>"

[clawless]
base_url          = "https://your-agentboster.vercel.app"
# STILL empty — daemon → Web never uses mTLS on Vercel deployments.
client_cert_path  = ""
client_key_path   = ""
ca_path           = ""

[sandbox]
default              = "docker"
docker_socket        = "unix:///run/user/1001/docker.sock"
allow_rootful_docker = false

[security]
run_as_user = "agentd"
```

> **frp example (frpc.ini on the daemon host):**
> ```ini
> [common]
> server_addr = YOUR_PUBLIC_FRPS_HOST
> server_port = 7000
>
> [agentd]
> type = tcp
> local_ip = 127.0.0.1
> local_port = 18732
> remote_port = 18732
> ```
> Then expose `YOUR_PUBLIC_FRPS_HOST:18732` and point the Web dashboard node entry's `url`
> at it. If you front it with HTTPS (recommended), regenerate `server-cert.pem` with the
> frp hostname as a SAN — see `internal/certs/certs.go`.

### 6. Run

```bash
sudo ./agentd -config agentd.toml
```

Must be root at start (privilege drop happens after cgroup / namespace setup). Verify:

```bash
curl -k https://127.0.0.1:18732/health    # → { "success": true, "data": { "status": "ok", ... } }
# (use http:// if [server] tls_*_path is empty)
```

If you see `connection refused` to `[::1]:3000` in the logs, that's the daemon trying to
reach the Web — your `base_url` is wrong or the Web isn't deployed yet. Other startup
warnings (`docker socket not accessible`, `lxc-create not found`) are non-fatal — the daemon
will simply refuse to create the corresponding sandbox type until you install the runtime.

### 7. (Recommended) systemd unit

```ini
# /etc/systemd/system/agentd.service
[Unit]
Description=Agent Daemon
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agentd -config /etc/agentd/agentd.toml
WorkingDirectory=/etc/agentd
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now agentd
journalctl -u agentd -f
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `./agentd: 1: Syntax error: ")" unexpected` | Binary is the wrong architecture (e.g. ARM64 on an amd64 host) → shell tries to parse it as a script | Rebuild on an amd64 host; verify with `file agentd` |
| `reflect.Value.Addr of unaddressable value` at boot | Fixed in current source — rebuild | `git pull && go build -o agentd ./cmd/agentd/` |
| `panic: handlers are already registered for path '/api/v1/sessions/:id'` | Fixed in current source — rebuild | same |
| `dial tcp [::1]:3000: connect: connection refused` | Web isn't running / `base_url` points at `localhost` | Set `clawless.base_url` to the real Web URL |
| `x509: certificate signed by unknown authority` on heartbeat | `[clawless].ca_path` is set to your self-signed CA, which replaced the system root store that validates Vercel's Let's Encrypt cert | **Clear `[clawless].ca_path` / `client_cert_path` / `client_key_path`** — Daemon → Web never uses mTLS on Vercel |
| "Setting cert made it fail, removing cert fixed it" | Same as above — Vercel doesn't accept client certs on inbound TLS | Don't set the `[clawless]` cert family on Vercel deployments |
| `docker socket not accessible at /run/user/1001/docker.sock` | Rootless Docker not installed or running under a different UID | Install Docker rootless, or switch to rootful + `allow_rootful_docker = true` |
| `lxc-create not found in PATH` | LXC not installed | `apt install lxc` / skip if you only use `docker` |
| `node register failed` repeatedly | Web rejecting the daemon (wrong API key or base_url unreachable) | Re-check `AGENTD_API_KEY` parity and `clawless.base_url` |
| Web dashboard shows node but `cpu_usage=N/A`, `heartbeat: never` | Daemon registered once but heartbeat is failing — usually the cert regression above | Same fix: clear `[clawless]` cert family |
| Tool execution falls back to Vercel Sandbox instead of using the daemon | Daemon not reachable from Web (LAN IP / not exposed) | Expose daemon via frp, then register the public URL in Config → AgentD → Nodes |

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
| `DELETE` | `/api/v1/sessions/:id` | Delete session record |
| `POST` | `/api/v1/sessions/:id/destroy` | Destroy a running session's runtime state |
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
- `browser` (`tools_browser_v2.go`) — full Playwright-backed browser automation: navigate, click, type, get_text, get_html, screenshot, evaluate, save_state, load_state, list_profiles, close. See "Browser Automation" below.
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

### Browser Automation

The `browser_*` tools (`tools_browser_v2.go`) drive a long-lived **Playwright helper**
inside an LXC sandbox. Tool names and signatures mirror the serverless-side browser
MCP tools (`lib/mcp/tools/browser.ts`) so `storageState` profiles interop across sides.

**Architecture**: the daemon spawns a node.js bridge (`internal/agent/browser/bridge.js`)
inside the sandbox that holds a `chromium.launchPersistentContext`. The daemon
communicates with it via `sbMgr.Exec("curl --unix-socket /workspace/browser.sock ...")`
— no port forwarding required. node.js is bootstrapped on first call by
`node_install.sh` (Tsinghua TUNA mirror by default, SHA256-verified against nodejs.org).

**Profile persistence**: profiles live at `/workspace/browser-profiles/<name>/`. Both
the chromium user-data-dir (cookies, localStorage) and an explicit `storageState.json`
snapshot are kept on disk. LXC rootfs persistence means profiles survive across
sessions and daemon restarts. Use `browser_save_state` to export the storageState blob
for cross-side migration (e.g. hand off to the serverless browser via `memory_save`).

**Anti-detection**: realistic Chrome UA (no AgentBoster token),
`--disable-blink-features=AutomationControlled`, and `navigator.webdriver` masked
via `addInitScript`. Matches the serverless-side strategy exactly.

**Security**: `browser_evaluate` output is L0-audited (`Engine.CheckOutput`) to block
prompt/credential leakage through arbitrary in-page JS. The tool layer consults the
L0 engine directly via `AgentContext.L0Engine` (injected from `Gatekeeper.L0()`).

**Routing**: `needsPersistence` matches the `browser_` prefix and routes these tools
to LXC. Request `permission_profile=browser` for network access (the sandbox must be
able to reach the public web). Available to `trusted` users only.

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

> **Note (P0)**: the asynchronous `POST /api/v1/tasks` flow described below
> is the daemon's incoming-callback API. The Web app currently drives
> the daemon primarily through the synchronous per-tool dispatch API
> (`POST /api/v1/tools/exec` and friends), so a typical chat message
> does not necessarily exercise this task-lifecycle path. The task
> endpoints are still exercised by direct API callers and by the
> dispatcher's internal events.

1. User sends a message in the Web UI.
2. Web validates, persists, and `POST`s a `Task` to the Daemon (`/api/v1/tasks`).
3. Daemon publishes `EventTaskCreated`. The dispatcher routes the event
   through the `Gatekeeper`:
   - L0: regex match — `curl|bash` → blocked, publish `EventSecurityAlert`, abort.
4. L0 passes; L1 scores `0.3` (medium) → allow + notify. `EventTaskApproved` fires.
5. The dispatcher's task handler creates a session, calls `SelectSandbox`
   (`lxc` because the command contains `git clone`), creates the sandbox via
   `sandbox.Manager`, registers a workspace.
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
- **Singleton lock**: `lifecycle.AcquireSingleton` uses a three-layer scheme to guarantee only one Daemon runs per host:
  1. **Socket lock** at `/var/run/agentd.sock` (primary, OS-level atomic mutex — survives PID reuse and TOCTOU races that plague pure PID-file schemes).
  2. **PID file** at `/var/run/agentd.pid` (fallback — on stale-socket cleanup, reads the recorded PID, probes `/proc/<pid>/exe` and `/proc/<pid>/cmdline` to confirm the holder is really an agentd before refusing).
  3. **Port probe** on `server.listen` (edge-case backstop — catches a rogue instance whose socket file was deleted out from under it but is still serving).

  Normal shutdown closes the listener (OS removes the socket file) and deletes the PID file. `kill -9` / OOM / power loss may leave stale artifacts; the next launch detects this via layer 2 and cleans up automatically.
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
