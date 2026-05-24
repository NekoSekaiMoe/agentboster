package l2_auth

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/persistence"
)

const (
	ActionPass   = "pass"
	ActionReject = "reject"

	// farFuture is used for "always" (session-scoped) entries.
	farFuture = 365 * 24 * time.Hour

	// cleanupInterval is the default interval for the cleanup worker.
	cleanupInterval = 30 * time.Second
)

var durationRe = regexp.MustCompile(`^(always|\d{8})$`)

// L2AuthEntry represents a cached authorization decision.
type L2AuthEntry struct {
	SessionID  string
	Pattern    string
	Action     string
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

// L2AuthManager manages L2 interactive authorization.
type L2AuthManager struct {
	mu             sync.RWMutex
	entries        map[string]*L2AuthEntry // key = session_id + ":" + command_pattern
	clawless       *clawless.Client
	bus            *eventbus.Bus
	agentID        string
	sessionID      string
	escalation     time.Duration
	decisionIDs    map[string]bool // dedup for duplicate decision callbacks
	decisionQueue  *DecisionQueue
	pendingTasks   map[string]*clawless.Task // task_id -> task, for resuming after L2
	pendingL2Store PendingL2StoreInterface   // persistent store for pending L2 states
}

// PendingL2StoreInterface abstracts the pending L2 store for testability.
type PendingL2StoreInterface interface {
	Save(state *persistence.PendingL2State) error
	Remove(taskID string) error
	Load(taskID string) (*persistence.PendingL2State, bool)
	ListAll() []*persistence.PendingL2State
	Count() int
}

// NewL2AuthManager creates a new L2 auth manager.
func NewL2AuthManager(client *clawless.Client, agentID string) *L2AuthManager {
	return &L2AuthManager{
		entries:       make(map[string]*L2AuthEntry),
		clawless:      client,
		agentID:       agentID,
		escalation:    5 * time.Minute,
		decisionIDs:   make(map[string]bool),
		pendingTasks:  make(map[string]*clawless.Task),
	}
}

// SetDecisionQueue sets the decision queue (must be called after creation).
func (m *L2AuthManager) SetDecisionQueue(dq *DecisionQueue) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.decisionQueue = dq
}

// SetPendingL2Store sets the persistent store for pending L2 states.
func (m *L2AuthManager) SetPendingL2Store(store PendingL2StoreInterface) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pendingL2Store = store
}

// GetPendingL2Store returns the persistent store.
func (m *L2AuthManager) GetPendingL2Store() PendingL2StoreInterface {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pendingL2Store
}

// GetDecisionQueue returns the decision queue.
func (m *L2AuthManager) GetDecisionQueue() *DecisionQueue {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.decisionQueue
}

// GetPendingDecisions returns all pending/sent decisions.
func (m *L2AuthManager) GetPendingDecisions() []*Decision {
	m.mu.RLock()
	dq := m.decisionQueue
	m.mu.RUnlock()
	if dq == nil {
		return nil
	}
	return dq.ListPending()
}

// GetSentDecisions returns all currently sent (awaiting response) decisions.
func (m *L2AuthManager) GetSentDecisions() []*Decision {
	m.mu.RLock()
	dq := m.decisionQueue
	m.mu.RUnlock()
	if dq == nil {
		return nil
	}
	return dq.GetSent()
}

// SetBus sets the event bus for publishing session-related events.
func (m *L2AuthManager) SetBus(bus *eventbus.Bus) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bus = bus
}

// SetClawlessClient sets the ClawLess API client.
func (m *L2AuthManager) SetClawlessClient(client *clawless.Client) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clawless = client
}

// SetSession sets the current session ID for "always" window entries.
func (m *L2AuthManager) SetSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessionID = sessionID
}

// Check verifies if a command matches a cached authorization entry.
//
// Returns:
//   - entry: the matched cache entry (nil if no hit)
//   - hit:   true if a valid (non-expired) cache entry was found
//   - rejected: true if the cache hit has Action="reject" (caller should silently reject)
func (m *L2AuthManager) Check(pattern string) (*L2AuthEntry, bool, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	key := m.sessionID + ":" + pattern
	entry, ok := m.entries[key]
	if !ok {
		return nil, false, false
	}

	if time.Now().After(entry.ExpiresAt) {
		return nil, false, false
	}

	slog.Info("L2 auth cache hit",
		"pattern", pattern,
		"action", entry.Action,
		"expires", entry.ExpiresAt,
	)

	return entry, true, entry.Action == ActionReject
}

