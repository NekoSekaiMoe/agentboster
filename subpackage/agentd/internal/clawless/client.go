package clawless

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
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

func (c *Client) WriteReviewLogs(ctx context.Context, logs []ReviewLog) error {
	canonical := make([]map[string]any, 0, len(logs))
	for _, log := range logs {
		if log.RunID == "" {
			return fmt.Errorf("review log %q has no run_id", log.Command)
		}
		startedAt := log.Timestamp
		if startedAt.IsZero() {
			startedAt = time.Now().UTC()
		}
		idempotencyKey := log.IdempotencyKey
		if idempotencyKey == "" {
			idempotencyKey = fmt.Sprintf("review:%s:%s:%s:%s", log.TaskID, log.Level, log.Decision, log.Command)
		}
		canonical = append(canonical, map[string]any{
			"record_kind":     "span",
			"trace_id":        log.RunID,
			"span_id":         "review:" + idempotencyKey,
			"parent_span_id":  "model:" + log.RunID + ":0",
			"source":          "agentd",
			"type":            "review",
			"status":          log.Decision,
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
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/review-logs", canonical)
}

func (c *Client) WriteToolActivityLogs(ctx context.Context, logs []ToolActivityLog) error {
	canonical := make([]map[string]any, 0, len(logs))
	for _, log := range logs {
		if log.RunID == "" {
			return fmt.Errorf("tool activity %q has no run_id", log.ToolName)
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
		canonical = append(canonical, map[string]any{
			"record_kind":     "span",
			"trace_id":        log.RunID,
			"span_id":         "tool:" + idempotencyKey,
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
			"error":           log.Error,
			"idempotency_key": idempotencyKey,
			"metadata": map[string]any{
				"toolName": log.ToolName, "action": log.Action, "target": log.Target,
				"outputText": log.OutputText, "model": log.Model, "step": log.Step,
				"toolCallId": log.ToolCallID, "sandboxId": log.SandboxID,
			},
		})
	}
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/tool-activity-logs", canonical)
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
