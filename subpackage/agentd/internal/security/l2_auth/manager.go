package l2_auth

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/i18n"
	"github.com/clawless/agentd/internal/usertype"
)

const (
	ActionPass   = "pass"
	ActionReject = "reject"

	// cleanupInterval is the default interval for the cleanup worker.
	cleanupInterval = 30 * time.Second
)

var sessionLifetimeExpiry = time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)

var durationRe = regexp.MustCompile(`^(always|\d{8})$`)

var commandReviewRiskPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?is)\b(?:shred|mkfs|wipefs|fdisk)\b`),
	regexp.MustCompile(`(?is)\bdd\b.*\bof=/dev/`),
	regexp.MustCompile(`(?is)\brm\s+-[^\n]*[rf]`),
	regexp.MustCompile(`(?is)\bfind\b.*\s-(?:delete|exec)\b`),
	regexp.MustCompile(`(?is)\bxargs\b.*\b(?:rm|shred|dd|truncate|wipefs)\b`),
	regexp.MustCompile(`(?is)\b(?:curl|wget)\b.*\|\s*(?:sh|bash)\b`),
	regexp.MustCompile(`(?is)\b(?:sudo|su\s+-|chmod\s+777|chown\s+root)\b`),
}

// L2AuthEntry represents a cached authorization decision.
type L2AuthEntry struct {
	SessionID string
	Pattern   string
	CacheKey  CacheKey
	Action    string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// L2AuthManager manages L2 cache (local fast path).
// DecisionQueue, pending tasks, and persistence moved to clawless web layer.
type L2AuthManager struct {
	mu         sync.RWMutex
	entries    map[string]*L2AuthEntry
	pending    map[string]CacheKey
	clawless   *clawless.Client
	bus        *eventbus.Bus
	agentID    string
	sessionID  string
	escalation time.Duration
}

// NewL2AuthManager creates a new L2 auth manager (cache only).
func NewL2AuthManager(client *clawless.Client, agentID string) *L2AuthManager {
	return &L2AuthManager{
		entries:    make(map[string]*L2AuthEntry),
		pending:    make(map[string]CacheKey),
		clawless:   client,
		agentID:    agentID,
		escalation: 5 * time.Minute,
	}
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
	return m.checkWithKey(CacheKey{
		UserID:        "unknown",
		SessionID:     m.sessionID,
		ToolName:      "task_command",
		ArgsHash:      hashString(pattern),
		SandboxID:     "unknown",
		PolicyVersion: PolicyVersion,
		UserType:      usertype.Unknown,
	}, pattern)
}

func (m *L2AuthManager) CheckTask(task *clawless.Task) (*L2AuthEntry, bool, bool) {
	return m.checkWithKey(CacheKeyForTask(task), task.Command)
}

func (m *L2AuthManager) checkWithKey(cacheKey CacheKey, pattern string) (*L2AuthEntry, bool, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	key := cacheKey.SessionScopedKey()
	entry, ok := m.entries[key]
	if !ok {
		return nil, false, false
	}

	if time.Now().After(entry.ExpiresAt) {
		return nil, false, false
	}

	slog.Info("L2 auth cache hit",
		"pattern", pattern,
		"cache_key", key,
		"action", entry.Action,
		"expires", entry.ExpiresAt,
	)

	return entry, true, entry.Action == ActionReject
}

func (m *L2AuthManager) RememberPendingTask(task *clawless.Task) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pending[task.ID] = CacheKeyForTask(task)
}

// Authorize records a pass authorization decision for the given pattern and duration.
//
// Duration values:
//   - "once" → don't write to cache (just return)
//   - "always" → write a session-lifetime cache entry
//   - "hhddmmyy" → parse and write cache with computed TTL
func (m *L2AuthManager) Authorize(pattern string, duration string) error {
	return m.authorizeWithKey(CacheKey{
		UserID:        "unknown",
		SessionID:     m.sessionID,
		ToolName:      "task_command",
		ArgsHash:      hashString(pattern),
		SandboxID:     "unknown",
		PolicyVersion: PolicyVersion,
		UserType:      usertype.Unknown,
	}, pattern, duration, ActionPass)
}

func (m *L2AuthManager) AuthorizeTask(taskID, pattern, duration string) error {
	return m.authorizePending(taskID, pattern, duration, ActionPass)
}

func (m *L2AuthManager) authorizePending(taskID, pattern, duration, action string) error {
	m.mu.RLock()
	cacheKey, ok := m.pending[taskID]
	m.mu.RUnlock()
	if !ok {
		cacheKey = CacheKey{
			UserID:        "unknown",
			SessionID:     m.sessionID,
			ToolName:      "task_command",
			ArgsHash:      hashString(pattern),
			SandboxID:     "unknown",
			PolicyVersion: PolicyVersion,
			UserType:      usertype.Unknown,
		}
	}
	return m.authorizeWithKey(cacheKey, pattern, duration, action)
}

func (m *L2AuthManager) authorizeWithKey(cacheKey CacheKey, pattern string, duration string, action string) error {
	if duration == "once" {
		slog.Info("L2 decision once (no cache write)", "pattern", pattern, "action", action)
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	var expiresAt time.Time
	if duration == "always" {
		expiresAt = sessionLifetimeExpiry
	} else {
		ttl, err := ParseDuration(duration)
		if err != nil {
			return err
		}
		expiresAt = time.Now().Add(ttl)
	}

	key := cacheKey.SessionScopedKey()
	entry := &L2AuthEntry{
		SessionID: cacheKey.SessionID,
		Pattern:   pattern,
		CacheKey:  cacheKey,
		Action:    action,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	m.entries[key] = entry

	slog.Info("L2 authorized",
		"pattern", pattern,
		"cache_key", key,
		"action", action,
		"expires", expiresAt,
	)
	return nil
}

// Reject records a reject authorization decision for the given pattern and duration.
//
// Duration values:
//   - "once" → don't write to cache (just return)
//   - "always" → write a session-lifetime cache entry
//   - "hhddmmyy" → parse and write cache with computed TTL
func (m *L2AuthManager) Reject(pattern string, duration string) error {
	return m.authorizeWithKey(CacheKey{
		UserID:        "unknown",
		SessionID:     m.sessionID,
		ToolName:      "task_command",
		ArgsHash:      hashString(pattern),
		SandboxID:     "unknown",
		PolicyVersion: PolicyVersion,
		UserType:      usertype.Unknown,
	}, pattern, duration, ActionReject)
}

func (m *L2AuthManager) RejectTask(taskID, pattern, duration string) error {
	return m.authorizePending(taskID, pattern, duration, ActionReject)
}

// Revoke removes an authorization entry by pattern.
func (m *L2AuthManager) Revoke(pattern string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := CacheKey{
		UserID:        "unknown",
		SessionID:     m.sessionID,
		ToolName:      "task_command",
		ArgsHash:      hashString(pattern),
		SandboxID:     "unknown",
		PolicyVersion: PolicyVersion,
		UserType:      usertype.Unknown,
	}.SessionScopedKey()
	delete(m.entries, key)
}

// ClearSession removes all entries for the given session.
func (m *L2AuthManager) ClearSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	removedEntries := 0
	for key, entry := range m.entries {
		if entry.SessionID == sessionID {
			delete(m.entries, key)
			removedEntries++
		}
	}
	removedPending := 0
	for taskID, cacheKey := range m.pending {
		if cacheKey.SessionID == sessionID {
			delete(m.pending, taskID)
			removedPending++
		}
	}
	slog.Info("L2 session cleared", "session_id", sessionID, "entries", removedEntries, "pending", removedPending)
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

// FormatCommandReview produces a compact diff-style preview for L2 prompts.
// It is not an execution diff; it highlights command segments the user is
// being asked to authorize before the command runs.
func FormatCommandReview(command string, score float64, reason string, level string) string {
	segments := splitCommandSegments(command)
	if len(segments) == 0 {
		segments = []string{strings.TrimSpace(command)}
	}

	var b strings.Builder
	b.WriteString("Command diff preview:\n")
	for i, segment := range segments {
		if i >= 8 {
			fmt.Fprintf(&b, "... %d more segment(s)\n", len(segments)-i)
			break
		}
		prefix := "+"
		if commandSegmentLooksRisky(segment) {
			prefix = "!"
		}
		fmt.Fprintf(&b, "%s %s\n", prefix, truncateForReview(segment, 180))
	}
	fmt.Fprintf(&b, "! L2 level=%s score=%.1f\n", level, score)
	if strings.TrimSpace(reason) != "" {
		fmt.Fprintf(&b, "! Reason: %s\n", truncateForReview(reason, 260))
	}
	return truncateForReview(strings.TrimSpace(b.String()), 1600)
}

func splitCommandSegments(command string) []string {
	var segments []string
	var b strings.Builder
	inSingle := false
	inDouble := false
	escaped := false

	flush := func() {
		segment := strings.TrimSpace(b.String())
		if segment != "" {
			segments = append(segments, segment)
		}
		b.Reset()
	}

	for i := 0; i < len(command); i++ {
		ch := command[i]
		if escaped {
			b.WriteByte(ch)
			escaped = false
			continue
		}
		if ch == '\\' {
			b.WriteByte(ch)
			escaped = true
			continue
		}
		if ch == '\'' && !inDouble {
			inSingle = !inSingle
			b.WriteByte(ch)
			continue
		}
		if ch == '"' && !inSingle {
			inDouble = !inDouble
			b.WriteByte(ch)
			continue
		}
		if !inSingle && !inDouble {
			switch ch {
			case '\n', ';':
				flush()
				continue
			case '&', '|':
				if i+1 < len(command) && command[i+1] == ch {
					flush()
					i++
					continue
				}
				if ch == '|' {
					flush()
					continue
				}
			}
		}
		b.WriteByte(ch)
	}
	flush()
	return segments
}

func commandSegmentLooksRisky(segment string) bool {
	for _, pattern := range commandReviewRiskPatterns {
		if pattern.MatchString(segment) {
			return true
		}
	}
	return false
}

func truncateForReview(s string, max int) string {
	s = strings.TrimSpace(s)
	if max <= 0 || len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}

// FormatNotificationMessage formats the L2 authorization notification per the design doc.
func FormatNotificationMessage(command string, score float64, reason string, level string) string {
	icon := "⚠️"
	if level == "critical" {
		icon = "🚨"
	}
	return i18n.T("l2.authorization.message", map[string]any{
		"Icon":    icon,
		"Command": command,
		"Score":   fmt.Sprintf("%.1f", score),
		"Level":   level,
		"Reason":  reason,
	})
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