// RequestAuthorization creates an L2 authorization request, enqueues it in the
// decision queue, and notifies the user via ClawLess.
func (m *L2AuthManager) RequestAuthorization(ctx context.Context, task *clawless.Task, score float64, reason, level string) error {
	slog.Warn("L2 authorization required",
		"task_id", task.ID,
		"command", task.Command,
		"score", score,
		"reason", reason,
	)

	m.mu.Lock()
	client := m.clawless
	dq := m.decisionQueue
	m.sessionID = task.SessionID
	m.mu.Unlock()

	if client == nil {
		slog.Error("L2 authorization: ClawLess client not configured")
		return fmt.Errorf("clawless client not configured")
	}

	// Store the task for resuming after L2
	m.mu.Lock()
	m.pendingTasks[task.ID] = task
	pendingStore := m.pendingL2Store
	m.mu.Unlock()

	// Persist pending L2 state to disk
	if pendingStore != nil {
		if err := pendingStore.Save(&persistence.PendingL2State{
			TaskID:      task.ID,
			SessionID:   task.SessionID,
			AgentID:     m.agentID,
			Command:     task.Command,
			Score:       score,
			Reason:      reason,
			Level:       level,
			DecisionID:  fmt.Sprintf("l2_%s_%d", task.ID, time.Now().Unix()),
			RequestedAt: time.Now(),
		}); err != nil {
			slog.Warn("failed to persist pending L2 state", "task_id", task.ID, "error", err)
		}
	}

	if dq != nil {
		decision := &Decision{
			Type:      DecisionTypeL2Auth,
			TaskID:    task.ID,
			SessionID: task.SessionID,
			Command:   task.Command,
			Score:     score,
			Reason:    reason,
			Options:   []string{"pass_once", "pass_until", "reject_once", "reject_until"},
		}
		dq.Enqueue(decision)
	}

	title := "⚠️ 高风险操作需要您的授权"
	if level == "critical" {
		title = "🚨 高危操作需要您的授权"
	}
	notification := clawless.Notification{
		AgentID:  m.agentID,
		TaskID:   task.ID,
		Type:     "l2_auth_required",
		Title:    title,
		Message:  FormatNotificationMessage(task.Command, score, reason, level),
		Metadata: map[string]any{
			"command": task.Command,
			"score":   score,
			"reason":  reason,
			"level":   level,
		},
	}

	if err := client.CreateNotification(ctx, &notification); err != nil {
		slog.Error("L2 authorization: failed to create notification",
			"task_id", task.ID,
			"error", err,
		)
		return fmt.Errorf("create notification: %w", err)
	}

	return nil
}

// GetPendingTask returns the task associated with a pending L2 decision.
func (m *L2AuthManager) GetPendingTask(taskID string) (*clawless.Task, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	t, ok := m.pendingTasks[taskID]
	return t, ok
}

// RemovePendingTask removes a task from the pending map.
func (m *L2AuthManager) RemovePendingTask(taskID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.pendingTasks, taskID)
}

