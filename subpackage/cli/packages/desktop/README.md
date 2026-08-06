# Agentboster Desktop

A Tauri 2 desktop shell for the **`agentboster` CLI** (`agentboster --mode rpc`) with
native computer-use capability (screenshots / accessibility tree / input injection).

Forked from [`gustavonline/pi-desktop`](https://github.com/gustavonline/pi-desktop)
upstream (Tauri + Lit variant). Adapted to:

- spawn `agentboster-cli` instead of `pi`
- read/write `~/.config/agentboster-cli/agent/` instead of `~/.pi/agent/`
- delegate native computer-use capabilities to the external `computer-use-mcp` (Go) server

## Position in the agentboster repo

```
agentboster/
├── subpackage/cli/packages/
│   ├── ai/                 # LLM types
│   ├── agent/              # agent primitives
│   ├── agentboster-adapter/# auth + web stream
│   ├── coding-agent/       # the `agentboster` CLI binary
│   └── desktop/            # ← this package
└── subpackage/agentd/      # Linux sandbox execution daemon
```

Desktop is **excluded from the `cli/` Yarn workspace** (see root
`subpackage/cli/package.json`'s explicit `workspaces` array). It manages its own
`npm install` because its toolchain diverges (Tauri CLI + Lit + Vite, not
tsgo + Biome like the rest of `cli/`).

## Why this stack

Tauri 2 + Rust was chosen for its lightweight footprint and security features. While computer-use capabilities were originally implemented natively in Rust (using crates like `xcap`, `accessibility`, `uiautomation`, etc.), these have since been extracted into an independent, pure-Go external MCP server (`subpackage/computer-use-mcp`) to eliminate CGo dependencies and simplify cross-compilation.

The desktop app now spawns and communicates with this Go MCP server for all screen capture, accessibility, and input injection tasks.
## Development without local Rust toolchain

The Rust toolchain is **not required** on the developer's machine. Rust code is
built via GitHub Actions (see `.github/workflows/release.yml`, inherited from
upstream — produces mac/win/linux artifacts on tag push).

For local development:
- Frontend-only iteration: `npm install && npm run dev` (Vite dev server)
- Tauri dev with Rust rebuild: requires `cargo` locally (one-time install via
  https://rustup.rs if you want to test Rust changes before pushing)

## Project layout

```
.
├── src/                  # Lit + Vite frontend (TypeScript)
│   └── components/
├── src-tauri/
│   ├── Cargo.toml        # Rust deps: tauri 2
│   ├── src/
│   │   ├── lib.rs        # main library: RPC bridge, session mgmt, CLI spawn
│   │   └── main.rs       # binary entry, just calls lib's run()
│   ├── capabilities/     # Tauri 2 capability JSON (permissions)
│   ├── tauri.conf.json   # app metadata, window config, bundle settings
│   └── icons/
└── index.html
```

## License

MIT (inherited from upstream `gustavonline/pi-desktop`).
