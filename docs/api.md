# API Reference

AgentBoster exposes a REST API via Next.js App Router route handlers. Most endpoints respond with JSON; the exceptions are file/blob download endpoints (which stream binary attachments) and the L2 decision link handler (which returns an HTML result page). No GraphQL.

## Authentication

Four authentication patterns are used across the API:

**Cookie** — Standard web session via `readAuthSessionFromCookies`. The session cookie (`clawless-auth`) is set at login and carries an HMAC-SHA256 signed payload.

**CLI Token** — Bearer JWT issued by the pair-exchange flow. Carried in `Authorization: Bearer <token>`. Used by the CLI thin client for all remote operations.

**Agentd Key** — `AGENTD_API_KEY` environment variable (comma-separated for key rotation). Verified via constant-time string comparison. Used for daemon-to-web callbacks.

**Signed URL** — HMAC-signed query parameters (`t` expiry + `s` hex signature). Used for public-facing L2 decision links and self-hosted blob proxy URLs.

---

## Auth

### POST /api/auth/login
Validate username/password credentials and issue a session cookie. Auth: none.

### GET /api/auth/cli-devices
List all paired CLI devices and active pair codes for the authenticated user. Auth: cookie.

### DELETE /api/auth/cli-devices/[id]
Revoke a specific paired CLI device by ID. Auth: cookie.

### POST /api/auth/pair-generate
Issue a one-shot pair code the CLI can exchange for a full auth token. Auth: cookie.

### POST /api/auth/pair-exchange
Exchange a pair code for a CLI Bearer token and register a cli_devices row. Auth: none (pair code is proof).

### POST /api/auth/pair-revoke
Cancel an unconsumed pair code. Auth: cookie.

### GET /api/auth/users
List all users (admin only). With `?id=&includeData=1` returns user detail with sessions, files, and memories. Auth: cookie (admin).

### POST /api/auth/users
Create a new user account. Auth: cookie (admin).

### PATCH /api/auth/users
Update a user's password or roles. Auth: cookie (admin).

### DELETE /api/auth/users
Delete a user account. Auth: cookie (admin).

---

## Sessions

### GET /api/sessions/[id]/export
Export a session's messages and summaries as a JSON attachment for download. Auth: cookie.

### POST /api/sessions/[id]/revert
Revert a session to a previous message checkpoint by deleting messages after a given point. Auth: cookie.

---

## Messages

### PATCH /api/messages/[messageId]/metadata
Write message version metadata (edit/regenerate history) into the message payload JSONB. Auth: cookie.

---

## Config

### GET /api/config
Read-only access to the running AppConfig (feature flags, model settings, etc.). Auth: cookie.

### GET /api/config/export
Download the full AppConfig as a JSON attachment. Auth: cookie.

### GET /api/config/l0-rules
List all L0 command/path/network security rules. Auth: cookie.

### POST /api/config/l0-rules
Create a new L0 security rule. Auth: cookie.

### PATCH /api/config/l0-rules
Update an existing L0 rule. Auth: cookie.

### DELETE /api/config/l0-rules
Delete an L0 rule by ID. Auth: cookie.

### GET /api/config/audit-logs
Query audit/review logs with filters (level, decision, search, date range). Auth: cookie.

### GET /api/config/audit-logs/download
Download filtered audit logs as a file attachment. Auth: cookie.

### GET /api/config/tool-activity-logs
Query agent tool activity logs with filters (action, toolName, session, date range). Auth: cookie.

### GET /api/config/monitoring/metrics
Return active sandbox/task counts and system metrics. Auth: cookie.

### GET /api/config/monitoring/nodes
List all registered agentd nodes with computed liveness status. Auth: cookie.

### POST /api/config/mcp/test
Test connection to a configured MCP server. Calls tools/list on the server using current credentials. Auth: cookie (admin).

### GET /api/config/mcp/oauth/metadata
Get the OAuth redirect URI for MCP server configuration. Read-only, no side effects — safe to call on every mount. Auth: cookie (admin).

### GET /api/config/mcp/oauth/status?serverName=
Check OAuth connection status for a specific MCP server. Returns whether a token bundle exists and is usable (not expired, or refreshable). Does not return tokens. Auth: cookie (admin).

