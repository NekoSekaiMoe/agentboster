package cache

import (
	"log/slog"
	"sync"
	"time"
)

// RetryQueue holds failed operations for retry with exponential backoff.
type RetryQueue struct {
	mu       sync.Mutex
	items    []RetryItem
	maxAttempts int
	stopCh   chan struct{}
}

// RetryItem represents a failed operation to retry.
type RetryItem struct {
	ID          string
	Operation   string
	Payload     any
	Attempts    int
	NextRetry   time.Time
	MaxAttempts int
}

// NewRetryQueue creates a new retry queue.
func NewRetryQueue(maxAttempts int) *RetryQueue {
	return &RetryQueue{
		items:       make([]RetryItem, 0),
		maxAttempts: maxAttempts,
		stopCh:      make(chan struct{}),
	}
}

// Start begins the retry loop.
func (q *RetryQueue) Start(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				q.processRetries()
			case <-q.stopCh:
				return
			}
		}
	}()
}

// Stop stops the retry loop.
func (q *RetryQueue) Stop() {
	close(q.stopCh)
}

// Add adds a failed operation to the retry queue.
func (q *RetryQueue) Add(id, operation string, payload any) {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Deduplicate by ID
	for _, item := range q.items {
		if item.ID == id {
			return
		}
	}

	q.items = append(q.items, RetryItem{
		ID:          id,
		Operation:   operation,
		Payload:     payload,
		Attempts:    0,
		NextRetry:   time.Now().Add(time.Second),
		MaxAttempts: q.maxAttempts,
	})
}

// processRetries processes pending retries with exponential backoff.
func (q *RetryQueue) processRetries() {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()
	remaining := make([]RetryItem, 0, len(q.items))

	for _, item := range q.items {
		if item.Attempts >= item.MaxAttempts {
			slog.Error("retry max attempts reached",
				"id", item.ID,
				"operation", item.Operation,
				"attempts", item.Attempts,
			)
			continue
		}
		if now.Before(item.NextRetry) {
			remaining = append(remaining, item)
			continue
		}

		// Attempt retry
		item.Attempts++
		backoff := time.Duration(1<<uint(item.Attempts)) * time.Second
		if backoff > 32*time.Second {
			backoff = 32 * time.Second
		}
		item.NextRetry = now.Add(backoff)

		slog.Info("retrying operation",
			"id", item.ID,
			"operation", item.Operation,
			"attempt", item.Attempts,
			"next_retry", item.NextRetry,
		)

		// For now, just re-queue — actual retry logic is provider-specific
		remaining = append(remaining, item)
	}

	q.items = remaining
}
