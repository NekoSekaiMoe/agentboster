package clawless

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Client is the HTTP client for communicating with the ClawLess API.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
	mu         sync.RWMutex
}

// NewClient creates a new ClawLess API client.
func NewClient(baseURL, apiKey string, tlsCfg *tls.Config) *Client {
	transport := &http.Transport{
		TLSClientConfig: tlsCfg,
	}
	return &Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		HTTPClient: &http.Client{
			Transport: transport,
			Timeout:   30 * time.Second,
		},
	}
}

// NewClientFromConfig creates a client from the app config.
//
// The three optional cert paths are independent:
//   - clientCertPath / clientKeyPath: a client certificate to present
//     (mutual TLS). Only meaningful when the server actually requests a
//     client cert — Vercel does NOT, so leaving these empty on Vercel
//     deployments is correct and expected.
//   - caPath: PEM bundle of extra CAs to trust in addition to the
//     system root store. We deliberately AUGMENT the system pool rather
//     than replace it: if a user sets caPath to their self-signed CA on
//     a deployment whose server presents a public cert (e.g. Vercel +
//     Let's Encrypt), the system roots must still validate it. The
//     previous implementation used `x509.NewCertPool()` which dropped
//     every system CA, breaking Daemon → Web calls with
//     `x509: certificate signed by unknown authority` even though the
//     server cert was perfectly valid.
func NewClientFromConfig(clawLessURL, apiKey, clientCertPath, clientKeyPath, caPath string) (*Client, error) {
	var tlsCfg *tls.Config

	if clientCertPath != "" || clientKeyPath != "" || caPath != "" {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	if clientCertPath != "" || clientKeyPath != "" {
		if clientCertPath == "" || clientKeyPath == "" {
			return nil, fmt.Errorf("client_cert_path and client_key_path must be set together (got cert=%q key=%q)", clientCertPath, clientKeyPath)
		}
		cert, err := tls.LoadX509KeyPair(clientCertPath, clientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("load client cert: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}

	if caPath != "" {
		caCert, err := os.ReadFile(caPath)
		if err != nil {
			return nil, fmt.Errorf("read CA cert: %w", err)
		}
		// Start from the system root store so public CAs (Let's Encrypt,
		// DigiCert, ...) still validate. AppendCertsFromPEM returns false
		// only when the PEM contained zero certs — treat that as an error
		// so a misconfigured ca_path doesn't silently degrade to the
		// system pool alone.
		pool, err := x509.SystemCertPool()
		if err != nil {
			// SystemCertPool is unsupported on some platforms (e.g.
			// certain WASM builds); fall back to an empty pool rather
			// than failing hard. On Linux (the only platform this
			// binary supports per its build tags) this branch is
			// unreachable.
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("parse CA cert: no certificates found in %s", caPath)
		}
		tlsCfg.RootCAs = pool
	}

	return NewClient(clawLessURL, apiKey, tlsCfg), nil
}

// apiStatusError carries the HTTP status of a failed API call so callers
// can branch on specific statuses (e.g. 404 fallback for mixed-version
// deployments) instead of parsing message strings.
type apiStatusError struct {
	Status int
	Body   string
}

func (e *apiStatusError) Error() string {
	return fmt.Sprintf("API error %d: %s", e.Status, e.Body)
}

// isNotFound reports whether err is an API 404 response.
func isNotFound(err error) bool {
	var se *apiStatusError
	return errors.As(err, &se) && se.Status == http.StatusNotFound
}

// doRequest is the low-level HTTP helper. All API methods go through here.
func (c *Client) doRequest(ctx context.Context, method, path string, body any) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("X-API-Key", c.APIKey)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, fmt.Errorf("read response: %w", readErr)
	}

	if resp.StatusCode >= 400 {
		return nil, &apiStatusError{Status: resp.StatusCode, Body: string(data)}
	}

	return data, nil
}

// requestJSON calls doRequest and unwraps APIResponse[T].
func requestJSON[T any](c *Client, ctx context.Context, method, path string, body any) (T, error) {
	var zero T
	data, err := c.doRequest(ctx, method, path, body)
	if err != nil {
		return zero, err
	}
	var resp APIResponse[T]
	if err := json.Unmarshal(data, &resp); err != nil {
		return zero, err
	}
	return resp.Data, nil
}

// requestJSONPtr is like requestJSON but returns *T for pointer-typed APIs.
func requestJSONPtr[T any](c *Client, ctx context.Context, method, path string, body any) (*T, error) {
	v, err := requestJSON[T](c, ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// doVoid calls doRequest and discards the response body.
func doVoid(c *Client, ctx context.Context, method, path string, body any) error {
	_, err := c.doRequest(ctx, method, path, body)
	return err
}

// PartialCallbackError describes a 207 Multi-Status response from a
// canonical trace callback batch: some (but not all) records in the
// batch failed to ingest. The Web receiver (app/api/agentd/v1/trace-callbacks.ts)
// reports the per-item outcomes as `{ success: true, partial: true, data,
// errors, failed }` — FailedIndexes mirrors the entries of errors/data
// that are non-null errors.
type PartialCallbackError struct {
	FailedIndexes []int
	Errors        []string
	Failed        int
	Body          string
}

func (e *PartialCallbackError) Error() string {
	return fmt.Sprintf("partial callback failure: %d of %d record(s) failed: %s",
		e.Failed, len(e.Errors), strings.Join(e.Errors, "; "))
}

// partialCallbackResponse matches the subset of the 207 body we branch
// on. Only fields that survive JSON round-tripping are included.
type partialCallbackResponse struct {
	Success bool              `json:"success"`
	Partial bool              `json:"partial"`
	Failed  int               `json:"failed"`
	Errors  []json.RawMessage `json:"errors"`
}

// parsePartialCallback decodes a 207 response body. It returns nil when
// the body does not carry the partial-failure marker ({"partial":true})
// — in that case the caller treats the response as a plain success.
func parsePartialCallback(data []byte) *PartialCallbackError {
	var resp partialCallbackResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil
	}
	if !resp.Partial {
		return nil
	}
	pErr := &PartialCallbackError{
		Failed: resp.Failed,
		Body:   string(data),
	}
	for i, raw := range resp.Errors {
		// JSON null entry → that record succeeded.
		if string(raw) == "null" {
			pErr.Errors = append(pErr.Errors, "")
			continue
		}
		// Non-string or empty-string values are real failures (the server
		// signals failure per index with a JSON value). Use the unmarshalled
		// message when it is a non-empty string; otherwise fall back to the
		// raw JSON representation so the message is never silently dropped.
		pErr.FailedIndexes = append(pErr.FailedIndexes, i)
		var msg string
		if err := json.Unmarshal(raw, &msg); err != nil || msg == "" {
			msg = string(raw)
		}
		pErr.Errors = append(pErr.Errors, msg)
	}
	if resp.Failed == 0 {
		// Defensive: a mis-signalled 207 without real failures is a
		// success as far as the caller is concerned.
		return nil
	}
	return pErr
}

// doVoidTrace is doVoid for the canonical trace callback routes
// (/api/agentd/v1/review-logs and /tool-activity-logs). Unlike the plain
// doVoid, it inspects the response body: those routes report partial
// batch failures as HTTP 207 with a {partial: true, errors: [...]} body,
// which doRequest would otherwise swallow as success (it only treats
// >=400 as failure). Returns a *PartialCallbackError when the response
// carries partial-failure markers; a 207 whose body does not decode into
// the partial shape is treated as success (same lenient stance as the
// other doRequest callers).
func doVoidTrace(c *Client, ctx context.Context, method, path string, body any) error {
	data, err := c.doRequest(ctx, method, path, body)
	if err != nil {
		return err
	}
	if pErr := parsePartialCallback(data); pErr != nil {
		return pErr
	}
	return nil
}

// sendCanonicalBatch posts one canonical trace callback batch with
// 207-partial awareness: when the server reports that a subset of the
// records failed, the failed subset is retried exactly once (same
// idempotency keys — the receiver deduplicates on (trace_id,
// idempotency_key), so re-sending succeeded records would be a no-op,
// but we only resend the failed ones to keep the retry batch small).
// If the retry still reports failures, the aggregated error is returned.
// A non-partial error (transport failure, 4xx/5xx) is returned
// immediately without retry.
func sendCanonicalBatch(ctx context.Context, c *Client, path string, batch []map[string]any) error {
	err := doVoidTrace(c, ctx, http.MethodPost, path, batch)
	if err == nil {
		return nil
	}
	var partial *PartialCallbackError
	if !errors.As(err, &partial) {
		return err
	}

	var retry []map[string]any
	for _, idx := range partial.FailedIndexes {
		if idx >= 0 && idx < len(batch) {
			retry = append(retry, batch[idx])
		}
	}
	if len(retry) == 0 {
		// failed>0 but no correlatable index — nothing sensible to
		// retry; surface the partial error.
		return partial
	}
	slog.Warn("canonical trace batch partially failed, retrying failed records",
		"path", path,
		"batch_size", len(batch),
		"failed", partial.Failed,
		"retrying", len(retry),
	)
	retryErr := doVoidTrace(c, ctx, http.MethodPost, path, retry)
	if retryErr == nil {
		return nil
	}
	var retryPartial *PartialCallbackError
	if errors.As(retryErr, &retryPartial) {
		return fmt.Errorf("canonical trace batch still failing after retry: %d of %d record(s) failed: %w",
			retryPartial.Failed, len(retry), retryPartial)
	}
	return fmt.Errorf("canonical trace batch retry failed: %w", retryErr)
}

// ── Blob ─────────────────────────────────────────────────────────────

func (c *Client) UploadFile(ctx context.Context, taskID, fileName string, content []byte, expiresIn time.Duration) (*UploadResult, error) {
	return requestJSONPtr[UploadResult](c, ctx, http.MethodPost, "/api/agentd/v1/blob/upload", map[string]any{
		"task_id":    taskID,
		"file_name":  fileName,
		"content":    base64.StdEncoding.EncodeToString(content),
		"expires_in": int(expiresIn.Seconds()),
	})
}

// ── Project Sandboxes (project↔sandbox binding) ──────────────────────
// The Web table was renamed from `workspaces` to `project_sandboxes` to
// free the name for the new user-facing workspace concept. The primary
// API below uses ProjectSandbox naming and hits /project-sandboxes, with
// a graceful 404 fallback to the legacy /workspaces endpoint so
// mixed-version deployments (new CLI/daemon vs old Web) keep working
// during the transition.

const (
	projectSandboxesPath = "/api/agentd/v1/project-sandboxes"
	legacyWorkspacesPath = "/api/agentd/v1/workspaces"
)

// doWithLegacyFallback runs fn against primaryPath; on a 404 (old Web
// server that predates the rename) it retries against legacyPath.
func doWithLegacyFallback[T any](primaryPath, legacyPath string, fn func(path string) (T, error)) (T, error) {
	v, err := fn(primaryPath)
	if err != nil && isNotFound(err) {
		return fn(legacyPath)
	}
	return v, err
}

// CreateProjectSandbox creates a project↔sandbox binding on the Web tier.
func (c *Client) CreateProjectSandbox(ctx context.Context, ps *ProjectSandbox) error {
	_, err := doWithLegacyFallback(projectSandboxesPath, legacyWorkspacesPath, func(path string) (struct{}, error) {
		return struct{}{}, doVoid(c, ctx, http.MethodPost, path, ps)
	})
	return err
}

// GetProjectSandboxByProjectID returns the binding for a project, if any.
func (c *Client) GetProjectSandboxByProjectID(ctx context.Context, projectID string) (*ProjectSandbox, error) {
	return doWithLegacyFallback(projectSandboxesPath, legacyWorkspacesPath, func(path string) (*ProjectSandbox, error) {
		return requestJSONPtr[ProjectSandbox](c, ctx, http.MethodGet, path+"?project_id="+projectID, nil)
	})
}

// ListProjectSandboxes lists the bindings owned by an agent.
func (c *Client) ListProjectSandboxes(ctx context.Context, agentID string) ([]ProjectSandbox, error) {
	return doWithLegacyFallback(projectSandboxesPath, legacyWorkspacesPath, func(path string) ([]ProjectSandbox, error) {
		return requestJSON[[]ProjectSandbox](c, ctx, http.MethodGet, path+"?agent_id="+agentID, nil)
	})
}

// CreateWorkspace creates a project↔sandbox binding.
//
// Deprecated: use CreateProjectSandbox.
func (c *Client) CreateWorkspace(ctx context.Context, ws *Workspace) error {
	return c.CreateProjectSandbox(ctx, ws)
}

// GetWorkspaceByProjectID returns the binding for a project, if any.
//
// Deprecated: use GetProjectSandboxByProjectID.
func (c *Client) GetWorkspaceByProjectID(ctx context.Context, projectID string) (*Workspace, error) {
	return c.GetProjectSandboxByProjectID(ctx, projectID)
}

// ListWorkspaces lists the bindings owned by an agent.
//
// Deprecated: use ListProjectSandboxes.
func (c *Client) ListWorkspaces(ctx context.Context, agentID string) ([]Workspace, error) {
	return c.ListProjectSandboxes(ctx, agentID)
}

// ── Tasks ────────────────────────────────────────────────────────────

func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	return requestJSONPtr[Task](c, ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID, nil)
}

func (c *Client) UpdateTaskStatus(ctx context.Context, taskID string, status TaskStatus) error {
	return doVoid(c, ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID, map[string]string{"status": string(status)})
}

// MCPExecResult is the JSON response from the web layer's MCP bridge.
type MCPExecResult struct {
	Success bool   `json:"success"`
	Data    string `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// MCPExec invokes an MCP tool on the web layer.
//
// P1.2: agentd's mcp_call tool calls this to reach MCP servers hosted
// on the web app (builtin servers: web/browser/firecrawl/github/context7).
// The web layer gates access by agent config (mcp_enabled + allowlist).
func (c *Client) MCPExec(ctx context.Context, serverName, toolName string, args map[string]any, agentID, sessionID string) (*MCPExecResult, error) {
	body := map[string]any{
		"server_name": serverName,
		"tool_name":   toolName,
		"args":        args,
		"agent_id":    agentID,
		"session_id":  sessionID,
	}
	resp, err := requestJSONPtr[MCPExecResult](c, ctx, http.MethodPost, "/api/agentd/v1/tools/mcp-exec", body)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (c *Client) CreateTask(ctx context.Context, task *Task) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/tasks", task)
}

// ── Sessions ─────────────────────────────────────────────────────────

func (c *Client) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	return requestJSONPtr[Session](c, ctx, http.MethodGet, "/api/agentd/v1/sessions/"+sessionID, nil)
}

func (c *Client) UpdateSession(ctx context.Context, session *Session) error {
	return doVoid(c, ctx, http.MethodPut, "/api/agentd/v1/sessions/"+session.ID, session)
}

func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	return doVoid(c, ctx, http.MethodDelete, "/api/agentd/v1/sessions/"+sessionID, nil)
}

// ── Review Logs ──────────────────────────────────────────────────────

// BuildReviewIdempotencyKey derives the deterministic idempotency key
// for a security review record:
//
//	review:<taskID>:<level>:<decision>:<sha256(command)>
//
// The command text is embedded as a SHA-256 digest (hex, truncated)
// rather than verbatim so oversized commands or sensitive fragments do
// not leak into keys, while the key stays deterministic across retries.
// Shared by the gatekeeper (ReviewResult.ReviewLog), the agent loop's
// stampReviewLogs re-stamping, and the dispatcher's security-alert path
// so every producer derives identical keys for the same review.
func BuildReviewIdempotencyKey(taskID, level, decision, command string) string {
	key, _ := BuildReviewIdempotencyKeyAndDigest(taskID, level, decision, command)
	return key
}

// BuildReviewIdempotencyKeyAndDigest is BuildReviewIdempotencyKey that also
// returns the raw-output digest embedded in the key, so producers can pin it
// on the ReviewLog (KeyCommandDigest) for later lossless re-derivation.
func BuildReviewIdempotencyKeyAndDigest(taskID, level, decision, command string) (string, string) {
	sum := sha256.Sum256([]byte(command))
	digest := hex.EncodeToString(sum[:16])
	return fmt.Sprintf("review:%s:%s:%s:%s", taskID, level, decision, digest), digest
}

// ReviewIdempotencyKeyFromDigest rebuilds a review idempotency key from the
// SHA-256 digest of the raw command/output, substituting only the task id.
// It must stay byte-identical to BuildReviewIdempotencyKey(taskID, level,
// decision, command) with the original untruncated command — the digest is
// pinned at ReviewLog-construction time precisely so later re-stamping
// (e.g. loop.stampReviewLogs replacing a placeholder task id) does not
// collapse distinct long outputs onto the same key by re-hashing the
// 256-byte-truncated Command copy.
func ReviewIdempotencyKeyFromDigest(taskID, level, decision, digest string) string {
	return fmt.Sprintf("review:%s:%s:%s:%s", taskID, level, decision, digest)
}

func (c *Client) WriteReviewLogs(ctx context.Context, logs []ReviewLog) error {
	canonical := make([]map[string]any, 0, len(logs))
	for _, log := range logs {
		if log.RunID == "" {
			// Skip the malformed entry instead of failing the whole batch:
			// one record without a trace id must not drop the valid audit
			// records around it.
			slog.Warn("skipping review log without run_id",
				"task_id", log.TaskID,
				"session_id", log.SessionID,
				"level", log.Level,
				"decision", log.Decision)
			continue
		}
		startedAt := log.Timestamp
		if startedAt.IsZero() {
			startedAt = time.Now().UTC()
		}
		idempotencyKey := log.IdempotencyKey
		if idempotencyKey == "" {
			idempotencyKey = BuildReviewIdempotencyKey(log.TaskID, log.Level, log.Decision, log.Command)
		}
		canonical = append(canonical, map[string]any{
			"record_kind": "span",
			"trace_id":    log.RunID,
			// idempotencyKey already carries the "review:" prefix (either
			// from the caller or BuildReviewIdempotencyKey) — prepending
			// it again used to produce "review:review:..." span ids.
			"span_id": idempotencyKey,
			// The parent span is not knowable from agentd (review logs are
			// not tied to a specific model span); attach to the trace root.
			"parent_span_id":  nil,
			"source":          "agentd",
			"type":            "review",
			"status":          "completed",
			"started_at":      startedAt,
			"completed_at":    startedAt,
			"duration_ms":     0,
			"task_id":         log.TaskID,
			"idempotency_key": idempotencyKey,
			"output":          map[string]any{"decision": log.Decision, "score": log.Score, "reason": log.Reason},
			"metadata":        map[string]any{"level": log.Level, "decision": log.Decision, "score": log.Score, "reason": log.Reason, "command": log.Command},
			"session_id":      log.SessionID,
		})
	}
	if len(canonical) == 0 {
		// Everything was skipped — avoid posting an empty batch.
		return nil
	}
	return sendCanonicalBatch(ctx, c, "/api/agentd/v1/review-logs", canonical)
}

func (c *Client) WriteToolActivityLogs(ctx context.Context, logs []ToolActivityLog) error {
	canonical := make([]map[string]any, 0, len(logs))
	for _, log := range logs {
		if log.RunID == "" {
			// Skip the malformed entry instead of failing the whole batch
			// (mirrors WriteReviewLogs).
			slog.Warn("skipping tool activity without run_id",
				"task_id", log.TaskID,
				"session_id", log.SessionID,
				"tool_name", log.ToolName)
			continue
		}
		startedAt := log.StartedAt
		if startedAt.IsZero() {
			startedAt = time.Now().UTC()
		}
		idempotencyKey := log.IdempotencyKey
		if idempotencyKey == "" {
			idempotencyKey = fmt.Sprintf("tool:%s:%s:%s", log.TaskID, log.ToolCallID, startedAt.UTC().Format(time.RFC3339Nano))
		}
		status := "completed"
		if !log.Success {
			status = "failed"
		}
		var completedAt any
		if !log.CompletedAt.IsZero() {
			completedAt = log.CompletedAt
		}
		// The Web reader (lib/core/trace/query.ts) consumes the error
		// column through canonicalRecord(span.error).message — the wire
		// convention is an object, never a bare string. Empty errors stay
		// nil.
		var errorPayload any
		if log.Error != "" {
			errorPayload = map[string]any{"message": log.Error}
		}
		canonical = append(canonical, map[string]any{
			"record_kind": "span",
			"trace_id":    log.RunID,
			// idempotencyKey already carries the "tool:" prefix — do not
			// prepend it again (used to produce "tool:tool:..." span ids).
			"span_id":         idempotencyKey,
			"parent_span_id":  "model:" + log.RunID + ":" + fmt.Sprint(log.Step),
			"source":          "agentd",
			"type":            "tool",
			"status":          status,
			"started_at":      startedAt,
			"completed_at":    completedAt,
			"duration_ms":     log.DurationMs,
			"task_id":         log.TaskID,
			"session_id":      log.SessionID,
			"agent_id":        log.AgentID,
			"input":           log.Arguments,
			"output":          log.Result,
			"error":           errorPayload,
			"idempotency_key": idempotencyKey,
			"metadata": map[string]any{
				"toolName": log.ToolName, "action": log.Action, "target": log.Target,
				"outputText": log.OutputText, "model": log.Model, "step": log.Step,
				"toolCallId": log.ToolCallID, "sandboxId": log.SandboxID,
			},
		})
	}
	if len(canonical) == 0 {
		// Everything was skipped — avoid posting an empty batch.
		return nil
	}
	return sendCanonicalBatch(ctx, c, "/api/agentd/v1/tool-activity-logs", canonical)
}

// ── Memories ─────────────────────────────────────────────────────────

type ResourceScope struct {
	TaskID    string
	SessionID string
}

type MemoryScope = ResourceScope

func resourceScope(scope []ResourceScope) ResourceScope {
	if len(scope) == 0 {
		return ResourceScope{}
	}
	return scope[0]
}

func (c *Client) ListMemories(ctx context.Context, agentID string, scope ...MemoryScope) ([]Memory, error) {
	return c.GetMemories(ctx, agentID, nil, 1000, scope...)
}

func (c *Client) UpdateMemory(ctx context.Context, memoryID, newValue string, scope ...MemoryScope) error {
	values := url.Values{}
	s := resourceScope(scope)
	if s.TaskID != "" {
		values.Set("task_id", s.TaskID)
	}
	if s.SessionID != "" {
		values.Set("session_id", s.SessionID)
	}
	path := "/api/agentd/v1/memories/" + memoryID
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return doVoid(c, ctx, http.MethodPut, path, map[string]string{"value": newValue})
}

func (c *Client) GetMemories(ctx context.Context, agentID string, keywords []string, limit int, scope ...MemoryScope) ([]Memory, error) {
	values := url.Values{}
	if agentID != "" {
		values.Set("agent_id", agentID)
	}
	if len(keywords) > 0 {
		values.Set("keywords", strings.Join(keywords, ","))
	}
	if limit > 0 {
		values.Set("limit", fmt.Sprintf("%d", limit))
	}

	s := resourceScope(scope)
	if s.TaskID != "" {
		values.Set("task_id", s.TaskID)
	}
	if s.SessionID != "" {
		values.Set("session_id", s.SessionID)
	}

	path := "/api/agentd/v1/memories"
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return requestJSON[[]Memory](c, ctx, http.MethodGet, path, nil)
}

func (c *Client) WriteMemories(ctx context.Context, memories []Memory, scope ...MemoryScope) error {
	s := resourceScope(scope)
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/memories", map[string]any{
		"task_id":    s.TaskID,
		"session_id": s.SessionID,
		"memories":   memories,
	})
}

func (c *Client) DeleteMemory(ctx context.Context, memoryID string, scope ...MemoryScope) error {
	values := url.Values{}
	s := resourceScope(scope)
	if s.TaskID != "" {
		values.Set("task_id", s.TaskID)
	}
	if s.SessionID != "" {
		values.Set("session_id", s.SessionID)
	}
	path := "/api/agentd/v1/memories/" + memoryID
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return doVoid(c, ctx, http.MethodDelete, path, nil)
}

// ── Knowledge Bases ─────────────────────────────────────────────────

func (c *Client) SearchKnowledge(ctx context.Context, agentID, query string, knowledgeBaseNames, knowledgeBaseIDs []string, limit int, scope ...ResourceScope) ([]KnowledgeSearchResult, error) {
	body := map[string]any{
		"agent_id": agentID,
		"query":    query,
		"limit":    limit,
	}
	s := resourceScope(scope)
	if s.TaskID != "" {
		body["task_id"] = s.TaskID
	}
	if s.SessionID != "" {
		body["session_id"] = s.SessionID
	}
	if len(knowledgeBaseNames) > 0 {
		body["knowledge_base_names"] = knowledgeBaseNames
	}
	if len(knowledgeBaseIDs) > 0 {
		body["knowledge_base_ids"] = knowledgeBaseIDs
	}

	return requestJSON[[]KnowledgeSearchResult](c, ctx, http.MethodPost, "/api/agentd/v1/knowledge/search", body)
}

// ── Agent Config ─────────────────────────────────────────────────────

func (c *Client) GetAgentConfig(ctx context.Context, agentID string) (*AgentConfig, error) {
	return requestJSONPtr[AgentConfig](c, ctx, http.MethodGet, "/api/agentd/v1/agent-config/"+agentID, nil)
}

func (c *Client) GetL0Rules(ctx context.Context, agentID string) ([]L0Rule, error) {
	return requestJSON[[]L0Rule](c, ctx, http.MethodGet, "/api/agentd/v1/l0-rules/"+agentID, nil)
}

// ── Sandboxes ────────────────────────────────────────────────────────

func (c *Client) RegisterSandbox(ctx context.Context, sandbox *SandboxMeta) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/sandboxes", sandbox)
}

func (c *Client) UpdateSandboxStatus(ctx context.Context, sandboxID, status string) error {
	return doVoid(c, ctx, http.MethodPut, "/api/agentd/v1/sandboxes/"+sandboxID, map[string]string{"status": status})
}

// ── LLM Proxy ────────────────────────────────────────────────────────

func (c *Client) LLMProxyRequest(ctx context.Context, req *LLMProxyRequest) ([]byte, error) {
	return c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/llm-proxy", req)
}

// ── Notifications ────────────────────────────────────────────────────

func (c *Client) CreateNotification(ctx context.Context, notification *Notification) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/notifications", notification)
}

func (c *Client) SendNotification(ctx context.Context, body map[string]any) (*NotificationSendResponse, error) {
	return requestJSONPtr[NotificationSendResponse](c, ctx, http.MethodPost, "/api/agentd/v1/notifications/send", body)
}

func (c *Client) GetCapabilities(ctx context.Context, source BotSource) (*BotCapabilitiesResponse, error) {
	values := url.Values{}
	values.Set("adapter", source.Adapter)
	values.Set("chatId", source.ThreadID)
	values.Set("threadId", source.ThreadID)
	return requestJSONPtr[BotCapabilitiesResponse](c, ctx, http.MethodGet, "/api/agentd/v1/capabilities?"+values.Encode(), nil)
}

func (c *Client) RecallNotification(ctx context.Context, source BotSource, messageID string) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/notifications/recall", map[string]any{
		"source":     source,
		"message_id": messageID,
	})
}

// PostJSON sends a POST request and optionally decodes the response into dest.
func (c *Client) PostJSON(ctx context.Context, path string, body any, dest any) error {
	data, err := c.doRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	if dest != nil {
		return json.Unmarshal(data, dest)
	}
	return nil
}

// ── Task Summaries ───────────────────────────────────────────────────

func (c *Client) GetTaskSummary(ctx context.Context, taskID string) (*TaskSummary, error) {
	return requestJSONPtr[TaskSummary](c, ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID+"/summary", nil)
}

func (c *Client) UpdateTaskProgress(ctx context.Context, taskID string, input json.RawMessage) (*TaskSummary, error) {
	return requestJSONPtr[TaskSummary](c, ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID+"/summary/progress", input)
}

func (c *Client) ExtractTaskMemory(ctx context.Context, taskID string, req TaskMemoryRequest) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/tasks/"+taskID+"/memory", req)
}

func (c *Client) RunTaskSummaryTidy(ctx context.Context) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/task-summaries/tidy/run", map[string]any{"agent_id": "default"})
}

func (c *Client) ListVaultKeys(ctx context.Context) ([]string, error) {
	resp, err := requestJSON[struct {
		Keys []string `json:"keys"`
	}](c, ctx, http.MethodGet, "/api/agentd/v1/vault/list", nil)
	if err != nil {
		return nil, err
	}
	return resp.Keys, nil
}

// ── SOUL ─────────────────────────────────────────────────────────────

type SoulResponse struct {
	Content   string `json:"content"`
	UpdatedAt string `json:"updated_at,omitempty"`
	Scope     string `json:"scope,omitempty"`
}

func (c *Client) GetSoulContent(ctx context.Context) (*SoulResponse, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/soul", nil)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Success bool         `json:"success"`
		Data    SoulResponse `json:"data"`
		Error   string       `json:"error,omitempty"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("get soul: %s", resp.Error)
	}
	return &resp.Data, nil
}

func (c *Client) GetSessionSoul(ctx context.Context, sessionID string) (*SoulResponse, error) {
	data, err := c.doRequest(ctx, http.MethodGet, fmt.Sprintf("/api/soul/%s", sessionID), nil)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Success bool         `json:"success"`
		Data    SoulResponse `json:"data"`
		Error   string       `json:"error,omitempty"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("get session soul: %s", resp.Error)
	}
	return &resp.Data, nil
}

// ── Health ───────────────────────────────────────────────────────────

func (c *Client) HealthCheck(ctx context.Context) error {
	if err := doVoid(c, ctx, http.MethodGet, "/api/agentd/v1/health", nil); err != nil {
		return err
	}
	slog.Info("ClawLess API health check OK", "url", c.BaseURL)
	return nil
}
