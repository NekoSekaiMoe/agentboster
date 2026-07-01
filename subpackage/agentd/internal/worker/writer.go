package worker

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

type writeRequest struct {
	reviewLogs   []clawless.ReviewLog
	notification *clawless.Notification
	result       chan error
}

// WriterActor handles all ClawLess API writes through a single goroutine.
// Serializes writes to provide backpressure and avoid API contention.
// Based on Asika's writer actor pattern.
type WriterActor struct {
	requests chan writeRequest
	stop     chan struct{}
	client   *clawless.Client
	restarts int
}

// NewWriterActor creates and starts a writer goroutine.
func NewWriterActor(client *clawless.Client, bufferSize int) *WriterActor {
	w := &WriterActor{
		requests: make(chan writeRequest, bufferSize),
		stop:     make(chan struct{}),
		client:   client,
	}
	go w.run()
	slog.Info("writer actor started", "buffer_size", bufferSize)
	return w
}

func (w *WriterActor) run() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("writer actor panic recovered", "error", r, "restarts", w.restarts)
			if w.restarts < 3 {
				w.restarts++
				go w.run()
			}
		}
	}()
	for {
		select {
		case req := <-w.requests:
			func() {
				defer func() {
					if r := recover(); r != nil {
						slog.Error("write request panic recovered", "error", r)
						req.result <- fmt.Errorf("write panic: %v", r)
					}
				}()
				ctx := context.Background()
				if req.notification != nil {
					req.result <- w.client.CreateNotification(ctx, req.notification)
					return
				}
				if len(req.reviewLogs) > 0 {
					req.result <- w.client.WriteReviewLogs(ctx, req.reviewLogs)
					return
				}
				req.result <- nil
			}()
		case <-w.stop:
			slog.Info("writer actor stopped")
			return
		}
	}
}

// WriteReviewLogs submits review logs for async writing.
func (w *WriterActor) WriteReviewLogs(logs []clawless.ReviewLog) error {
	req := writeRequest{
		reviewLogs: logs,
		result:     make(chan error, 1),
	}
	select {
	case w.requests <- req:
		select {
		case err := <-req.result:
			return err
		case <-w.stop:
			return fmt.Errorf("writer actor stopped")
		}
	case <-w.stop:
		return fmt.Errorf("writer actor stopped")
	}
}

// WriteNotification submits a notification for async writing.
func (w *WriterActor) WriteNotification(n *clawless.Notification) error {
	req := writeRequest{
		notification: n,
		result:       make(chan error, 1),
	}
	select {
	case w.requests <- req:
		select {
		case err := <-req.result:
			return err
		case <-w.stop:
			return fmt.Errorf("writer actor stopped")
		}
	case <-w.stop:
		return fmt.Errorf("writer actor stopped")
	}
}

// Stop gracefully stops the writer goroutine.
func (w *WriterActor) Stop() {
	close(w.stop)
}
