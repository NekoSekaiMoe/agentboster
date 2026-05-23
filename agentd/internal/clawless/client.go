package clawless

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
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

func (c *Client) doRequest(ctx context.Context, method, path string, body any) (*http.Response, error) {
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

 	return c.HTTPClient.Do(req)
}

func (c *Client) decodeResponse(resp *http.Response, dest any) error {
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}
	if dest != nil {
		return json.NewDecoder(resp.Body).Decode(dest)
	}
	return nil
}

// GetTask fetches a task by ID.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/tasks/"+taskID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[Task]
	if err := c.decodeResponse(resp, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// UpdateTaskStatus updates the status of a task.
func (c *Client) UpdateTaskStatus(ctx context.Context, taskID string, status TaskStatus) error {
	body := map[string]string{"status": string(status)}
	resp, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/tasks/"+taskID, body)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// CreateTask creates a new task.
func (c *Client) CreateTask(ctx context.Context, task *Task) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/tasks", task)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// GetSession fetches a session by ID.
func (c *Client) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/sessions/"+sessionID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[Session]
	if err := c.decodeResponse(resp, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// UpdateSession updates a session.
func (c *Client) UpdateSession(ctx context.Context, session *Session) error {
	resp, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/sessions/"+session.ID, session)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// DeleteSession deletes a session.
func (c *Client) DeleteSession(ctx context.Context, sessionID string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, "/api/agentd/v1/sessions/"+sessionID, nil)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// WriteReviewLogs writes security review logs.
func (c *Client) WriteReviewLogs(ctx context.Context, logs []ReviewLog) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/review-logs", logs)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// GetMemories searches agent memories.
func (c *Client) GetMemories(ctx context.Context, agentID string, keywords []string, limit int) ([]Memory, error) {
	body := map[string]any{
		"agent_id": agentID,
		"keywords": keywords,
		"limit":    limit,
	}
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/memories", body)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[[]Memory]
	if err := c.decodeResponse(resp, &apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data, nil
}

// WriteMemories writes agent memories.
func (c *Client) WriteMemories(ctx context.Context, memories []Memory) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/memories", memories)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// DeleteMemory deletes a memory by ID.
func (c *Client) DeleteMemory(ctx context.Context, memoryID string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, "/api/agentd/v1/memories/"+memoryID, nil)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// GetAgentConfig fetches agent configuration.
func (c *Client) GetAgentConfig(ctx context.Context, agentID string) (*AgentConfig, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/agent-config/"+agentID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[AgentConfig]
	if err := c.decodeResponse(resp, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp.Data, nil
}

// GetL0Rules fetches L0 rules for an agent.
func (c *Client) GetL0Rules(ctx context.Context, agentID string) ([]L0Rule, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/l0-rules/"+agentID, nil)
	if err != nil {
		return nil, err
	}
	var apiResp APIResponse[[]L0Rule]
	if err := c.decodeResponse(resp, &apiResp); err != nil {
		return nil, err
	}
	return apiResp.Data, nil
}

// RegisterSandbox registers a sandbox with ClawLess.
func (c *Client) RegisterSandbox(ctx context.Context, sandbox *SandboxMeta) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/sandboxes", sandbox)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// UpdateSandboxStatus updates sandbox status.
func (c *Client) UpdateSandboxStatus(ctx context.Context, sandboxID, status string) error {
	body := map[string]string{"status": status}
	resp, err := c.doRequest(ctx, http.MethodPut, "/api/agentd/v1/sandboxes/"+sandboxID, body)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// LLMProxyRequest sends a request through the ClawLess LLM proxy.
func (c *Client) LLMProxyRequest(ctx context.Context, req *LLMProxyRequest) ([]byte, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/llm-proxy", req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// CreateNotification creates a notification via the ClawLess API.
func (c *Client) CreateNotification(ctx context.Context, notification *Notification) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/agentd/v1/notifications", notification)
	if err != nil {
		return err
	}
	return c.decodeResponse(resp, nil)
}

// HealthCheck verifies the ClawLess API is reachable.
func (c *Client) HealthCheck(ctx context.Context) error {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/agentd/v1/health", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check failed: %d", resp.StatusCode)
	}
 	slog.Info("ClawLess API health check OK", "url", c.BaseURL)
	return nil
}
