package workers

import "log/slog"

// CleanupWorker handles resource cleanup.
type CleanupWorker struct{}

func NewCleanupWorker() *CleanupWorker {
	return &CleanupWorker{}
}

func (w *CleanupWorker) Handle(payload any) {
	slog.Info("CleanupWorker: cleaning up", "payload_type", "%T")
	// Cleanup: destroy non-persistent sandboxes, trim cache
}
