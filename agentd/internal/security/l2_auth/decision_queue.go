package l2_auth

import (
	"fmt"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/eventbus"
)

const (
	DecisionStatusPending  = "pending"
	DecisionStatusSent     = "sent"
	DecisionStatusResolved = "resolved"
	DecisionStatusExpired  = "expired"
	DecisionStatusTimeout  = "timeout"

	DefaultTimeout       = 3 * time.Minute
	MaxConcurrentPerTask = 3
)

// Decision represents a single L2 authorization request awaiting user action.
type Decision struct {
	DecisionID string    `json:"decision_id"`
	TaskID     string    `json:"task_id"`
	SessionID  string    `json:"session_id"`
	Command    string    `json:"command"`
	Score      float64   `json:"score"`
	Reason     string    `json:"reason"`
	Status     string    `json:"status"`
	Channels   []string  `json:"channels"`
	CreatedAt  time.Time `json:"created_at"`
	TimeoutAt  time.Time `json:"timeout_at"`
	ResolvedAt time.Time `json:"resolved_at,omitempty"`
	ResolvedBy string    `json:"resolved_by,omitempty"`
	Action     string    `json:"action,omitempty"`
}

// Clone returns a copy of the decision.
func (d *Decision) Clone() *Decision {
	clone := *d
	clone.Channels = make([]string, len(d.Channels))
	copy(clone.Channels, d.Channels)
	return &clone
}

// DecisionQueue serializes L2 authorization requests.
// Decisions from different tasks are serialized; same-task decisions can be concurrent (up to 3).
type DecisionQueue struct {
	mu            sync.RWMutex
	decisions     map[string]*Decision
	pendingOrder  []string
	bus           *eventbus.Bus
	timeout       time.Duration
	checkInterval time.Duration
	stopCh        chan struct{}
}

// NewDecisionQueue creates a new decision queue with a background timeout monitor.
func NewDecisionQueue(bus *eventbus.Bus) *DecisionQueue {
	dq := &DecisionQueue{
		decisions:     make(map[string]*Decision),
		pendingOrder:  make([]string, 0),
		bus:           bus,
		timeout:       DefaultTimeout,
		checkInterval: 5 * time.Second,
		stopCh:        make(chan struct{}),
	}
	go dq.monitorTimeouts()
	return dq
}

// Stop halts the background timeout monitor.
func (dq *DecisionQueue) Stop() {
	close(dq.stopCh)
}

// Enqueue adds a decision to the queue. If a serial slot is available it is
// immediately promoted to "sent" and true is returned.
func (dq *DecisionQueue) Enqueue(decision *Decision) bool {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	if decision.DecisionID == "" {
		decision.DecisionID = fmt.Sprintf("dec_%d", time.Now().UnixNano())
	}
	if decision.CreatedAt.IsZero() {
		decision.CreatedAt = time.Now()
	}
	if decision.TimeoutAt.IsZero() {
		decision.TimeoutAt = decision.CreatedAt.Add(dq.timeout)
	}

	dq.decisions[decision.DecisionID] = decision.Clone()
	dq.pendingOrder = append(dq.pendingOrder, decision.DecisionID)

	if dq.canPromoteLocked(decision.TaskID) {
		dq.promoteLocked(decision.DecisionID)
		return true
	}

	return false
}

// GetByDecisionID looks up a decision by ID (returns a clone).
func (dq *DecisionQueue) GetByDecisionID(id string) (*Decision, error) {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	d, ok := dq.decisions[id]
	if !ok {
		return nil, fmt.Errorf("decision %s not found", id)
	}
	return d.Clone(), nil
}

// Resolve marks a decision as resolved and advances the queue.
func (dq *DecisionQueue) Resolve(decisionID, action, resolvedBy string) error {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	d, ok := dq.decisions[decisionID]
	if !ok {
		return fmt.Errorf("decision %s not found", decisionID)
	}

	now := time.Now()
	d.Status = DecisionStatusResolved
	d.ResolvedAt = now
	d.ResolvedBy = resolvedBy
	d.Action = action

	// Advance queue: promote next eligible decisions
	dq.advanceQueueLocked()

	// Publish event
	if dq.bus != nil {
		dq.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"decision_id": decisionID,
			"task_id":     d.TaskID,
			"action":      action,
		})
	}

	return nil
}

// Deny marks a decision as denied (rejected) and advances the queue.
func (dq *DecisionQueue) Deny(decisionID, resolvedBy string) error {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	d, ok := dq.decisions[decisionID]
	if !ok {
		return fmt.Errorf("decision %s not found", decisionID)
	}

	now := time.Now()
	d.Status = DecisionStatusResolved
	d.ResolvedAt = now
	d.ResolvedBy = resolvedBy
	d.Action = "deny"

	dq.advanceQueueLocked()

	if dq.bus != nil {
		dq.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"decision_id": decisionID,
			"task_id":     d.TaskID,
		})
	}

	return nil
}