### POST /api/config/mcp/oauth/authorize
Start an OAuth Authorization Code + PKCE flow for an MCP server. Sets short-lived cookies (verifier, state, server name) and responds with the authorize URL. Auth: cookie (admin).

### GET /api/config/mcp/oauth/callback?code=&state=
OAuth callback handler. Validates state against cookie, exchanges code+verifier for tokens, stores encrypted bundle in Vault, redirects to config UI. A single callback URL serves all MCP servers via cookie context. Auth: cookie (admin).

### POST /api/config/mcp/oauth/revoke
Disconnect an MCP server's OAuth connection. Revokes tokens at the provider (RFC 7009), then deletes the encrypted bundle from Vault. Auth: cookie (admin).

---

## CLI

### POST /api/cli/chat
CLI chat entry point. Mirrors the web chat streaming endpoint, declares `source.type === 'cli'` and registers local_* tools. Auth: cli-token.

### GET /api/cli/sessions
List the caller's sessions, newest first. Optional `?channel=cli:<clientId>` filter. Auth: cli-token.

### GET /api/cli/sessions/[id]
Fetch a single session by ID. Auth: cli-token.

### PATCH /api/cli/sessions/[id]
Update session model or title. Auth: cli-token.

### DELETE /api/cli/sessions/[id]
Delete a session. Auth: cli-token.

### GET /api/cli/sessions/[id]/messages
Return visible message history of a session as UIMessage[]. Auth: cli-token.

### POST /api/cli/sessions/[id]/compact
Apply a compaction result: delete messages before a checkpoint and insert a summary message. Auth: cli-token.

### GET /api/cli/sessions/[id]/task-summary
Return the current task summary row for the session. Auth: cli-token.

### PATCH /api/cli/sessions/[id]/task-summary
Apply a delta update to the session's task summary (progress, pending items, decisions). Auth: cli-token.

### PATCH /api/cli/messages/[messageId]/metadata
CLI mirror of the web metadata endpoint. Verifies session ownership. Auth: cli-token.

### GET /api/cli/models
Return the model catalog so the CLI can render a model picker. Auth: cli-token.

### GET /api/cli/preferences
Return the caller's model preferences (default model, thinking level). Auth: cli-token.

### PATCH /api/cli/preferences
Merge-patch the caller's model preferences. Auth: cli-token.

### GET /api/cli/nodes
List online agentd nodes for the CLI /switch command (no ip/port exposed). Auth: cli-token.

### GET /api/cli/agentd-nodes
List agentd nodes for the Desktop schedule form's "preferred node" dropdown. Returns id, display label, computed effective status (heartbeat-freshness-based). Distinct from `/api/agentd/v1/nodes/status`. Auth: cli-token.

### GET /api/cli/l0-rules
Download enabled global command L0 rules for client-side enforcement. Auth: cli-token.

### POST /api/cli/l1-score
Score a shell command via the L1 LLM security scorer. Auth: cli-token.

### POST /api/cli/exec-on-agentd
Proxy a local_* tool call from a CLI session to a remote agentd node. Auth: cli-token.

### POST /api/cli/tool-result
Resume a `local_*` tool call blocked on `localToolResultHookBuilder` in the workflow agent loop. Called by CLI after executing a tool request received via session-events SSE. Accepts `sessionId` in body. Auth: cookie or cli-token.

### GET /api/cli/agentd/vnc
Fetch VNC session info and noVNC viewer URL for a CLI session running on agentd. Auth: cli-token.

### GET /api/cli/subagent/[subagentId]
Return info about a specific subagent (proxied to agentd). Auth: cli-token.

### GET /api/cli/subagent-batch/[batchId]
Return status of a subagent batch with aggregate counts. Auth: cli-token.

### GET /api/cli/subagent/[subagentId]/stream
SSE proxy — streams subagent messages from agentd in real time. Currently polls the messages endpoint and returns as a single SSE frame. Auth: cli-token.

### GET /api/cli/subagent/[subagentId]/messages
Return the conversation messages of a specific subagent. Proxied to agentd. Auth: cli-token.

### GET /api/cli/schedules
List scheduled tasks for the caller. Auth: cli-token.

