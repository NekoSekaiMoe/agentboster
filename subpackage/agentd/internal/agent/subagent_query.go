//go:build linux

package agent

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// SubagentInfo is the external view of a subagent returned by the query API.
type SubagentInfo struct {
	ID        string `json:"id"`
	Task      string `json:"task"`
	Status    string `json:"status"`
	Summary   string `json:"summary,omitempty"`
	Error     string `json:"error,omitempty"`
	SessionID string `json:"session_id,omitempty"`
	AgentID   string `json:"agent_id,omitempty"`
	Sandbox   string `json:"sandbox_type,omitempty"`
}

// SubagentMessage is a single message in a subagent's conversation.
type SubagentMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"tool_name,omitempty"`
	ToolInput string `json:"tool_input,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
	Timestamp int64  `json:"timestamp"`
}

// SubagentBatchInfo is the external view of a subagent batch.
type SubagentBatchInfo struct {
	BatchID   string         `json:"batch_id"`
	Status    string         `json:"status"`
	Total     int            `json:"total"`
	Running   int            `json:"running"`
	Completed int            `json:"completed"`
	Failed    int            `json:"failed"`
	Jobs      []SubagentInfo `json:"jobs"`
}

// subagentMessages tracks per-subagent conversation messages. The
// subagent loop appends messages here as they occur, and the query API
// reads them. Protected by its own mutex to avoid contention with the
// main registry lock.
var subagentMessages = struct {
	mu       sync.RWMutex
	messages map[string][]SubagentMessage
	cancels  map[string]context.CancelFunc
}{
	messages: make(map[string][]SubagentMessage),
	cancels:  make(map[string]context.CancelFunc),
}

// RecordSubagentMessage appends a message to a subagent's conversation log.
func RecordSubagentMessage(subagentID string, msg SubagentMessage) {
	if msg.Timestamp == 0 {
		msg.Timestamp = time.Now().UnixMilli()
	}
	subagentMessages.mu.Lock()
	subagentMessages.messages[subagentID] = append(subagentMessages.messages[subagentID], msg)
	subagentMessages.mu.Unlock()
}

// RegisterSubagentCancel stores a cancel function for a running subagent.
func RegisterSubagentCancel(subagentID string, cancel context.CancelFunc) {
	subagentMessages.mu.Lock()
	subagentMessages.cancels[subagentID] = cancel
	subagentMessages.mu.Unlock()
}

// GetSubagentInfo returns info about a specific subagent, or nil if not found.
func GetSubagentInfo(id string) *SubagentInfo {
	subagentRegistry.mu.RLock()
	task, exists := subagentRegistry.agents[id]
	result, hasResult := subagentRegistry.results[id]
	summary, hasSummary := subagentRegistry.summaries[id]
	subagentRegistry.mu.RUnlock()

	if !exists {
		return nil
	}

	info := &SubagentInfo{
		ID:     id,
		Task:   task.Command,
		Status: string(task.Status),
	}
	if task.AgentID != "" {
		info.AgentID = task.AgentID
	}
	if task.SessionID != "" {
		info.SessionID = task.SessionID
	}
	if task.SandboxType != "" {
		info.Sandbox = task.SandboxType
	}
	if hasSummary {
		info.Summary = summary
	} else if hasResult {
		info.Summary = truncate(result, 500)
	}
	if task.Status == "failed" {
		info.Error = task.Result
	}

	return info
}

// GetSubagentMessages returns the conversation messages of a subagent.
func GetSubagentMessages(id string) []SubagentMessage {
	subagentMessages.mu.RLock()
	msgs, ok := subagentMessages.messages[id]
	subagentMessages.mu.RUnlock()

	if !ok || len(msgs) == 0 {
		return nil
	}

	out := make([]SubagentMessage, len(msgs))
	copy(out, msgs)
	return out
}

// ListSubagents returns all known subagents, optionally filtered by session.
func ListSubagents(sessionID string) []SubagentInfo {
	subagentRegistry.mu.RLock()
	defer subagentRegistry.mu.RUnlock()

	infos := make([]SubagentInfo, 0, len(subagentRegistry.agents))
	for id, task := range subagentRegistry.agents {
		if sessionID != "" && task.SessionID != sessionID {
			continue
		}
		info := SubagentInfo{
			ID:     id,
			Task:   task.Command,
			Status: string(task.Status),
		}
		if s, ok := subagentRegistry.summaries[id]; ok {
			info.Summary = s
		}
		infos = append(infos, info)
	}
	return infos
}

// AbortSubagent cancels a running subagent.
func AbortSubagent(id string) error {
	subagentMessages.mu.RLock()
	cancel, ok := subagentMessages.cancels[id]
	subagentMessages.mu.RUnlock()

	if !ok {
		return fmt.Errorf("subagent %s not found or not running", id)
	}
	cancel()
	return nil
}

// GetSubagentBatch returns batch info. Currently uses the in-memory registry
// to group subagents by their parent session prefix. A proper batch tracking
// system would maintain explicit batch → job mappings.
func GetSubagentBatch(batchID string) *SubagentBatchInfo {
	subagentRegistry.mu.RLock()
	defer subagentRegistry.mu.RUnlock()

	batch := &SubagentBatchInfo{
		BatchID: batchID,
		Jobs:    make([]SubagentInfo, 0),
	}

	for id, task := range subagentRegistry.agents {
		if task.SessionID == "" {
			continue
		}
		info := SubagentInfo{
			ID:     id,
			Task:   task.Command,
			Status: string(task.Status),
		}
		if s, ok := subagentRegistry.summaries[id]; ok {
			info.Summary = s
		}
		batch.Jobs = append(batch.Jobs, info)
		batch.Total++
		switch task.Status {
		case "running":
			batch.Running++
		case "completed":
			batch.Completed++
		case "failed":
			batch.Failed++
		}
	}

	if batch.Total == 0 {
		return nil
	}

	if batch.Running > 0 {
		batch.Status = "running"
	} else if batch.Failed > 0 && batch.Completed == 0 {
		batch.Status = "failed"
	} else {
		batch.Status = "completed"
	}

	return batch
}

// CancelSubagentBatch cancels all running subagents.
func CancelSubagentBatch(batchID string) (int, error) {
	subagentMessages.mu.RLock()
	cancels := make(map[string]context.CancelFunc)
	for id, cancel := range subagentMessages.cancels {
		cancels[id] = cancel
	}
	subagentMessages.mu.RUnlock()

	count := 0
	for _, cancel := range cancels {
		cancel()
		count++
	}
	if count == 0 {
		return 0, fmt.Errorf("no running subagents found for batch %s", batchID)
	}
	return count, nil
}
