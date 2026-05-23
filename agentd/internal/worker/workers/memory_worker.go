package workers

import "log/slog"

// MemoryWorker handles memory extraction (Phase 5).
type MemoryWorker struct{}

func NewMemoryWorker() *MemoryWorker {
	return &MemoryWorker{}
}

func (w *MemoryWorker) Handle(payload any) {
	slog.Info("MemoryWorker: extracting memory", "payload_type", "%T")
	// Phase 5: LLM-based memory extraction
}
