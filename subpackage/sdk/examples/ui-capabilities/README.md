# @agentboster-example/ui-capabilities

Exercises the host UI surface: shortcuts, flags, custom message
renderers, status line, footer, and notifications. Useful as a copy
source when building extensions that need a non-trivial UI presence.

## What it shows

- **`pi.registerShortcut`** — bind a key chord to an action. Example
  binds Ctrl+Alt+F to a focus-mode toggle.
- **`pi.registerFlag`** — register a togglable boolean in the status
  line. Other extensions can read it via `pi.getFlag(name)`.
- **`pi.registerMessageRenderer`** — render a custom message type.
  Extensions and the host can emit messages with a custom `type`, and
  any registered renderer for that type wins over the default text
  rendering.
- **`ctx.ui.custom(...)`** — emit a custom message that the renderer
  picks up. Used by the `long_running_demo` tool to stream a
  progress-card.
- **`ctx.ui.notify` / `setStatus` / `setFooter`** — push transient
  status to the host chrome. Best-effort across TUI / RPC / print
  modes; the host knows what to do.
- **`pi.on('turn_start' / 'turn_end')`** — lifecycle hooks for UI
  bookkeeping (show a "thinking…" pill, etc.).

## Install

```bash
cp -r . ~/.config/agentboster-cli/extensions/ui-capabilities/
```

## Verify

- **Shortcut**: focus the chat input, press Ctrl+Alt+F. The
  `focus-mode` flag should toggle in the status line.
- **Custom renderer + tool**: ask the model

  > Use long_running_demo.

  You should see progress cards stream in at 25/50/75/100%.
- **Status line**: every model turn flips a `ui-demo:turn` status pill
  to "thinking…" and clears it when the turn ends.

## Adapt

Replace the `ProgressCard` shape with your own message type — common
patterns are external-integration cards (CI status, calendar events,
issue trackers), tool-call enrichment (render a tool's full output as
a syntax-highlighted block), or live progress for long-running tasks.

The renderer's `block` field is the desktop-app payload; the `text`
field is the TUI fallback. Always populate both.
