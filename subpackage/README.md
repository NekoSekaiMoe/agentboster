# `subpackage/`

Sibling projects that ship alongside the Web app at the repo root. Each subdirectory is an **independent module** with its own toolchain, `AGENTS.md`, and release cycle — they are NOT part of the root yarn workspace or the root TypeScript project.

| Subdir | Lang / Toolchain | Module type | What it is |
|--------|------------------|-------------|------------|
| [`agentd/`](./agentd/README.md) | Go 1.26.2 | standalone `go.mod` | Linux execution daemon: sandboxed tool calls, L0/L1/L2 security, node registration, heartbeats. Talks to the Web service over HTTPS. |
| [`cli/`](./cli/README.md) | TypeScript + Biome 2.3.5, yarn classic | self-contained repo with its own `package.json` | The `agentboster` terminal coding agent. Thin TUI client of the Web backend — no direct provider mode; every LLM call goes through `POST /api/cli/chat`. |
| [`dbushelper/`](./dbushelper/README.md) | Go 1.26.4 | standalone `go.mod` | Pure-Go AT-SPI2 accessibility D-Bus client. Runs inside the agentd LXC sandbox; powers `desktop_inspect` / `desktop_a11y_click` / `desktop_a11y_type`. |

## Working across boundaries

- The root `tsconfig.json` **excludes** `subpackage/`, so `yarn lint:check` from the repo root does not typecheck the CLI or agentd. Run checks inside each subdir.
- Root Vitest only picks up `subpackage/cli/src/**/*.test.ts`; run CLI tests from `subpackage/cli/` itself.
- Each subdir has its own `AGENTS.md` with boundary-specific guidance — read it before editing.
- `ref/` and `memoh/` are vendored reference material, NOT subpackages; do not edit them as app code.
