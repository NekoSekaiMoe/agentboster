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
	mu            sync.RWMutex
	entries       map[string]*L2AuthEntry // key = session_id + ":" + command_pattern
	clawless      *clawless.Client
	agentID       string
	sessionID     string
	escalation    time.Duration
	decisionIDs   map[string]bool // dedup for duplicate decision callbacks
}

// NewL2AuthManager creates a new L2 auth manager.
func NewL2AuthManager(client *clawless.Client, agentID string) *L2AuthManager {
	return &L2AuthManager{
		entries:     make(map[string]*L2AuthEntry),
		clawless:    client,
		agentID:     agentID,
		escalation:  5 * time.Minute,
		decisionIDs: make(map[string]bool),
	}
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

// RequestAuthorization creates an authorization request and notifies the user via ClawLess.
func (m *L2AuthManager) RequestAuthorization(ctx context.Context, task *clawless.Task, score float64, reason string) error {
	slog.Warn("L2 authorization required",
		"task_id", task.ID,
		"command", task.Command,
		"score", score,
		"reason", reason,
	)

	m.mu.RLock()
	client := m.clawless
	m.mu.RUnlock()

	if client == nil {
		slog.Error("L2 authorization: ClawLess client not configured")
		return fmt.Errorf("clawless client not configured")
	}

	notification := clawless.Notification{
		AgentID:  m.agentID,
		TaskID:   task.ID,
		Type:     "l2_auth_required",
		Title:    "⚠️ 高风险操作需要您的授权",
		Message:  FormatNotificationMessage(task.Command, score, reason),
		Metadata: map[string]any{
			"command": task.Command,
			"score":   score,
			"reason":  reason,
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
		return false // already processed
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

// ExpireStale removes expired entries.
func (m *L2AuthManager) ExpireStale() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for key, entry := range m.entries {
		if now.After(entry.ExpiresAt) {
			delete(m.entries, key)
		}
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
				m.ExpireStale()
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
func FormatNotificationMessage(command string, score float64, reason string) string {
	return fmt.Sprintf(
		"⚠️ 高风险操作需要您的授权\n\n"+
			"任务：%s\n"+
			"命令：%s\n"+
			"风险评分：%.1f/1.0\n"+
			"原因：%s\n\n"+
			"请选择：",
		command, command, score, reason,
	)
}

// ParseDuration parses the hhddmmyy format and returns a time.Duration.
//
// The format is: hh (hours) dd (days) mm (months) yy (years), each 2 digits.
// For "always", returns 0 and always=true.
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
