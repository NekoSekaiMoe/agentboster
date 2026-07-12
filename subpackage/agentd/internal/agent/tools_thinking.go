//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ThoughtStage represents a phase in sequential thinking.
type ThoughtStage string

const (
	StageProblemDefinition ThoughtStage = "Problem Definition"
	StageResearch          ThoughtStage = "Research"
	StageAnalysis          ThoughtStage = "Analysis"
	StageSynthesis         ThoughtStage = "Synthesis"
	StageConclusion        ThoughtStage = "Conclusion"
)

// ThoughtRecord is a single recorded thought.
type ThoughtRecord struct {
	ID              string       `json:"id"`
	Thought         string       `json:"thought"`
	ThoughtNumber   int          `json:"thought_number"`
	TotalThoughts   int          `json:"total_thoughts"`
	NextNeeded      bool         `json:"next_thought_needed"`
	Stage           ThoughtStage `json:"stage"`
	Tags            []string     `json:"tags,omitempty"`
	Timestamp       string       `json:"timestamp"`
}

// ThinkingSession holds all thoughts for a named session.
type ThinkingSession struct {
	SessionID string           `json:"session_id"`
	Thoughts  []ThoughtRecord  `json:"thoughts"`
	CreatedAt string           `json:"created_at"`
	UpdatedAt string           `json:"updated_at"`
}

var thinkingSessions = struct {
	mu       sync.RWMutex
	sessions map[string]*ThinkingSession
}{
	sessions: make(map[string]*ThinkingSession),
}

func getOrCreateThinkingSession(sessionID string) *ThinkingSession {
	if sessionID == "" {
		sessionID = "default"
	}
	thinkingSessions.mu.Lock()
	defer thinkingSessions.mu.Unlock()

	if s, ok := thinkingSessions.sessions[sessionID]; ok {
		return s
	}
	now := time.Now().UTC().Format(time.RFC3339)
	s := &ThinkingSession{
		SessionID: sessionID,
		Thoughts:  make([]ThoughtRecord, 0),
		CreatedAt: now,
		UpdatedAt: now,
	}
	thinkingSessions.sessions[sessionID] = s
	return s
}

