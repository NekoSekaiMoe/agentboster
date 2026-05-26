package clawless

import "time"

// TaskStatus represents the status of a task.
type TaskStatus string

const (
	TaskPending    TaskStatus = "pending"
	TaskReviewing  TaskStatus = "reviewing"
	TaskRunning    TaskStatus = "running"
	TaskCompleted  TaskStatus = "completed"
	TaskFailed     TaskStatus = "failed"
	TaskCancelled  TaskStatus = "cancelled"
)

// Task represents an agent task.
type Task struct {
	ID           string            `json:"id"`
	AgentID      string            `json:"agent_id"`
	SessionID    string            `json:"session_id"`
	Command      string            `json:"command"`
	SandboxType  string            `json:"sandbox_type"`
	SandboxID    string            `json:"sandbox_id"`
	SystemPrompt string            `json:"system_prompt,omitempty"`
	Env          map[string]string `json:"env"`
	Timeout      int               `json:"timeout"`
	Status       TaskStatus        `json:"status"`
	Result       string            `json:"result"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
}

// Session represents a chat session.
type Session struct {
	ID        string       `json:"id"`
	AgentID   string       `json:"agent_id"`
	Messages  []Message    `json:"messages"`
	Summary   string       `json:"summary"`
	KeyFacts  []KeyFact    `json:"key_facts"`
	CreatedAt time.Time    `json:"created_at"`
	UpdatedAt time.Time    `json:"updated_at"`
}

// Message represents a chat message.
type Message struct {
	Role    string    `json:"role"`
	Content string    `json:"content"`
	Time    time.Time `json:"time"`
}

// KeyFact represents a structured fact extracted from a session.
type KeyFact struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ReviewLog represents a security review record.
type ReviewLog struct {
	TaskID    string    `json:"task_id"`
	Command   string    `json:"command"`
	Level     string    `json:"level"`
	Score     float64   `json:"score"`
	Decision  string    `json:"decision"`
	Reason    string    `json:"reason"`
	Timestamp time.Time `json:"timestamp"`
}

// Memory represents an agent memory entry.
type Memory struct {
	ID          string    `json:"id"`
	AgentID     string    `json:"agent_id"`
	Key         string    `json:"key"`
	Value       string    `json:"value"`
	Source      string    `json:"source"`
	CreatedAt   time.Time `json:"created_at"`
	AccessCount int       `json:"access_count"`
}

// AgentConfig represents agent configuration from ClawLess.
type AgentConfig struct {
	AgentID            string   `json:"agent_id"`
	DefaultSandbox     string   `json:"default_sandbox"`
	AvailableSandboxes []string `json:"available_sandboxes"`
	L1Provider         string   `json:"l1_provider"`
	L1Model            string   `json:"l1_model"`
	L1Endpoint         string   `json:"l1_endpoint"`
	MaxParallelSubAgents int     `json:"max_parallel_sub_agents"`
	AllowedPaths       []string `json:"allowed_paths"`
	BlockedPaths       []string `json:"blocked_paths"`
	MemoryEnabled      bool     `json:"memory_enabled"`
}

// SandboxMeta represents sandbox metadata.
type SandboxMeta struct {
	ID         string `json:"id"`
	AgentID    string `json:"agent_id"`
	Type       string `json:"type"`
	Path       string `json:"path"`
	Status     string `json:"status"`
	Persistent bool   `json:"persistent"`
}

// L0Rule represents a level-0 security rule.
type L0Rule struct {
	ID      string `json:"id"`
	Pattern string `json:"pattern"`
	Type    string `json:"type"`
	Action  string `json:"action"`
	Scope   string `json:"scope"`
}

// LLMProxyRequest represents a request to the LLM proxy.
type LLMProxyRequest struct {
	Model    string         `json:"model"`
	Messages []Message      `json:"messages"`
	Stream   bool           `json:"stream"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// HealthResponse represents the health check response.
type HealthResponse struct {
	Status    string    `json:"status"`
	Timestamp time.Time `json:"timestamp"`
	Version   string    `json:"version"`
	Uptime    string    `json:"uptime"`
}

// Notification represents a notification to be sent to the user via ClawLess.
type Notification struct {
	AgentID  string         `json:"agent_id"`
	TaskID   string         `json:"task_id"`
	Type     string         `json:"type"`
	Title    string         `json:"title"`
	Message  string         `json:"message"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// Decision represents a recorded decision in a task summary.
type Decision struct {
	Timestamp    time.Time `json:"timestamp"`
	Description  string    `json:"description"`
	Reason       string    `json:"reason"`
	Alternatives []string  `json:"alternatives"`
}

// TaskSummary represents a long-running task's running state.
type TaskSummary struct {
	ID           string     `json:"id"`
	TaskID       string     `json:"task_id"`
	AgentID      string     `json:"agent_id"`
	SessionID    string     `json:"session_id"`
	Status       string     `json:"status"`
	Progress     string     `json:"progress"`
	Decisions    []Decision `json:"decisions"`
	Pending      []string   `json:"pending"`
	KnownIssues  []string   `json:"known_issues"`
	LastUpdated  time.Time  `json:"last_updated"`
	CreatedAt    time.Time  `json:"created_at"`
}

// TaskTidyReport holds suggestions from a tidy scan.
type TaskTidyReport struct {
	TaskID          string   `json:"task_id"`
	Suggestions     []string `json:"suggestions"`
	MergeIDs        []string `json:"merge_ids,omitempty"`
	DeleteIDs       []string `json:"delete_ids,omitempty"`
	ResolvedPending []string `json:"resolved_pending,omitempty"`
	ResolvedIssues  []string `json:"resolved_issues,omitempty"`
}

// TaskSummaryUpdate is the request body for updating a task summary.
type TaskSummaryUpdate struct {
	Progress     *string    `json:"progress,omitempty"`
	Decisions    []Decision `json:"decisions,omitempty"`
	Pending      []string   `json:"pending,omitempty"`
	KnownIssues  []string   `json:"known_issues,omitempty"`
}

// APIResponse is a generic API response wrapper.
type APIResponse[T any] struct {
	Success bool   `json:"success"`
	Data    T      `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}
