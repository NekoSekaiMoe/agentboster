package clawless

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// L1Result is the result of an L1 security score.
type L1Result struct {
	Score  float64 `json:"score"`
	Level  string  `json:"level"` // low, medium, high, critical
	Reason string  `json:"reason"`
}

// L1Scorer is the interface for L1 security scoring.
// Implemented by L1Client (calls ClawLess API) and can be mocked for testing.
type L1Scorer interface {
	Score(ctx context.Context, command, workDir, sessionSummary string) (*L1Result, error)
	ScoreOutput(ctx context.Context, output, sessionSummary string) (*L1Result, error)
	ScoreBatch(ctx context.Context, commands []string, sessionSummary string) ([]*L1Result, error)
}

// L1Client calls the ClawLess /api/agentd/v1/l1-score endpoint for L1 scoring.
// Replaces the local L1 scorer (prompts + LLM call logic moved to clawless web layer).
type L1Client struct {
	baseURL    string
	modelID    string
	httpClient *http.Client
	apiKey     string
	available  bool
}

// NewL1Client creates a new L1 client that calls the ClawLess scoring API.
func NewL1Client(baseURL, modelID, apiKey string) *L1Client {
	return &L1Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		modelID: modelID,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Health verifies that the web-side L1 scorer endpoint is reachable and has a
// configured model provider. It does not run an LLM request.
func (c *L1Client) Health(ctx context.Context) error {
	url := fmt.Sprintf("%s/api/agentd/v1/l1-health", c.baseURL)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("create L1 health request: %w", err)
	}
	if c.apiKey != "" {
		httpReq.Header.Set("X-API-Key", c.apiKey)
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return fmt.Errorf("L1 health request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read L1 health response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("L1 health API returned %d: %s", resp.StatusCode, string(body))
	}

	var healthResp struct {
		Success bool   `json:"success"`
		Error   string `json:"error,omitempty"`
	}
	if err := json.Unmarshal(body, &healthResp); err != nil {
		return fmt.Errorf("parse L1 health response: %w", err)
	}
	if !healthResp.Success {
		return fmt.Errorf("L1 health API error: %s", healthResp.Error)
	}

	c.available = true
	return nil
}

func (c *L1Client) unavailableResult(reason string) (*L1Result, error) {
	return &L1Result{
		Score:  0.8,
		Level:  "high",
		Reason: reason,
	}, nil
}

type l1ScoreRequest struct {
	Type           string `json:"type"`
	Command        string `json:"command,omitempty"`
	Output         string `json:"output,omitempty"`
	WorkDir        string `json:"work_dir,omitempty"`
	ContextSummary string `json:"context_summary,omitempty"`
	ModelID        string `json:"model_id,omitempty"`
}

type l1ScoreResponse struct {
	Success bool      `json:"success"`
	Data    *L1Result `json:"data"`
	Error   string    `json:"error,omitempty"`
}

// Score evaluates a command for safety risks via the ClawLess API.
func (c *L1Client) Score(ctx context.Context, command, workDir, sessionSummary string) (*L1Result, error) {
	if !c.available {
		return c.unavailableResult("L1 unavailable: startup health check failed or was not run")
	}

	req := l1ScoreRequest{
		Type:           "command",
		Command:        command,
		WorkDir:        workDir,
		ContextSummary: sessionSummary,
		ModelID:        c.modelID,
	}

	result, err := c.doScore(ctx, req)
	if err != nil {
		slog.Error("L1 scoring failed", "error", err)
		return c.unavailableResult(fmt.Sprintf("L1 scoring error: %v", err))
	}

	return result, nil
}

// ScoreOutput evaluates LLM output content for safety risks via the ClawLess API.
func (c *L1Client) ScoreOutput(ctx context.Context, output, sessionSummary string) (*L1Result, error) {
	if !c.available {
		return c.unavailableResult("L1 unavailable: startup health check failed or was not run")
	}

	req := l1ScoreRequest{
		Type:           "output",
		Output:         output,
		ContextSummary: sessionSummary,
		ModelID:        c.modelID,
	}

	result, err := c.doScore(ctx, req)
	if err != nil {
		slog.Error("L1 output scoring failed", "error", err)
		return c.unavailableResult(fmt.Sprintf("L1 output scoring error: %v", err))
	}

	return result, nil
}

func (c *L1Client) doScore(ctx context.Context, req l1ScoreRequest) (*L1Result, error) {
	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	url := fmt.Sprintf("%s/api/agentd/v1/l1-score", c.baseURL)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("X-API-Key", c.apiKey)
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("L1 score request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("L1 score API returned %d: %s", resp.StatusCode, string(body))
	}

	var scoreResp l1ScoreResponse
	if err := json.Unmarshal(body, &scoreResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if !scoreResp.Success {
		return nil, fmt.Errorf("L1 score API error: %s", scoreResp.Error)
	}

	if scoreResp.Data == nil {
		return nil, fmt.Errorf("L1 score API returned nil data")
	}

	return scoreResp.Data, nil
}

// l1BatchScoreRequest is the wire format for the batched L1 endpoint.
type l1BatchScoreRequest struct {
	Type           string `json:"type"`
	Prompt         string `json:"prompt"`
	ContextSummary string `json:"context_summary,omitempty"`
	ModelID        string `json:"model_id,omitempty"`
}

type l1BatchScoreResponse struct {
	Success bool         `json:"success"`
	Data    *l1BatchData `json:"data"`
	Error   string       `json:"error,omitempty"`
}

type l1BatchData struct {
	Results []l1BatchItem `json:"results"`
}

type l1BatchItem struct {
	Index  int    `json:"index"`
	Level  string `json:"level"` // allow | low | medium | high | block
	Reason string `json:"reason"`
}

const batchPromptCommandCap = 256

func buildBatchPrompt(commands []string, sessionSummary string) string {
	var sb strings.Builder
	sb.WriteString("You are a security scorer. Score each command for risk (allow|low|medium|high|block).\n")
	sb.WriteString("Return JSON only, with no preamble:\n")
	sb.WriteString(`{"results": [{"index": 0, "level": "block", "reason": "..."}, ...]}` + "\n\n")
	if sessionSummary != "" {
		sb.WriteString("Session summary: ")
		sb.WriteString(sessionSummary)
		sb.WriteString("\n")
	}
	sb.WriteString("\nCommands:\n")
	for i, cmd := range commands {
		truncated := cmd
		if len(truncated) > batchPromptCommandCap {
			truncated = truncated[:batchPromptCommandCap] + "... [truncated]"
		}
		sb.WriteString(fmt.Sprintf("[%d] %s\n", i, truncated))
	}
	return sb.String()
}

// mapBatchLevelToL1 maps the LLM's batch vocabulary (allow|low|medium|high|block)
// back to L1Result.Level (low|medium|high|critical) so the gatekeeper's existing
// decision logic applies unchanged.
func mapBatchLevelToL1(level string) (string, float64) {
	switch level {
	case "allow":
		return "low", 0.1
	case "low":
		return "low", 0.2
	case "medium":
		return "medium", 0.5
	case "high":
		return "high", 0.8
	case "block":
		return "critical", 0.95
	default:
		return "medium", 0.5
	}
}

// ScoreBatch scores a list of commands in a single L1 call with cross-command
// context. Returns a parallel slice of *L1Result (same length and order as
// commands). Missing indices in the response stay nil; out-of-range indices
// are logged and skipped. The gatekeeper is responsible for the per-cmd
// fallback if this method returns an error.
func (c *L1Client) ScoreBatch(ctx context.Context, commands []string, sessionSummary string) ([]*L1Result, error) {
	if len(commands) == 0 {
		return []*L1Result{}, nil
	}
	if !c.available {
		return nil, fmt.Errorf("L1 unavailable: startup health check failed or was not run")
	}

	prompt := buildBatchPrompt(commands, sessionSummary)

	req := l1BatchScoreRequest{
		Type:           "command_batch",
		Prompt:         prompt,
		ContextSummary: sessionSummary,
		ModelID:        c.modelID,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal batch request: %w", err)
	}

	url := fmt.Sprintf("%s/api/agentd/v1/l1-score-batch", c.baseURL)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create batch request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		httpReq.Header.Set("X-API-Key", c.apiKey)
		httpReq.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("L1 batch score request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read batch response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("L1 batch score API returned %d: %s", resp.StatusCode, string(body))
	}

	var batchResp l1BatchScoreResponse
	if err := json.Unmarshal(body, &batchResp); err != nil {
		return nil, fmt.Errorf("parse batch response: %w", err)
	}

	if !batchResp.Success {
		return nil, fmt.Errorf("L1 batch score API error: %s", batchResp.Error)
	}

	if batchResp.Data == nil {
		return nil, fmt.Errorf("L1 batch score API returned nil data")
	}

	results := make([]*L1Result, len(commands))
	for _, item := range batchResp.Data.Results {
		if item.Index < 0 || item.Index >= len(commands) {
			slog.Warn("L1 batch result has out-of-range index, skipping",
				"index", item.Index,
				"batch_size", len(commands),
			)
			continue
		}
		mappedLevel, mappedScore := mapBatchLevelToL1(item.Level)
		reason := item.Reason
		if reason == "" {
			reason = fmt.Sprintf("L1 batch level=%s (index=%d)", item.Level, item.Index)
		}
		results[item.Index] = &L1Result{
			Score:  mappedScore,
			Level:  mappedLevel,
			Reason: reason,
		}
	}

	return results, nil
}
