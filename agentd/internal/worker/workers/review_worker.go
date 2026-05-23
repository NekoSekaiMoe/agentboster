package workers

import "log/slog"

// ReviewWorker handles security review (Phase 3).
type ReviewWorker struct{}

func NewReviewWorker() *ReviewWorker {
	return &ReviewWorker{}
}

func (w *ReviewWorker) Handle(payload any) {
	slog.Info("ReviewWorker: handling review", "payload_type", "%T")
	// Phase 3: L0/L1/L2 review
}
