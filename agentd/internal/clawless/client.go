package clawless

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
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
func NewClientFromConfig(clawLessURL, apiKey, clientCertPath, clientKeyPath, caPath string) (*Client, error) {
	var tlsCfg *tls.Config
	if clientCertPath != "" && clientKeyPath != "" {
		cert, err := tls.LoadX509KeyPair(clientCertPath, clientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("load client cert: %w", err)
		}
		tlsCfg = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		if caPath != "" {
			caCert, err := os.ReadFile(caPath)
			if err != nil {
				return nil, fmt.Errorf("read CA cert: %w", err)
			}
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(caCert)
			tlsCfg.RootCAs = pool
		}
	}
	return NewClient(clawLessURL, apiKey, tlsCfg), nil
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
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(data))
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

// ── Workspaces ───────────────────────────────────────────────────────

func (c *Client) CreateWorkspace(ctx context.Context, ws *Workspace) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/workspaces", ws)
}

func (c *Client) GetWorkspaceByProjectID(ctx context.Context, projectID string) (*Workspace, error) {
	return requestJSONPtr[Workspace](c, ctx, http.MethodGet, "/api/agentd/v1/workspaces?project_id="+projectID, nil)
}

func (c *Client) ListWorkspaces(ctx context.Context, agentID string) ([]Workspace, error) {
	return requestJSON[[]Workspace](c, ctx, http.MethodGet, "/api/agentd/v1/workspaces?agent_id="+agentID, nil)
}

// ── Tasks ────────────────────────────────────────────────────────────

func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	return requestJSONPtr[Task](c, ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID, nil)
}

func (c *Client) UpdateTaskStatus(ctx context.Context, taskID string, status TaskStatus) error {
	return doVoid(c, ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID, map[string]string{"status": string(status)})
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
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/review-logs", logs)
}

// ── Memories ─────────────────────────────────────────────────────────

func (c *Client) ListMemories(ctx context.Context, agentID string) ([]Memory, error) {
	return c.GetMemories(ctx, agentID, nil, 1000)
}

func (c *Client) UpdateMemory(ctx context.Context, memoryID, newValue string) error {
	return doVoid(c, ctx, http.MethodPut, fmt.Sprintf("/api/agentd/v1/memories/%s", memoryID), map[string]string{"value": newValue})
}

func (c *Client) GetMemories(ctx context.Context, agentID string, keywords []string, limit int) ([]Memory, error) {
	return requestJSON[[]Memory](c, ctx, http.MethodGet, "/api/agentd/v1/memories", map[string]any{
		"agent_id": agentID,
		"keywords": keywords,
		"limit":    limit,
	})
}

func (c *Client) WriteMemories(ctx context.Context, memories []Memory) error {
	return doVoid(c, ctx, http.MethodPost, "/api/agentd/v1/memories", memories)
}

func (c *Client) DeleteMemory(ctx context.Context, memoryID string) error {
	return doVoid(c, ctx, http.MethodDelete, "/api/agentd/v1/memories/"+memoryID, nil)
}

// ── Knowledge Bases ─────────────────────────────────────────────────

func (c *Client) SearchKnowledge(ctx context.Context, agentID, query string, knowledgeBaseNames, knowledgeBaseIDs []string, limit int) ([]KnowledgeSearchResult, error) {
	body := map[string]any{
		"agent_id": agentID,
		"query":    query,
		"limit":    limit,
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
