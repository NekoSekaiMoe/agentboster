package workers

import "log/slog"

// SandboxWorker handles sandbox lifecycle (Phase 2).
type SandboxWorker struct{}

func NewSandboxWorker() *SandboxWorker {
	return &SandboxWorker{}
}

func (w *SandboxWorker) Handle(payload any) {
	slog.Info("SandboxWorker: handling sandbox", "payload_type", "%T")
	// Phase 2: sandbox management
}
