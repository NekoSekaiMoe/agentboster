package clawless

import "time"

// TaskStatus represents the status of a task.
type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskReviewing TaskStatus = "reviewing"
	TaskRunning   TaskStatus = "running"
	TaskCompleted TaskStatus = "completed"
	TaskFailed    TaskStatus = "failed"
	TaskCancelled TaskStatus = "cancelled"
)

// Task represents an agent task.
type Task struct {
	ID           string            `json:"id"`
	AgentID      string            `json:"agent_id"`
	SessionID    string            `json:"session_id"`
	UserID       string            `json:"user_id"`
	Roles        []string          `json:"roles"`
	Source       BotSource         `json:"source"`
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
	ID        string    `json:"id"`
	AgentID   string    `json:"agent_id"`
	UserID    string    `json:"user_id"`
	Roles     []string  `json:"roles"`
	Source    BotSource `json:"source"`
	Messages  []Message `json:"messages"`
	Summary   string    `json:"summary"`
	KeyFacts  []KeyFact `json:"key_facts"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
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
	UserID    string    `json:"user_id,omitempty"`
	Roles     []string  `json:"roles,omitempty"`
	Command   string    `json:"command"`
	Level     string    `json:"level"`
	Score     float64   `json:"score"`
	Decision  string    `json:"decision"`
	Reason    string    `json:"reason"`
	Timestamp time.Time `json:"timestamp"`
}

// ToolActivityLog records a model-requested tool call and its full result.
type ToolActivityLog struct {
	TaskID      string    `json:"task_id,omitempty"`
	SessionID   string    `json:"session_id,omitempty"`
	AgentID     string    `json:"agent_id"`
	UserID      string    `json:"user_id,omitempty"`
	Roles       []string  `json:"roles,omitempty"`
	Source      BotSource `json:"source,omitempty"`
	SandboxID   string    `json:"sandbox_id,omitempty"`
	Model       string    `json:"model,omitempty"`
	Step        int       `json:"step,omitempty"`
	ToolCallID  string    `json:"tool_call_id,omitempty"`
	ToolName    string    `json:"tool_name"`
	Action      string    `json:"action"`
	Target      string    `json:"target,omitempty"`
	Arguments   any       `json:"arguments,omitempty"`
	Result      any       `json:"result,omitempty"`
	OutputText  string    `json:"output_text,omitempty"`
	Success     bool      `json:"success"`
	Error       string    `json:"error,omitempty"`
	DurationMs  int64     `json:"duration_ms,omitempty"`
	StartedAt   time.Time `json:"started_at"`
	CompletedAt time.Time `json:"completed_at,omitempty"`
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

// KnowledgeSearchResult represents one retrieved knowledge-base chunk.
type KnowledgeSearchResult struct {
	ChunkID                 string  `json:"chunkId"`
	KnowledgeBaseID         string  `json:"knowledgeBaseId"`
	KnowledgeBaseName       string  `json:"knowledgeBaseName"`
	KnowledgeBasePriority   int     `json:"knowledgeBasePriority"`
	KnowledgeBaseVisibility string  `json:"knowledgeBaseVisibility"`
	DocumentID              string  `json:"documentId"`
	DocumentTitle           string  `json:"documentTitle"`
	DocumentSourceType      string  `json:"documentSourceType"`
	DocumentSourceURI       string  `json:"documentSourceUri"`
	DocumentCreatedAt       string  `json:"documentCreatedAt"`
	Content                 string  `json:"content"`
	VectorScore             float64 `json:"vectorScore"`
	KeywordScore            float64 `json:"keywordScore"`
	FinalScore              float64 `json:"finalScore"`
}

// AgentConfig represents agent configuration from ClawLess.
//
// P1.1: Extended with per-agent sandbox resource knobs, MCP bridge
// toggle, multi-node filter, and egress allowlist. All new fields are
// optional (pointer or empty-slice semantics) — a daemon that hasn't
// been upgraded will simply ignore them when unmarshalling.
type AgentConfig struct {
	AgentID              string   `json:"agent_id"`
	DefaultSandbox       string   `json:"default_sandbox"`
	AvailableSandboxes   []string `json:"available_sandboxes"`
	L1Provider           string   `json:"l1_provider"`
	L1Model              string   `json:"l1_model"`
	L1Endpoint           string   `json:"l1_endpoint"`
	MaxParallelSubAgents int      `json:"max_parallel_sub_agents"`
	AllowedPaths         []string `json:"allowed_paths"`
	BlockedPaths         []string `json:"blocked_paths"`
	MemoryEnabled        bool     `json:"memory_enabled"`

	// P1.1: per-agent sandbox resource overrides.
	SandboxCPU         *float64 `json:"sandbox_cpu,omitempty"`
	SandboxMem         string   `json:"sandbox_mem,omitempty"`
	SandboxPids        *int     `json:"sandbox_pids,omitempty"`
	SandboxDisk        string   `json:"sandbox_disk,omitempty"`
	SandboxBlkioWeight *uint16  `json:"sandbox_blkio_weight,omitempty"`

	// P1.2: MCP bridge toggle and server allowlist.
	MCPEnabled bool     `json:"mcp_enabled"`
	MCPServers []string `json:"mcp_servers,omitempty"`

	// P3.1: multi-node filter — restricts which daemon nodes this agent
	// is allowed to run on. Empty = any node.
	AllowedNodes []string `json:"allowed_nodes,omitempty"`

	// P2.2: outbound egress allowlist (glob). Empty = unrestricted
	// when sandbox network is on.
	EgressAllowlist []string `json:"egress_allowlist,omitempty"`

	// P1.1: use agent-specific L0 rules (sourced from agentL0Rules
	// table) in addition to the global DefaultPresets.
	CustomL0Rules bool `json:"custom_l0_rules"`
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

type BotSource struct {
	Type      string `json:"type,omitempty"`
	Adapter   string `json:"adapter,omitempty"`
	Origin    string `json:"origin,omitempty"`
	ThreadID  string `json:"threadId,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	UserID    string `json:"userId,omitempty"`
	UserName  string `json:"userName,omitempty"`
}