### POST /api/cli/schedules
Create a new scheduled task (delay or daily). Supports node-routing constraints (preferredNodeId, allowedNodes, autoFallbackNode). Auth: cli-token.

### PATCH /api/cli/schedules/[id]
Update a scheduled task. Cancels the previous workflow run and starts a new one if active. Auth: cli-token.

### DELETE /api/cli/schedules/[id]
Delete a scheduled task. Cancels the live run first, then deletes the row. Auth: cli-token.

### GET /api/cli/im-channels
List the caller's paired IM adapters for the schedule "notify via" picker. Returns adapter slug, IM user id, display name, pairing timestamp. Auth: cli-token.

### GET /api/cli/session-events/[sessionId]
SSE endpoint for CLI remote control mode. CLI connects here to receive tool requests and heartbeat events. Auth: cookie or cli-token.

### POST /api/cli/session-events/[sessionId]/register
Register CLI as online with capabilities (hasDisplay, platform, scale, tools) and bind to a session. Auth: cli-token.

### POST /api/cli/session-events/[sessionId]/release
Mark CLI as offline for a session (graceful disconnect). Auth: cookie or cli-token.

---

## Agentd

All routes called daemon-to-web (agentd to AgentBoster web server). Auth is via AGENTD_API_KEY or requireTaskAccess unless noted otherwise.

### POST /api/agentd/v1/nodes/register
Register a new agentd node (deduped by node_id or ip+port address). Auth: agentd-key.

### POST /api/agentd/v1/nodes/heartbeat
Update node heartbeat with CPU/memory/cgroup stats. Reaps stale nodes. Auth: agentd-key.

### GET /api/agentd/v1/nodes/status
List all nodes with computed liveness status. Auth: agentd-key.

### GET /api/agentd/v1/agent-config/[id]
Return per-agent sandbox/resource/MCP settings for the daemon. Auth: agentd-key.

### GET /api/agentd/v1/capabilities
Return bot adapter capabilities for a given adapter+chatId. Auth: none.

### GET /api/agentd/v1/available
Report whether any agentd node is online and dispatch-ready (multi-node aware). Auth: none.

### GET /api/agentd/v1/health
Check agentd daemon reachability and return its health response. Auth: none.

### GET /api/agentd/v1/l0-rules/[id]
Return per-agent plus global L0 rule set for the daemon's L0 engine. Auth: agentd-key.

### POST /api/agentd/v1/l1-score
Score a command or output for safety risks via LLM (with KV cache). Auth: agentd-key.

### POST /api/agentd/v1/l1-score-batch
Batched L1 security scoring for exec_batch cross-command review. Auth: agentd-key.

### GET /api/agentd/v1/l1-health
Check whether the L1 scorer model is configured and reachable. Auth: agentd-key.

### POST /api/agentd/v1/l2/request
Create a new L2 authorization request when a high-risk command needs user approval. Auth: agentd-key.

### POST /api/agentd/v1/l2/resolve
Resolve an L2 decision (pass/reject) and forward verdict to the daemon. Auth: agentd-key.

### GET /api/agentd/v1/l2/list
List pending and sent L2 decisions. Auth: agentd-key.

### POST /api/agentd/v1/l2-confirm
IM-button callback: process an L2 decision and forward the verdict to agentd. Auth: agentd-key.

### GET /api/agentd/v1/decisions
List active (pending + sent) decisions for the web UI's polling hook. Auth: none.

### POST /api/agentd/v1/decisions/[id]/resolve
Resolve a decision of any type (L2 auth, question, conflict, branch). Auth: none.

### POST /api/agentd/v1/decisions/[id]/reject
Reject/ignore a decision and forward denial to the daemon. Auth: none.

### POST /api/agentd/v1/tasks
Create a new agent task. Auth: agentd-key.

### GET /api/agentd/v1/tasks/[id]
Fetch a task by ID. Auth: agentd-key.

### PUT /api/agentd/v1/tasks/[id]
Update task status and result. Auth: agentd-key.

### POST /api/agentd/v1/tasks/[id]/finalize
Finalize a task (mark completed/failed/cancelled, extract task memory). Auth: agentd-key.

