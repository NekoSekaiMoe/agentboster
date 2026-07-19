# @agentboster-example/hello-tool

Minimal agentboster extension. Reference implementation for `@agentboster/sdk`.

## What it shows

- `registerTool` — exposes a tool the model can call
- `registerCommand` — adds a `/hello` slash command
- `on('session_start')` — subscribes to a lifecycle event

## Install

Copy this directory into one of the runtime's discovery paths:

```bash
# Per-project (preferred)
cp -r . /path/to/your/project/.agentboster/extensions/hello-tool/

# Or globally for the current user
cp -r . ~/.config/agentboster-cli/extensions/hello-tool/
```

Then start the agentboster CLI. The runtime discovers the extension via
[jiti](https://github.com/unjs/jiti) at startup and calls the default
export with the host's `ExtensionAPI`.

## Verify

Ask the model:

> Use the hello tool to greet "Ada".

You should see `Hello, Ada!` in the tool result.

Or run the slash command:

```text
/hello
```

It will prompt for a default name and show a confirmation notice.

## Layout

```text
hello-tool/
├── package.json     # declares "agentboster" / "pi" manifest field
└── index.ts         # default export = ExtensionFactory
```

## Manifest

The runtime reads `package.json` to find the extension entry point:

```json
{
  "agentboster": { "extensions": ["index.ts"] },
  "pi":          { "extensions": ["index.ts"] }
}
```

Either field works (`agentboster` is the current namespace; `pi` is the
legacy upstream namespace, kept for compatibility). If both are absent,
the runtime falls back to `index.ts`.