// Authorize records a pass authorization decision for the given pattern and duration.
//
// Duration values:
//   - "once" → don't write to cache (just return)
//   - "always" → write cache with far-future expiry
//   - "hhddmmyy" → parse and write cache with computed TTL
func (m *L2AuthManager) Authorize(pattern string, duration string) error {
	if duration == "once" {
		slog.Info("L2 authorize once (no cache write)", "pattern", pattern)
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	var expiresAt time.Time
	if duration == "always" {
		expiresAt = time.Now().Add(farFuture)
	} else {
		ttl, err := ParseDuration(duration)
		if err != nil {
			return err
		}
		expiresAt = time.Now().Add(ttl)
	}

	key := m.sessionID + ":" + pattern
	entry := &L2AuthEntry{
		SessionID: m.sessionID,
		Pattern:   pattern,
		Action:    ActionPass,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	m.entries[key] = entry

	slog.Info("L2 authorized",
		"pattern", pattern,
		"action", ActionPass,
		"expires", expiresAt,
	)
	return nil
}

// Reject records a reject authorization decision for the given pattern and duration.
//
// Duration values:
//   - "once" → don't write to cache (just return)
//   - "always" → write cache with far-future expiry
//   - "hhddmmyy" → parse and write cache with computed TTL
func (m *L2AuthManager) Reject(pattern string, duration string) error {
	if duration == "once" {
		slog.Info("L2 reject once (no cache write)", "pattern", pattern)
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	var expiresAt time.Time
	if duration == "always" {
		expiresAt = time.Now().Add(farFuture)
	} else {
		ttl, err := ParseDuration(duration)
		if err != nil {
			return err
		}
		expiresAt = time.Now().Add(ttl)
	}

	key := m.sessionID + ":" + pattern
	entry := &L2AuthEntry{
		SessionID: m.sessionID,
		Pattern:   pattern,
		Action:    ActionReject,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	m.entries[key] = entry

	slog.Info("L2 rejected",
		"pattern", pattern,
		"action", ActionReject,
		"expires", expiresAt,
	)
	return nil
}

// MarkDecisionProcessed marks a decision ID as processed for dedup.
// Returns true if this is the first time seeing this decision ID.
func (m *L2AuthManager) MarkDecisionProcessed(decisionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.decisionIDs[decisionID] {
		return false
	}
	m.decisionIDs[decisionID] = true
	return true
}

// Revoke removes an authorization entry by pattern.
func (m *L2AuthManager) Revoke(pattern string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := m.sessionID + ":" + pattern
	delete(m.entries, key)
}

// ClearSession removes all entries for the given session.
func (m *L2AuthManager) ClearSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, entry := range m.entries {
		if entry.SessionID == sessionID {
			delete(m.entries, key)
		}
	}
	slog.Info("L2 session cleared", "session_id", sessionID)
}

// ExpireStale removes expired entries and writes review logs for each.
// Returns the list of expired entries for further processing (e.g., session archive).
func (m *L2AuthManager) ExpireStale() []ExpiredEntry {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	expired := make([]ExpiredEntry, 0)

	for key, entry := range m.entries {
		if now.After(entry.ExpiresAt) {
			expired = append(expired, ExpiredEntry{
				SessionID: entry.SessionID,
				Pattern:   entry.Pattern,
				Action:    entry.Action,
				ExpiresAt: entry.ExpiresAt,
			})
			delete(m.entries, key)
		}
	}

	if len(expired) > 0 {
		slog.Info("L2 auth entries expired", "count", len(expired))
	}

	return expired
}

// ExpiredEntry holds information about an expired authorization.
type ExpiredEntry struct {
	SessionID string
	Pattern   string
	Action    string
	ExpiresAt time.Time
}

// WriteExpiredReviewLogs writes review logs for expired L2 authorizations via ClawLess API.
func (m *L2AuthManager) WriteExpiredReviewLogs(ctx context.Context, entries []ExpiredEntry) {
	m.mu.RLock()
	client := m.clawless
	m.mu.RUnlock()

	if client == nil || len(entries) == 0 {
		return
	}

	logs := make([]clawless.ReviewLog, 0, len(entries))
	for _, e := range entries {
		logs = append(logs, clawless.ReviewLog{
			TaskID:   e.SessionID,
			Command:  e.Pattern,
			Level:    "L2",
			Score:    0,
			Decision: "expired",
			Reason: fmt.Sprintf(
				"L2 授权已过期：session_id=%s, pattern=%s, action=%s, expired_at=%s",
				e.SessionID, e.Pattern, e.Action, e.ExpiresAt.Format(time.RFC3339),
			),
		})
	}

	if err := client.WriteReviewLogs(ctx, logs); err != nil {
		slog.Error("failed to write L2 expiry review logs", "error", err, "count", len(logs))
	}
}

// StartCleanup starts a background goroutine to clean expired entries every 30 seconds.
func (m *L2AuthManager) StartCleanup() (stop func()) {
	return m.StartCleanupWithInterval(cleanupInterval)
}

// StartCleanupWithInterval starts a background goroutine to clean expired entries.
func (m *L2AuthManager) StartCleanupWithInterval(interval time.Duration) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				expired := m.ExpireStale()
				if len(expired) > 0 {
					m.WriteExpiredReviewLogs(ctx, expired)
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() { cancel() }
}

// EscalationTimeout returns the duration before an unconfirmed auth escalates.
func (m *L2AuthManager) EscalationTimeout() time.Duration {
	return m.escalation
}

// FormatNotificationMessage formats the L2 authorization notification per the design doc.
func FormatNotificationMessage(command string, score float64, reason string, level string) string {
	icon := "⚠️"
	if level == "critical" {
		icon = "🚨"
	}
	return fmt.Sprintf(
		"%s 高风险操作需要您的授权\n\n"+
			"命令：%s\n"+
			"风险评分：%.1f/1.0\n"+
			"风险等级：%s\n"+
			"原因：%s\n\n"+
			"请选择授权时间窗口：\n"+
			"- pass_once: 仅此次\n"+
			"- pass_until: 指定时间前 (格式 hhddmmyy)\n"+
			"- reject_once: 仅此次拒绝\n"+
			"- reject_until: 指定时间前拒绝 (格式 hhddmmyy)",
		icon, command, score, level, reason,
	)
}

// ParseDuration parses the hhddmmyy format and returns a time.Duration.
//
// The format is: hh (hours) dd (days) mm (months) yy (years), each 2 digits.
// Returns an error for invalid formats.
func ParseDuration(input string) (time.Duration, error) {
	if !durationRe.MatchString(input) {
		return 0, fmt.Errorf("invalid duration format %q: expected hhddmmyy or always", input)
	}

	hh, _ := strconv.Atoi(input[0:2])
	dd, _ := strconv.Atoi(input[2:4])
	mm, _ := strconv.Atoi(input[4:6])
	yy, _ := strconv.Atoi(input[6:8])

	d := time.Duration(hh)*time.Hour +
		time.Duration(dd)*24*time.Hour +
		time.Duration(mm)*30*24*time.Hour +
		time.Duration(yy)*365*24*time.Hour

	return d, nil
}
