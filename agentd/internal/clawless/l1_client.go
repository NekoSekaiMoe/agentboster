package clawless

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
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
}

// L1Client calls the ClawLess /api/agentd/v1/l1-score endpoint for L1 scoring.
// Replaces the local L1 scorer (prompts + LLM call logic moved to clawless web layer).
type L1Client struct {
	baseURL    string
	modelID    string
	httpClient *http.Client
	apiKey     string
}

// NewL1Client creates a new L1 client that calls the ClawLess scoring API.
func NewL1Client(baseURL, modelID, apiKey string) *L1Client {
	return &L1Client{
		baseURL: baseURL,
		modelID: modelID,
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

type l1ScoreRequest struct {
	Type            string `json:"type"`
	Command         string `json:"command,omitempty"`
	Output          string `json:"output,omitempty"`
	WorkDir         string `json:"work_dir,omitempty"`
	ContextSummary  string `json:"context_summary,omitempty"`
	ModelID         string `json:"model_id"`
}

type l1ScoreResponse struct {
	Success bool      `json:"success"`
	Data    *L1Result `json:"data"`
	Error   string    `json:"error,omitempty"`
}

// Score evaluates a command for safety risks via the ClawLess API.
func (c *L1Client) Score(ctx context.Context, command, workDir, sessionSummary string) (*L1Result, error) {
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
		// Fail-open with medium score — L0 already caught obvious threats
		return &L1Result{Score: 0.3, Level: "medium", Reason: fmt.Sprintf("L1 scoring error: %v", err)}, nil
	}

	return result, nil
}

// ScoreOutput evaluates LLM output content for safety risks via the ClawLess API.
func (c *L1Client) ScoreOutput(ctx context.Context, output, sessionSummary string) (*L1Result, error) {
	req := l1ScoreRequest{
		Type:           "output",
		Output:         output,
		ContextSummary: sessionSummary,
		ModelID:        c.modelID,
	}

	result, err := c.doScore(ctx, req)
	if err != nil {
		slog.Error("L1 output scoring failed", "error", err)
		return &L1Result{Score: 0.3, Level: "medium", Reason: fmt.Sprintf("L1 output scoring error: %v", err)}, nil
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