func registerProcessThought(registry *ToolRegistry, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "process_thought",
		Description: "Record and analyze a sequential thought with metadata. Break down complex problems into structured steps through stages: Problem Definition, Research, Analysis, Synthesis, Conclusion.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"thought": map[string]any{
					"type":        "string",
					"description": "The content of your thought",
				},
				"thought_number": map[string]any{
					"type":        "integer",
					"description": "Position in your sequence (1-based)",
				},
				"total_thoughts": map[string]any{
					"type":        "integer",
					"description": "Expected total thoughts in the sequence",
				},
				"next_thought_needed": map[string]any{
					"type":        "boolean",
					"description": "Whether more thoughts are needed after this one",
				},
				"stage": map[string]any{
					"type":        "string",
					"description": "The thinking stage: Problem Definition, Research, Analysis, Synthesis, or Conclusion",
				},
				"tags": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"description": "Keywords or categories for your thought",
				},
				"session_id": map[string]any{
					"type":        "string",
					"description": "Session to use. Omit for the default session.",
				},
			},
			"required": []string{"thought", "thought_number", "total_thoughts", "next_thought_needed", "stage"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Thought       string `json:"thought"`
			ThoughtNumber int    `json:"thought_number"`
			TotalThoughts int    `json:"total_thoughts"`
			NextNeeded    bool   `json:"next_thought_needed"`
			Stage         string `json:"stage"`
			Tags          []string `json:"tags"`
			SessionID     string `json:"session_id"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		session := getOrCreateThinkingSession(params.SessionID)
		thought := ThoughtRecord{
			ID:            fmt.Sprintf("thought-%d-%d", params.ThoughtNumber, time.Now().UnixMilli()),
			Thought:       params.Thought,
			ThoughtNumber: params.ThoughtNumber,
			TotalThoughts: params.TotalThoughts,
			NextNeeded:    params.NextNeeded,
			Stage:         ThoughtStage(params.Stage),
			Tags:          params.Tags,
			Timestamp:     time.Now().UTC().Format(time.RFC3339),
		}

		thinkingSessions.mu.Lock()
		session.Thoughts = append(session.Thoughts, thought)
		session.UpdatedAt = thought.Timestamp
		thinkingSessions.mu.Unlock()

		saveThinkingSession(ctx.SandboxPath, session)

		slog.Info("thought recorded",
			"session", session.SessionID,
			"number", params.ThoughtNumber,
			"stage", params.Stage,
		)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf("Thought %d/%d recorded (stage: %s, session: %s). %d total thoughts in session.",
				params.ThoughtNumber, params.TotalThoughts, params.Stage,
				session.SessionID, len(session.Thoughts)),
		}, nil
	})
}

func registerSequentialThink(registry *ToolRegistry, ctx *AgentContext) {
	registry.Register(ToolDefinition{
		Name:        "sequential_think",
		Description: "Scaffold a complete staged thinking sequence for a topic in one call. Generates one thought per cognitive stage (Problem Definition through Conclusion).",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"topic": map[string]any{
					"type":        "string",
					"description": "The topic or question to think through",
				},
				"num_thoughts": map[string]any{
					"type":        "integer",
					"description": "Number of thoughts to generate (3-5, default: 5)",
				},
				"session_id": map[string]any{
					"type":        "string",
					"description": "Session to use. Omit for the default session.",
				},
			},
			"required": []string{"topic"},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			Topic      string `json:"topic"`
			NumThoughts int    `json:"num_thoughts"`
			SessionID  string `json:"session_id"`
		}
		if err := json.Unmarshal(args, &params); err != nil {
			return &ToolResult{Success: false, Error: err.Error()}, nil
		}

		if params.NumThoughts <= 0 || params.NumThoughts > 5 {
			params.NumThoughts = 5
		}

		stages := []ThoughtStage{
			StageProblemDefinition,
			StageResearch,
			StageAnalysis,
			StageSynthesis,
			StageConclusion,
		}

		prompts := map[ThoughtStage]string{
			StageProblemDefinition: "Define the problem: What exactly needs to be decided or solved regarding \"%s\"?",
			StageResearch:          "Research options for \"%s\": What are the available choices and their tradeoffs?",
			StageAnalysis:          "Analyze \"%s\": Examine each option in detail. Pros, cons, risks?",
			StageSynthesis:         "Synthesize insights about \"%s\": How do the pieces fit together?",
			StageConclusion:        "Draw a conclusion about \"%s\": What is the recommendation?",
		}

		session := getOrCreateThinkingSession(params.SessionID)
		count := params.NumThoughts
		if count > len(stages) {
			count = len(stages)
		}

		for i := 0; i < count; i++ {
			stage := stages[i]
			thought := ThoughtRecord{
				ID:            fmt.Sprintf("seq-%d-%d", i+1, time.Now().UnixMilli()),
				Thought:       fmt.Sprintf(prompts[stage], params.Topic),
				ThoughtNumber: i + 1,
				TotalThoughts: count,
				NextNeeded:    i < count-1,
				Stage:         stage,
				Tags:          []string{params.Topic},
				Timestamp:     time.Now().UTC().Format(time.RFC3339),
			}

			thinkingSessions.mu.Lock()
			session.Thoughts = append(session.Thoughts, thought)
			session.UpdatedAt = thought.Timestamp
			thinkingSessions.mu.Unlock()
		}

		saveThinkingSession(ctx.SandboxPath, session)

		return &ToolResult{
			Success: true,
			Data: fmt.Sprintf("Sequential thinking scaffolded: %d stages for topic \"%s\" (session: %s). Use process_thought to add your own analysis at each stage.",
				count, params.Topic, session.SessionID),
		}, nil
	})
}

func registerGetThinkingHistory(registry *ToolRegistry) {
	registry.Register(ToolDefinition{
		Name:        "get_thinking_history",
		Description: "Read recorded thoughts for a thinking session.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"session_id": map[string]any{
					"type":        "string",
					"description": "Session to read. Omit for the default session.",
				},
			},
		},
	}, func(toolCtx context.Context, args json.RawMessage) (*ToolResult, error) {
		var params struct {
			SessionID string `json:"session_id"`
		}
		json.Unmarshal(args, &params)

		session := getOrCreateThinkingSession(params.SessionID)
		thinkingSessions.mu.RLock()
		data, _ := json.MarshalIndent(session, "", "  ")
		thinkingSessions.mu.RUnlock()

		return &ToolResult{Success: true, Data: string(data)}, nil
	})
}

func saveThinkingSession(sandboxPath string, session *ThinkingSession) {
	if sandboxPath == "" {
		return
	}
	dir := filepath.Join(sandboxPath, "workspace", ".thinking")
	os.MkdirAll(dir, 0o755)

	thinkingSessions.mu.RLock()
	data, _ := json.MarshalIndent(session, "", "  ")
	thinkingSessions.mu.RUnlock()

	path := filepath.Join(dir, session.SessionID+".json")
	if err := os.WriteFile(path, data, 0o640); err != nil {
		slog.Warn("failed to save thinking session", "error", err)
	}
}
