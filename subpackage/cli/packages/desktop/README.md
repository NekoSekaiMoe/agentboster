# Agentboster Desktop

A Tauri 2 desktop shell for the **`agentboster` CLI** (`agentboster --mode rpc`) with
native computer-use capability (screenshots / accessibility tree / input injection).

Forked from [`gustavonline/pi-desktop`](https://github.com/gustavonline/pi-desktop)
upstream (Tauri + Lit variant). Adapted to:

- spawn `agentboster` instead of `pi`
- read/write `~/.config/agentboster/agent/` instead of `~/.pi/agent/`
- add computer-use Rust crates in `src-tauri/src/computer_use.rs`

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

Tauri 2 + Rust was chosen after evaluating Electron / Wails / Qt / Flutter /
React Native for the computer-use requirement. Only the Rust ecosystem has
mature, actively-maintained consumer-side libraries for all three:

| Capability | Crate |
|---|---|
| Screenshots | `xcap` |
| macOS Accessibility | `accessibility` (+ `objc2`) |
| Windows UIAutomation | `uiautomation` |
| Linux AT-SPI2 | `atspi` |
| Input injection | `enigo` |

In every non-Rust stack evaluated, at least one of these had to be hand-written
(LOC estimates ranged from 5k to 13k). See git history for the full evaluation.

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
│   ├── Cargo.toml        # Rust deps: tauri 2, xcap, enigo, accessibility...
│   ├── src/
│   │   ├── lib.rs        # main library: RPC bridge, session mgmt, CLI spawn
│   │   ├── main.rs       # binary entry, just calls lib's run()
│   │   └── computer_use.rs  # native computer-use Tauri commands
│   ├── capabilities/     # Tauri 2 capability JSON (permissions)
│   ├── tauri.conf.json   # app metadata, window config, bundle settings
│   └── icons/
└── index.html
```

## License

MIT (inherited from upstream `gustavonline/pi-desktop`).