type BotCapabilities struct {
	Delete   bool `json:"delete"`
	Edit     bool `json:"edit"`
	Reaction bool `json:"reaction"`
}

type BotCapabilitiesResponse struct {
	Adapter      string          `json:"adapter"`
	ChatID       string          `json:"chat_id"`
	ThreadID     string          `json:"thread_id"`
	Capabilities BotCapabilities `json:"capabilities"`
}

type NotificationSendResponse struct {
	Channel   string `json:"channel"`
	MessageID string `json:"message_id"`
}

// Decision represents a recorded decision in a task summary.
type Decision struct {
	ID           string    `json:"id,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
	Description  string    `json:"description"`
	Reason       string    `json:"reason"`
	Alternatives []string  `json:"alternatives"`
}

// TaskSummary represents a long-running task's running state.
type TaskSummary struct {
	ID          string     `json:"id"`
	TaskID      string     `json:"task_id"`
	AgentID     string     `json:"agent_id"`
	SessionID   string     `json:"session_id"`
	Status      string     `json:"status"`
	Progress    string     `json:"progress"`
	Decisions   []Decision `json:"decisions"`
	Pending     []string   `json:"pending"`
	KnownIssues []string   `json:"known_issues"`
	LastUpdated time.Time  `json:"last_updated"`
	CreatedAt   time.Time  `json:"created_at"`
}

// TaskMemoryRequest asks ClawLess to handle post-task memory extraction.
type TaskMemoryRequest struct {
	Status    string `json:"status"`
	Result    string `json:"result"`
	SessionID string `json:"session_id,omitempty"`
	AgentID   string `json:"agent_id,omitempty"`
	Command   string `json:"command,omitempty"`
	UserID    string `json:"user_id,omitempty"`
}

// Workspace represents a project-level organization unit.
type Workspace struct {
	ID          string    `json:"id"`
	ProjectID   string    `json:"project_id"`
	AgentID     string    `json:"agent_id"`
	Name        string    `json:"name"`
	SandboxID   string    `json:"sandbox_id"`
	SandboxType string    `json:"sandbox_type"`
	Status      string    `json:"status"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// UploadResult is the response from a file upload.
type UploadResult struct {
	URL       string    `json:"url"`
	BlobPath  string    `json:"blob_path"`
	ExpiresAt time.Time `json:"expires_at"`
	Size      int64     `json:"size"`
}

// GitInfo holds git operation results for the completion notification.
type GitInfo struct {
	CommitHash    string `json:"commit_hash"`
	CommitMessage string `json:"commit_message"`
	CompareURL    string `json:"compare_url"`
	FilesChanged  int    `json:"files_changed"`
	Insertions    int    `json:"insertions"`
	Deletions     int    `json:"deletions"`
}

// APIResponse is a generic API response wrapper.
type APIResponse[T any] struct {
	Success bool   `json:"success"`
	Data    T      `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}