// Expire manually marks a decision as expired.
func (dq *DecisionQueue) Expire(decisionID string) {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	d, ok := dq.decisions[decisionID]
	if !ok {
		return
	}

	d.Status = DecisionStatusExpired
	d.ResolvedAt = time.Now()
	d.Action = "timeout"

	dq.advanceQueueLocked()
}

// ListPending returns all pending and sent decisions in FIFO order.
func (dq *DecisionQueue) ListPending() []*Decision {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	result := make([]*Decision, 0)
	for _, id := range dq.pendingOrder {
		if d, ok := dq.decisions[id]; ok {
			if d.Status == DecisionStatusPending || d.Status == DecisionStatusSent {
				result = append(result, d.Clone())
			}
		}
	}
	return result
}

// GetSent returns all currently "sent" (awaiting user response) decisions.
func (dq *DecisionQueue) GetSent() []*Decision {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	result := make([]*Decision, 0)
	for _, d := range dq.decisions {
		if d.Status == DecisionStatusSent {
			result = append(result, d.Clone())
		}
	}
	return result
}

// Count returns the number of decisions matching the given status (empty = all).
func (dq *DecisionQueue) Count(status string) int {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	if status == "" {
		return len(dq.decisions)
	}
	n := 0
	for _, d := range dq.decisions {
		if d.Status == status {
			n++
		}
	}
	return n
}

// AddChannel records that a notification was sent via the given channel.
func (dq *DecisionQueue) AddChannel(decisionID, channel string) {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	d, ok := dq.decisions[decisionID]
	if !ok {
		return
	}

	for _, c := range d.Channels {
		if c == channel {
			return // already recorded
		}
	}
	d.Channels = append(d.Channels, channel)
}

// GetPendingTaskIDs returns the set of task IDs that have sent decisions.
func (dq *DecisionQueue) GetPendingTaskIDs() map[string]bool {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	ids := make(map[string]bool)
	for _, d := range dq.decisions {
		if d.Status == DecisionStatusSent {
			ids[d.TaskID] = true
		}
	}
	return ids
}

// HasPendingDecision checks if there's any sent decision for the given task.
func (dq *DecisionQueue) HasPendingDecision(taskID string) bool {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	for _, d := range dq.decisions {
		if d.TaskID == taskID && d.Status == DecisionStatusSent {
			return true
		}
	}
	return false
}

// ── Internal ────────────────────────────────────────────────────────

func (dq *DecisionQueue) canPromoteLocked(taskID string) bool {
	sentCount := 0
	taskSentCount := 0

	for _, d := range dq.decisions {
		if d.Status != DecisionStatusSent {
			continue
		}
		sentCount++
		if d.TaskID == taskID {
			taskSentCount++
		}
	}

	// If no decisions are sent at all, we can always promote
	if sentCount == 0 {
		return true
	}

	// Same task: allow concurrent up to MaxConcurrentPerTask
	if taskSentCount > 0 && taskSentCount < MaxConcurrentPerTask {
		return true
	}

	// Different task: only allow if there are no other sent decisions from different tasks
	if taskSentCount == 0 {
		// Check if all sent decisions are from the same task
		for _, d := range dq.decisions {
			if d.Status == DecisionStatusSent && d.TaskID != taskID {
				return false
			}
		}
		return true
	}

	return false
}

func (dq *DecisionQueue) promoteLocked(decisionID string) {
	if d, ok := dq.decisions[decisionID]; ok {
		d.Status = DecisionStatusSent
	}
}

func (dq *DecisionQueue) advanceQueueLocked() {
	for _, id := range dq.pendingOrder {
		d, ok := dq.decisions[id]
		if !ok || d.Status != DecisionStatusPending {
			continue
		}
		if dq.canPromoteLocked(d.TaskID) {
			dq.promoteLocked(id)
		}
	}
}

func (dq *DecisionQueue) monitorTimeouts() {
	ticker := time.NewTicker(dq.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			dq.checkTimeouts()
		case <-dq.stopCh:
			return
		}
	}
}

func (dq *DecisionQueue) checkTimeouts() {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	now := time.Now()
	expired := make([]string, 0)

	for id, d := range dq.decisions {
		if d.Status == DecisionStatusSent && now.After(d.TimeoutAt) {
			d.Status = DecisionStatusTimeout
			d.ResolvedAt = now
			d.Action = "timeout"
			expired = append(expired, id)
		}
	}

	if len(expired) > 0 {
		dq.advanceQueueLocked()
	}
}