### POST /api/agentd/v1/tasks/[id]/memory
Extract memories from a completed task session. Auth: agentd-key.

### POST /api/agentd/v1/tasks/[id]/stream-output
Receive streaming output chunks from a running task and upsert to DB. Auth: agentd-key.

### GET /api/agentd/v1/tasks/[id]/summary
Get the task summary (progress, decisions, pending items). Auth: agentd-key.

### PUT /api/agentd/v1/tasks/[id]/summary
Upsert the task summary. Auth: agentd-key.

### PUT /api/agentd/v1/tasks/[id]/summary/progress
Upsert summary with a new decision appended. Auth: agentd-key.

### POST /api/agentd/v1/tasks/[id]/summary/tidy
Generate an AI tidy report of the task summary. Auth: agentd-key.

### POST /api/agentd/v1/tasks/[id]/summary/tidy/apply
Apply tidy report suggestions to the task summary. Auth: agentd-key.

### GET /api/agentd/v1/tasks/pending-l2
List tasks currently in pending L2 authorization state (for daemon restart recovery). Auth: agentd-key.

### GET /api/agentd/v1/task-summaries
List all active task summaries for an agent. Auth: agentd-key.

### POST /api/agentd/v1/task-summaries/tidy/run
Run tidy reports on all active task summaries for an agent. Auth: agentd-key.

### GET /api/agentd/v1/memories
Search long-term memories by keyword(s). Auth: agentd-key.

### POST /api/agentd/v1/memories
Write/upsert long-term memories from a task. Auth: agentd-key.

### PUT /api/agentd/v1/memories/[id]
Update a specific long-term memory entry's value. Auth: agentd-key.

### DELETE /api/agentd/v1/memories/[id]
Delete a specific long-term memory entry. Auth: agentd-key.

### GET /api/agentd/v1/notifications
Get channel health or user notification preferences. Auth: none.

### POST /api/agentd/v1/notifications
Create a notification from daemon. Auth: agentd-key.

### POST /api/agentd/v1/notifications/send
Send an L2 auth prompt to an IM channel and return the sent message_id. Auth: agentd-key.

### POST /api/agentd/v1/notifications/recall
Delete a previously-sent IM message by source + message_id. Auth: agentd-key.

### GET /api/agentd/v1/sessions/[id]
Get session record with derived user_id, roles, source. Auth: agentd-key.

### PUT /api/agentd/v1/sessions/[id]
Update session fields. Auth: agentd-key.

### DELETE /api/agentd/v1/sessions/[id]
Delete a session. Auth: agentd-key.

### POST /api/agentd/v1/sessions/[id]/abort
Abort a running session (cancels workflow run and signals agentd). Auth: cookie.

### GET /api/agentd/v1/sessions/status
Poll session status for the frontend. Auth: cookie.

### POST /api/agentd/v1/sandboxes
Register a new sandbox for an agent. Auth: agentd-key.

### PUT /api/agentd/v1/sandboxes/[id]
Update sandbox status. Auth: agentd-key.

### POST /api/agentd/v1/tools/exec/stream
Proxy the daemon's SSE exec stream to the browser. Auth: cookie.

### POST /api/agentd/v1/tools/mcp-exec
MCP bridge: invoke a builtin MCP tool on behalf of the daemon. Auth: agentd-key.

### POST /api/agentd/v1/knowledge/search
Search knowledge bases on behalf of a task. Auth: agentd-key.

### POST /api/agentd/v1/blob/upload
Upload a file (base64) from the daemon to blob storage. Auth: agentd-key.

### GET /api/agentd/v1/vault/list
List vault key names (no values) for the daemon's tool inventory. Auth: agentd-key.

### POST /api/agentd/v1/review-logs
Batch-write L0/L1/L2 review log entries. Auth: agentd-key.

### POST /api/agentd/v1/tool-activity-logs
Batch-write tool activity log entries. Auth: agentd-key.

### POST /api/agentd/v1/llm-proxy
Proxy LLM completion requests to the configured AI provider. Auth: agentd-key.

### GET /api/agentd/v1/workspaces
Get or list workspaces by id/project_id/agent_id. Auth: agentd-key.

### POST /api/agentd/v1/workspaces
Create a new workspace. Auth: agentd-key.

