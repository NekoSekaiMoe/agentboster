# Agent Daemon Internal Layout

```text
agentd/
├── cmd/agentd/main.go            entry point, lifecycle, signal handling
├── agentd.toml.example           annotated config template
├── go.mod / go.sum
└── internal/
    ├── agent/                    CodeAct loop, tool registry, context compaction
    │   ├── loop.go
    │   ├── codeact.go
    │   ├── context.go
    │   ├── manager.go
    │   ├── question.go
    │   ├── subagent_runner.go    P0.1: goroutine runner for sub-agents
    │   ├── tools.go, tools_register.go
    │   ├── tools_*.go            one file per tool family
    │   │                           tools_browser_v2.go: Playwright-backed browser_*
    │   │                           (mirrors serverless-side lib/mcp/tools/browser.ts)
    │   └── browser/              in-sandbox Playwright bridge lifecycle
    │       ├── browser.go          EnsureBridge / CallBridge / CloseBridge
    │       ├── bridge.js           embedded node.js HTTP helper over unix socket
    │       └── node_install.sh     bootstrap node.js (TUNA mirror, SHA256-verified)
    ├── cache/                    local session blob with periodic sync + retry,
    │                             gzip compression, ClawLess upstream sync (P0.4)
    ├── certs/                    agentd -gen-certs CA + server + client
    ├── clawless/                 Web API client (REST) and L1 scorer client
    ├── config/                   Viper-backed TOML loader, defaults, validation, mTLS
    ├── eventbus/                 in-process pub/sub (bus + event types)
    ├── identity/                 persistent node ID file
    ├── lifecycle/                singleton lock, node registration, heartbeat
    ├── logging/                  slog handler with [module] [func:line] formatting
    ├── metrics/                  runtime metrics collector -> /tmp/agentd/metrics.json
    ├── persistence/              background task store, kvstore, task stream
    ├── sandbox/                  docker, docker-strict, lxc providers, workspace,
    │                             media, skills loader, availability checks
    ├── security/
    │   ├── gatekeeper.go         L0 -> L1 -> L2 orchestration, output audit
    │   ├── privilege.go          DropPrivileges to run_as_user
    │   ├── l0_rules/             regex engine + default presets (command/path/network/output)
    │   ├── l2_auth/              L2 cache, notification formatter
    │   └── os_enforce/           seccomp, capabilities, policy
    ├── server/                   Gin HTTP routes + middleware (mTLS, API key, CORS, logger)
    ├── session/                  session store, LRU eviction, sub-agent state
    └── worker/
        ├── pool.go               dynamic goroutine pool (Asika-style)
        ├── dispatcher.go         event -> pool routing
        ├── writer.go             buffered output writer
        └── workers/              per-event-type handlers
            ├── batch_collector.go  parallel exec batch
            ├── exec_worker.go      single exec command handler
            └── tidy_worker.go      periodic task summary tidy
```
