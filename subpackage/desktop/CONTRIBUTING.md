# Contributing

Thanks for your interest in contributing to PiDeck.

## Development Setup

```bash
npm install
npm run make-icon
npm run dev
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run build
```

## Guidelines

- Keep pi itself responsible for agent behavior, tools, sessions, model calls, and context management.
- Prefer RPC integration over reimplementing pi internals.
- Avoid directly mutating pi session JSONL files.
- Keep Electron IPC narrow and typed through `src/shared`.
- Add comments for non-obvious business logic, boundary cases, and process/session state transitions.

## Commit Style

Use clear, conventional-style commits where possible:

```txt
feat: add session status bar
fix: restore active agent when switching projects
chore: update docs
```