---

## Bot

### POST /api/bot/[authSecret]/[adapter]/callback
IM webhook handler for all supported platforms. Validates the auth secret embedded in the URL path and dispatches the chat workflow. Auth: signed-url (authSecret path segment).

### POST /api/bot/[authSecret]/schedule
Trigger a scheduled bot task by taskId. Auth: signed-url (authSecret path segment).

### POST /api/bot/test-connection
Test an IM adapter connection by registering a webhook. Auth: cookie.

---

## Knowledge

### GET /api/knowledge
List knowledge bases. Optional `?agent_id` filter. Auth: cookie.

### POST /api/knowledge
Create a new knowledge base. Auth: cookie.

### PATCH /api/knowledge
Update a knowledge base. Auth: cookie.

### DELETE /api/knowledge
Delete a knowledge base by `?id=`. Auth: cookie.

### POST /api/knowledge/search
Full-text/semantic search across knowledge bases. Auth: cookie.

### GET /api/knowledge/[id]/connectors
List data connectors for a knowledge base. Auth: cookie.

### POST /api/knowledge/[id]/connectors
Create a new connector (url/mem0/http) for a knowledge base. Auth: cookie.

### DELETE /api/knowledge/[id]/connectors
Delete a connector by `?connector_id=`. Auth: cookie.

### GET /api/knowledge/[id]/documents
List documents in a knowledge base. Auth: cookie.

### POST /api/knowledge/[id]/documents
Add a document to a knowledge base. Auth: cookie.

### DELETE /api/knowledge/[id]/documents
Delete a document by `?document_id=`. Auth: cookie.

---

## Files

### GET /api/files/[id]/download
Download a file from blob storage. Ownership-checked; admin can access all files. Auth: cookie.

---

## Blob Proxy

### GET /api/blob/[...path]
Proxy an S3/MinIO blob to the caller after verifying HMAC signature (self-hosted only). Auth: signed-url.

---

## L2 Decision Links

### GET /api/l2/[decisionId]/[action]
Public L2 decision URL-button endpoint for IM platforms. Verifies HMAC signature and returns a mobile-friendly HTML result page. Auth: signed-url.

---

## Notifications

### GET /api/notifications
List notifications for the authenticated user with channel/read-state filters. Auth: cookie.

### POST /api/notifications/mark-read
Mark specific notification IDs as read. Auth: cookie.

### POST /api/notifications/mark-all-read
Mark all pending notifications as read. Auth: cookie.

---

## Tasks

### GET /api/tasks/history
List agent tasks with optional status/agentId filter. Non-admin users see only their own tasks. Auth: cookie.

---

## Vault

### GET /api/vault/list
List vault entries (with values) for the authenticated user. Auth: cookie.

### POST /api/vault/list
Upsert a vault key/value entry. Auth: cookie.

### POST /api/vault/read
Read a specific vault entry by key. Auth: cookie.

---

## Soul

### GET /api/soul
Return global SOUL.md built-in memory content for agentd system prompt injection. Auth: none.

### GET /api/soul/[sessionId]
Return session-specific SOUL content (falls back to global). Auth: agentd-key or cookie.

---

## Sandbox

### POST /api/sandbox/tools
Execute sandbox tool actions (read/write file, run command) in a session's sandbox. Auth: cookie.

---

## Pair

### POST /api/pair/generate
Generate a one-shot pair code for adapter pairing (separate from CLI pair flow). Used to pair IM adapters like Telegram. Body: `{ adapter }`. Auth: cookie.

---

## Export

### GET /api/export
Export data as a JSON attachment. Query params: `items` (comma-separated: `config`, `builtin_memories`, `long_term_memories`, `l0_rules`), `redact` (default true). Admin-only for config/builtin/l0 items. Auth: cookie (admin for most items).

---

## Import

### POST /api/import
Import data from the JSON body produced by GET `/api/export`. Query params: `items` (restrict which sections to apply), `merge` (default true — merge config with existing). Admin-only for config and l0 rules. Auth: cookie (admin for most items).

---

## Internal

### POST /api/internal/im-stream
Internal endpoint for IM webhook to drain the workflow stream and progressively edit the IM message. Auth: none (internal only).
