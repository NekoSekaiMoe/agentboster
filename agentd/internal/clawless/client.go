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

// UploadFile uploads a file to ClawLess Blob storage via the API.
func (c *Client) UploadFile(ctx context.Context, taskID, fileName string, content []byte, expiresIn time.Duration) (*UploadResult, error) {
	body := map[string]any{
		"task_id":    taskID,
		"file_name":  fileName,
		"content":    base64.StdEncoding.EncodeToString(content),
		"expires_in": int(expiresIn.Seconds()),
	}
	data, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/blob/upload", body)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[UploadResult]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// CreateWorkspace creates a new workspace.
func (c *Client) CreateWorkspace(ctx context.Context, ws *Workspace) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/workspaces", ws)
	return err
}

// GetWorkspaceByProjectID fetches a workspace by its project ID.
func (c *Client) GetWorkspaceByProjectID(ctx context.Context, projectID string) (*Workspace, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/workspaces?project_id="+projectID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[Workspace]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// ListWorkspaces lists all workspaces for an agent.
func (c *Client) ListWorkspaces(ctx context.Context, agentID string) ([]Workspace, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/workspaces?agent_id="+agentID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[[]Workspace]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data, nil
}

// GetTask fetches a task by ID.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[Task]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// UpdateTaskStatus updates the status of a task.
func (c *Client) UpdateTaskStatus(ctx context.Context, taskID string, status TaskStatus) error {
	body := map[string]string{"status": string(status)}
	_, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID, body)
	return err
}

// CreateTask creates a new task.
func (c *Client) CreateTask(ctx context.Context, task *Task) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/tasks", task)
	return err
}

// GetSession fetches a session by ID.
func (c *Client) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/sessions/"+sessionID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[Session]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// UpdateSession updates a session.
func (c *Client) UpdateSession(ctx context.Context, session *Session) error {
	_, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/sessions/"+session.ID, session)
	return err
}

// DeleteSession deletes a session.
func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, "/api/agentd/v1/sessions/"+sessionID, nil)
	return err
}

// WriteReviewLogs writes security review logs.
func (c *Client) WriteReviewLogs(ctx context.Context, logs []ReviewLog) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/review-logs", logs)
	return err
}

// ListMemories retrieves all memories for an agent.
func (c *Client) ListMemories(ctx context.Context, agentID string) ([]Memory, error) {
	return c.GetMemories(ctx, agentID, nil, 1000)
}

// UpdateMemory updates an existing memory's value.
func (c *Client) UpdateMemory(ctx context.Context, memoryID, newValue string) error {
	_, err := c.doRequest(ctx, http.MethodPut, fmt.Sprintf("/api/agentd/v1/memories/%s", memoryID), map[string]string{
		"value": newValue,
	})
	return err
}

// GetMemories searches agent memories.
func (c *Client) GetMemories(ctx context.Context, agentID string, keywords []string, limit int) ([]Memory, error) {
	body := map[string]any{
		"agent_id": agentID,
		"keywords": keywords,
		"limit":    limit,
	}
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/memories", body)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[[]Memory]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data, nil
}

// WriteMemories writes agent memories.
func (c *Client) WriteMemories(ctx context.Context, memories []Memory) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/memories", memories)
	return err
}

// DeleteMemory deletes a memory by ID.
func (c *Client) DeleteMemory(ctx context.Context, memoryID string) error {
	_, err := c.doRequest(ctx, http.MethodDelete, "/api/agentd/v1/memories/"+memoryID, nil)
	return err
}

// GetAgentConfig fetches agent configuration.
func (c *Client) GetAgentConfig(ctx context.Context, agentID string) (*AgentConfig, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/agent-config/"+agentID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[AgentConfig]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// GetL0Rules fetches L0 rules for an agent.
func (c *Client) GetL0Rules(ctx context.Context, agentID string) ([]L0Rule, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/l0-rules/"+agentID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[[]L0Rule]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data, nil
}

// RegisterSandbox registers a sandbox with ClawLess.
func (c *Client) RegisterSandbox(ctx context.Context, sandbox *SandboxMeta) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/sandboxes", sandbox)
	return err
}

// UpdateSandboxStatus updates sandbox status.
func (c *Client) UpdateSandboxStatus(ctx context.Context, sandboxID, status string) error {
	body := map[string]string{"status": status}
	_, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/sandboxes/"+sandboxID, body)
	return err
}

// LLMProxyRequest sends a request through the ClawLess LLM proxy.
func (c *Client) LLMProxyRequest(ctx context.Context, req *LLMProxyRequest) ([]byte, error) {
	return c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/llm-proxy", req)
}

// CreateNotification creates a notification via the ClawLess API.
func (c *Client) CreateNotification(ctx context.Context, notification *Notification) error {
	_, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/notifications", notification)
	return err
}

// PostJSON sends a POST request with JSON body and decodes the JSON response.
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

// GetTaskSummary fetches the summary for a task.
func (c *Client) GetTaskSummary(ctx context.Context, taskID string) (*TaskSummary, error) {
	data, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID+"/summary", nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[TaskSummary]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// UpdateTaskProgress forwards task_progress tool input to ClawLess for merging.
func (c *Client) UpdateTaskProgress(ctx context.Context, taskID string, input json.RawMessage) (*TaskSummary, error) {
	data, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID+"/summary/progress", input)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[TaskSummary]
	if err := json.Unmarshal(data, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// ExtractTaskMemory lets ClawLess handle post-task memory/summary lifecycle.
func (c *Client) ExtractTaskMemory(ctx context.Context, taskID string, req TaskMemoryRequest) error {
	data, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/tasks/"+taskID+"/memory", req)
	if err != nil {
		return err
	}
	var apiResp APIResponse[map[string]any]
	return json.Unmarshal(data, &apiResp)
}

// RunTaskSummaryTidy triggers ClawLess-owned task summary tidy scanning.
func (c *Client) RunTaskSummaryTidy(ctx context.Context) error {
	data, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/task-summaries/tidy/run", map[string]any{
		"agent_id": "default",
	})
	if err != nil {
		return err
	}
	var apiResp APIResponse[map[string]any]
	return json.Unmarshal(data, &apiResp)
}

// HealthCheck verifies the ClawLess API is reachable.
func (c *Client) HealthCheck(ctx context.Context) error {
	_, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/health", nil)
	if err != nil {
		return err
	}
	slog.Info("ClawLess API health check OK", "url", c.BaseURL)
	return nil
}
