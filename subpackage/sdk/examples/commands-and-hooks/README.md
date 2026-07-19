# @agentboster-example/commands-and-hooks

Counts assistant messages per session and exposes the count via
`/turncount`. Demonstrates the standard slash-command contract and
the four most useful lifecycle hooks.

## What it shows

- **`pi.registerCommand`** — slash commands with the conventional
  `/<base>`, `/<base> config`, `/<base> <subcommand>` patterns.
- **`pi.on('session_start')`** — per-session state seeding.
- **`pi.on('before_provider_request')`** — observe / mutate the
  outgoing provider request (telemetry, header injection, request
  rewriting).
- **`pi.on('message_end')`** — fires after every assistant message;
  the natural place for usage tracking.
- **`pi.on('agent_end')`** — turn-level cleanup hook.
- **`pi.on('session_shutdown')`** — flush state (persist, upload, …).

## Install

```bash
cp -r . ~/.config/agentboster-cli/extensions/commands-and-hooks/
```

## Verify

Run any conversation with a few exchanges, then:

```
/turncount
```

You should see a notification with the message count. Try
`/turncount reset` and the counter goes back to 0.

## Adapting

- **Usage analytics**: replace the in-memory map with a `fetch()` POST
  to your analytics endpoint inside `session_shutdown`.
- **Custom auth header**: in `before_provider_request`, return an
  override that adds your team's proxy auth header.
- **Request rewriting**: the same hook can swap the model id or
  rewrite messages (e.g., redact secrets before they leave the host).

## Hook firing order

```
session_start
└─ before_agent_start  ← agent loop begins
   ├─ before_provider_request  ← per LLM call
   │  └─ message_start
   │     └─ message_update (0..N)
   │        └─ message_end  ← count happens here
   └─ turn_end
└─ agent_end  ← agent loop ends (one agent loop can span multiple turns)
session_shutdown
```

For per-LLM-call granularity (e.g. caching, retries), use
`before_provider_request` + `after_provider_response`. For per-user-
message granularity, use `turn_start` / `turn_end`.
