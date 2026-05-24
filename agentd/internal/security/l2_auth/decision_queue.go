package l2_auth

import (
	"context"
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
	DecisionStatusRejected = "rejected"

	DefaultTimeout       = 3 * time.Minute
	MaxConcurrentPerTask = 3
)

// DecisionType distinguishes between L2 security authorization and
// general LLM-initiated questions.
type DecisionType string

const (
	DecisionTypeL2Auth    DecisionType = "l2_auth"
	DecisionTypeQuestion  DecisionType = "question"
	DecisionTypeConflict  DecisionType = "conflict"
	DecisionTypeBranch    DecisionType = "branch"
)

// ConflictFile represents a single file with a merge conflict.
type ConflictFile struct {
	Path    string `json:"path"`
	Ours    string `json:"ours,omitempty"`
	Theirs  string `json:"theirs,omitempty"`
	Current string `json:"current,omitempty"`
}

// BranchPlan represents one option in a task branch decision.
type BranchPlan struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Details     string `json:"details,omitempty"`
}

// Decision represents a single request awaiting user action.
// It is used for L2 security authorization, LLM-initiated questions,
// conflict resolution, and task branch decisions.
type Decision struct {
	DecisionID  string         `json:"decision_id"`
	Type        DecisionType   `json:"type"`
	TaskID      string         `json:"task_id"`
	SessionID   string         `json:"session_id"`
	Command     string         `json:"command,omitempty"`
	Score       float64        `json:"score,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Question    string         `json:"question,omitempty"`
	Options     []string       `json:"options,omitempty"`
	Prompts     []Prompt       `json:"prompts,omitempty"`
	Conflict    *ConflictData  `json:"conflict,omitempty"`
	Branch      *BranchData    `json:"branch,omitempty"`
	Status      string         `json:"status"`
	CreatedAt   time.Time      `json:"created_at"`
	TimeoutAt   time.Time      `json:"timeout_at"`
	ResolvedAt  time.Time      `json:"resolved_at,omitempty"`
	ResolvedBy  string         `json:"resolved_by,omitempty"`
	Action      string         `json:"action,omitempty"`
	Answers     [][]string     `json:"answers,omitempty"`
}

// ConflictData holds conflict resolution context.
type ConflictData struct {
	Title  string         `json:"title,omitempty"`
	Files  []ConflictFile `json:"files"`
}

// BranchData holds task branch decision context.
type BranchData struct {
	Title    string       `json:"title,omitempty"`
	PlanA    BranchPlan   `json:"plan_a"`
	PlanB    BranchPlan   `json:"plan_b"`
	AllowCustom bool     `json:"allow_custom"`
}

// Prompt is a single question prompt within a decision.
type Prompt struct {
	Question  string   `json:"question"`
	Header    string   `json:"header,omitempty"`
	Options   []string `json:"options,omitempty"`
	Multiple  bool     `json:"multiple,omitempty"`
}

// Clone returns a copy of the decision.
func (d *Decision) Clone() *Decision {
	clone := *d
	clone.Options = make([]string, len(d.Options))
	copy(clone.Options, d.Options)
	clone.Prompts = make([]Prompt, len(d.Prompts))
	copy(clone.Prompts, d.Prompts)
	if d.Answers != nil {
		clone.Answers = make([][]string, len(d.Answers))
		for i, a := range d.Answers {
			clone.Answers[i] = make([]string, len(a))
			copy(clone.Answers[i], a)
		}
	}
	if d.Conflict != nil {
		clone.Conflict = &ConflictData{
			Title: d.Conflict.Title,
			Files: make([]ConflictFile, len(d.Conflict.Files)),
		}
		copy(clone.Conflict.Files, d.Conflict.Files)
	}
	if d.Branch != nil {
		clone.Branch = &BranchData{
			Title:       d.Branch.Title,
			PlanA:       d.Branch.PlanA,
			PlanB:       d.Branch.PlanB,
			AllowCustom: d.Branch.AllowCustom,
		}
	}
	return &clone
}

// pendingEntry wraps a Decision with channels for blocking wait.
type pendingEntry struct {
	decision *Decision
	resolve  chan [][]string
	reject   chan struct{}
}

// DecisionQueue serializes requests awaiting user action.
// It handles both L2 security authorization and LLM-initiated questions.
//
// Decisions from different tasks are serialized; same-task decisions
// can be concurrent up to MaxConcurrentPerTask.
type DecisionQueue struct {
	mu            sync.RWMutex
	decisions     map[string]*Decision
	pendingOrder  []string
	entries       map[string]*pendingEntry // for blocking wait
	bus           *eventbus.Bus
	timeout       time.Duration
	checkInterval time.Duration
	stopCh        chan struct{}
}

// NewDecisionQueue creates a new decision queue with background timeout monitor.
func NewDecisionQueue(bus *eventbus.Bus) *DecisionQueue {
	dq := &DecisionQueue{
		decisions:     make(map[string]*Decision),
		pendingOrder:  make([]string, 0),
		entries:       make(map[string]*pendingEntry),
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

// Enqueue adds a decision to the queue without blocking.
// Returns true if the decision was immediately promoted to "sent".
// Use this for L2 authorization decisions.
func (dq *DecisionQueue) Enqueue(decision *Decision) bool {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	dq.initDecisionLocked(decision)
	dq.decisions[decision.DecisionID] = decision.Clone()
	dq.pendingOrder = append(dq.pendingOrder, decision.DecisionID)

	if dq.canPromoteLocked(decision.TaskID) {
		dq.promoteLocked(decision.DecisionID)
		return true
	}
	return false
}

// Ask adds a decision to the queue and blocks until the user responds,
// the context is cancelled, or the timeout expires.
// Use this for LLM-initiated questions (ask_question tool).
func (dq *DecisionQueue) Ask(ctx context.Context, decision *Decision) ([][]string, error) {
	dq.mu.Lock()

	dq.initDecisionLocked(decision)
	dq.decisions[decision.DecisionID] = decision.Clone()
	dq.pendingOrder = append(dq.pendingOrder, decision.DecisionID)

	entry := &pendingEntry{
		decision: decision.Clone(),
		resolve:  make(chan [][]string, 1),
		reject:   make(chan struct{}, 1),
	}
	dq.entries[decision.DecisionID] = entry

	promoted := dq.canPromoteLocked(decision.TaskID)
	if promoted {
		dq.promoteLocked(decision.DecisionID)
	}

	dq.mu.Unlock()

	// If not immediately promoted, wait until promoted or timeout
	if !promoted {
		promoted := dq.waitForPromotion(ctx, decision.DecisionID)
		if !promoted {
			return nil, fmt.Errorf("decision %s timed out waiting in queue", decision.DecisionID)
		}
	}

	// Wait for user response, cancellation, or timeout
	select {
	case answers := <-entry.resolve:
		dq.mu.Lock()
		if d, ok := dq.decisions[decision.DecisionID]; ok {
			d.Status = DecisionStatusResolved
			d.ResolvedAt = time.Now()
			d.Answers = answers
		}
		dq.advanceQueueLocked()
		dq.mu.Unlock()
		return answers, nil

	case <-entry.reject:
		dq.mu.Lock()
		if d, ok := dq.decisions[decision.DecisionID]; ok {
			d.Status = DecisionStatusRejected
			d.ResolvedAt = time.Now()
		}
		dq.advanceQueueLocked()
		dq.mu.Unlock()
		return nil, fmt.Errorf("decision %s rejected by user", decision.DecisionID)

	case <-ctx.Done():
		dq.cleanupEntry(decision.DecisionID)
		return nil, ctx.Err()

	case <-time.After(dq.timeout):
		dq.mu.Lock()
		if d, ok := dq.decisions[decision.DecisionID]; ok {
			d.Status = DecisionStatusTimeout
			d.ResolvedAt = time.Now()
			d.Action = "timeout"
		}
		dq.advanceQueueLocked()
		dq.mu.Unlock()
		return nil, fmt.Errorf("decision %s timed out after %v", decision.DecisionID, dq.timeout)
	}
}

// Resolve marks a decision as resolved with the given action.
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

	// Unblock any waiting Ask() caller
	if entry, ok := dq.entries[decisionID]; ok {
		// For L2 decisions, answers are derived from the action
		entry.resolve <- [][]string{{action}}
		delete(dq.entries, decisionID)
	}

	dq.advanceQueueLocked()

	if dq.bus != nil {
		dq.bus.Publish(eventbus.EventL2AuthApproved, map[string]any{
			"decision_id": decisionID,
			"task_id":     d.TaskID,
			"action":      action,
		})
	}

	return nil
}

// ResolveWithAnswers resolves a decision with explicit answers (for ask_question).
func (dq *DecisionQueue) ResolveWithAnswers(decisionID string, answers [][]string) error {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	d, ok := dq.decisions[decisionID]
	if !ok {
		return fmt.Errorf("decision %s not found", decisionID)
	}

	now := time.Now()
	d.Status = DecisionStatusResolved
	d.ResolvedAt = now
	d.Answers = answers
	d.Action = "answered"

	if entry, ok := dq.entries[decisionID]; ok {
		entry.resolve <- answers
		delete(dq.entries, decisionID)
	}

	dq.advanceQueueLocked()
	return nil
}

// Deny marks a decision as denied.
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

	if entry, ok := dq.entries[decisionID]; ok {
		entry.resolve <- [][]string{{"deny"}}
		delete(dq.entries, decisionID)
	}

	dq.advanceQueueLocked()

	if dq.bus != nil {
		dq.bus.Publish(eventbus.EventL2AuthRejected, map[string]any{
			"decision_id": decisionID,
			"task_id":     d.TaskID,
		})
	}

	return nil
}

// Reject dismisses a pending question (user dismissed without answering).
func (dq *DecisionQueue) Reject(decisionID string) error {
	dq.mu.Lock()
	defer dq.mu.Unlock()

	entry, ok := dq.entries[decisionID]
	if !ok {
		return fmt.Errorf("decision %s not found", decisionID)
	}

	entry.reject <- struct{}{}
	delete(dq.entries, decisionID)

	if d, ok := dq.decisions[decisionID]; ok {
		d.Status = DecisionStatusRejected
		d.ResolvedAt = time.Now()
	}

	dq.advanceQueueLocked()
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

	dq.cleanupEntryLocked(decisionID)
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

// GetSent returns all currently "sent" decisions.
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

// GetByDecisionID looks up a decision by ID.
func (dq *DecisionQueue) GetByDecisionID(id string) (*Decision, error) {
	dq.mu.RLock()
	defer dq.mu.RUnlock()

	d, ok := dq.decisions[id]
	if !ok {
		return nil, fmt.Errorf("decision %s not found", id)
	}
	return d.Clone(), nil
}

// Count returns the number of decisions matching the given status.
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

func (dq *DecisionQueue) initDecisionLocked(d *Decision) {
	if d.DecisionID == "" {
		d.DecisionID = fmt.Sprintf("dec_%d", time.Now().UnixNano())
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now()
	}
	if d.TimeoutAt.IsZero() {
		d.TimeoutAt = d.CreatedAt.Add(dq.timeout)
	}
}

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

	if sentCount == 0 {
		return true
	}
	if taskSentCount > 0 && taskSentCount < MaxConcurrentPerTask {
		return true
	}
	if taskSentCount == 0 {
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
			// Notify any blocked Ask() caller that this decision was promoted
			if entry, ok := dq.entries[id]; ok {
				_ = entry // entry is now promoted, Ask() will proceed
			}
		}
	}
}

func (dq *DecisionQueue) cleanupEntry(decisionID string) {
	dq.mu.Lock()
	defer dq.mu.Unlock()
	dq.cleanupEntryLocked(decisionID)
}

func (dq *DecisionQueue) cleanupEntryLocked(decisionID string) {
	delete(dq.entries, decisionID)
	if d, ok := dq.decisions[decisionID]; ok {
		d.Status = DecisionStatusTimeout
		d.ResolvedAt = time.Now()
		d.Action = "timeout"
	}
}

func (dq *DecisionQueue) waitForPromotion(ctx context.Context, decisionID string) bool {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(dq.timeout):
			return false
		case <-ticker.C:
			dq.mu.RLock()
			d, ok := dq.decisions[decisionID]
			dq.mu.RUnlock()
			if ok && d.Status == DecisionStatusSent {
				return true
			}
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

			// Unblock any waiting Ask() caller
			if entry, ok := dq.entries[id]; ok {
				entry.resolve <- [][]string{{"timeout"}}
				delete(dq.entries, id)
			}
		}
	}

	if len(expired) > 0 {
		dq.advanceQueueLocked()
	}
}
