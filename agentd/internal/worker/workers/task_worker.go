package workers

import "log/slog"

// TaskWorker handles task execution (Phase 2).
type TaskWorker struct{}

func NewTaskWorker() *TaskWorker {
	return &TaskWorker{}
}

func (w *TaskWorker) Handle(payload any) {
	slog.Info("TaskWorker: handling task", "payload_type", "%T")
	// Phase 2: sandbox execution
}
