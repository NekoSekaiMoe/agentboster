package l1_scorer

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

	"github.com/clawless/agentd/internal/config"
)

// L1Result is the result of an L1 security score.
type L1Result struct {
	Score  float64 `json:"score"`
	Level  string  `json:"level"` // low, medium, high
	Reason string  `json:"reason"`
}

// L1Scorer evaluates command safety using an LLM (replicating Manboster Hachimi).
type L1Scorer struct {
	provider string // "local_ollama", "remote", "clawless_proxy"
	endpoint string
	model    string
	apiKey   string
	client   *http.Client
}

// NewL1Scorer creates a new L1 scorer from config.
func NewL1Scorer(cfg *config.SecurityConfig) *L1Scorer {
	return &L1Scorer{
		provider: cfg.L1Provider,
		endpoint: cfg.L1Endpoint,
		model:    cfg.L1Model,
		apiKey:   cfg.L1APIKey,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Score evaluates a command and returns a safety score.
func (s *L1Scorer) Score(ctx context.Context, command, workDir, sessionSummary string) (*L1Result, error) {
	prompt := buildPrompt(command, workDir, sessionSummary)

	var result *L1Result
	var err error

	switch s.provider {
	case "local_ollama":
		result, err = s.scoreOllama(ctx, prompt)
	case "remote":
		result, err = s.scoreRemote(ctx, prompt)
	case "clawless_proxy":
		result, err = s.scoreClawLessProxy(ctx, prompt)
	default:
		// If no L1 provider configured, return safe by default
		slog.Warn("L1 scorer: unknown provider, defaulting to safe", "provider", s.provider)
		return &L1Result{Score: 0, Level: "low", Reason: "no L1 provider configured"}, nil
	}

	if err != nil {
		slog.Error("L1 scoring failed", "error", err)
		// Fail-open with warning — L0 already caught obvious threats
		return &L1Result{Score: 0.3, Level: "medium", Reason: fmt.Sprintf("L1 scoring error: %v", err)}, nil
	}

	return result, nil
}

func buildPrompt(command, workDir, sessionSummary string) string {
	prompt := SafetyScorerPrompt
	prompt = strings.ReplaceAll(prompt, "{{command}}", command)
	prompt = strings.ReplaceAll(prompt, "{{work_dir}}", workDir)
	prompt = strings.ReplaceAll(prompt, "{{context_summary}}", sessionSummary)
	return prompt
}

// scoreOllama sends the prompt to a local Ollama instance.
func (s *L1Scorer) scoreOllama(ctx context.Context, prompt string) (*L1Result, error) {
	body := map[string]any{
		"model":  s.model,
		"prompt": prompt,
		"stream": false,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	// Ollama returns {"response": "..."}
	var ollamaResp struct {
		Response string `json:"response"`
	}
	if err := json.Unmarshal(respBody, &ollamaResp); err != nil {
		return nil, fmt.Errorf("parse ollama response: %w", err)
	}

	return parseScoreResponse(ollamaResp.Response)
}

// scoreRemote sends the prompt to a remote OpenAI-compatible API.
func (s *L1Scorer) scoreRemote(ctx context.Context, prompt string) (*L1Result, error) {
	body := map[string]any{
		"model": s.model,
		"messages": []map[string]string{
			{"role": "system", "content": "You are a security scorer. Respond only with JSON."},
			{"role": "user", "content": prompt},
		},
		"temperature": 0.1,
		"max_tokens":  256,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+s.apiKey)
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("remote request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	// Parse OpenAI response format
	var remoteResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(respBody, &remoteResp); err != nil {
		return nil, fmt.Errorf("parse remote response: %w", err)
	}

	if len(remoteResp.Choices) == 0 {
		return nil, fmt.Errorf("no choices in remote response")
	}

	return parseScoreResponse(remoteResp.Choices[0].Message.Content)
}

// scoreClawLessProxy sends the prompt through ClawLess LLM proxy.
func (s *L1Scorer) scoreClawLessProxy(ctx context.Context, prompt string) (*L1Result, error) {
	// This uses the ClawLess /api/agentd/v1/llm-proxy endpoint
	// For now, fall back to remote with the clawless endpoint
	return s.scoreRemote(ctx, prompt)
}

// parseScoreResponse extracts L1Result from LLM response text.
func parseScoreResponse(text string) (*L1Result, error) {
	// Extract JSON from response (may be wrapped in markdown code blocks)
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)

	var result L1Result
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		// Try to extract JSON from within the text
		start := strings.Index(text, "{")
		end := strings.LastIndex(text, "}")
		if start >= 0 && end > start {
			if err := json.Unmarshal([]byte(text[start:end+1]), &result); err != nil {
				return nil, fmt.Errorf("parse score JSON: %w (response: %s)", err, text[:min(len(text), 200)])
			}
		} else {
			return nil, fmt.Errorf("no JSON found in response: %s", text[:min(len(text), 200)])
		}
	}

	// Validate and clamp
	if result.Score < 0 {
		result.Score = 0
	}
	if result.Score > 1 {
		result.Score = 1
	}

	// Auto-derive level if not set
	if result.Level == "" {
		switch {
		case result.Score < 0.3:
			result.Level = "low"
		case result.Score < 0.7:
			result.Level = "medium"
		default:
			result.Level = "high"
		}
	}

	return &result, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
