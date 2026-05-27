package workers

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/clawless/agentd/internal/agent"
	"github.com/clawless/agentd/internal/clawless"
)

// MemoryWorker handles completed task memory extraction and task summary updates.
type MemoryWorker struct {
	client       *clawless.Client
	agentManager *agent.Manager
}

func NewMemoryWorker(client *clawless.Client, agentManager *agent.Manager) *MemoryWorker {
	return &MemoryWorker{client: client, agentManager: agentManager}
}

func (w *MemoryWorker) Handle(ctx context.Context, task *clawless.Task) {
	slog.Info("memory worker: task completed", "task_id", task.ID)

	summary, err := w.client.GetTaskSummary(ctx, task.ID)
	if err != nil {
		slog.Info("memory worker: no task summary found, extracting short-task memory", "task_id", task.ID)
		if err := w.agentManager.ExtractMemory(ctx, task); err != nil {
			slog.Warn("memory extraction failed", "task_id", task.ID, "error", err)
		}
		return
	}

	if summary == nil {
		return
	}

	slog.Info("memory worker: long-running task detected, updating summary", "task_id", task.ID)
	if _, err := w.client.UpdateTaskSummary(ctx, task.ID, clawless.TaskSummaryUpdate{
		Progress: strPtr(fmt.Sprintf("Completed: %s", truncateStr(task.Result, 200))),
	}); err != nil {
		slog.Error("memory worker: failed to update task summary", "task_id", task.ID, "error", err)
	}
}

func strPtr(s string) *string {
	return &s
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
