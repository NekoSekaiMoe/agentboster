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

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/eventbus"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/i18n"
	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/usertype"
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
//
// TaskID/RunID remember which pending task opened this entry, so expiry
// audits can attribute the expiry to the exact task/run instead of
// guessing from the session (a session can have several pending tasks).
type L2AuthEntry struct {
	SessionID string
	Pattern   string
	CacheKey  CacheKey
	Action    string
	ExpiresAt time.Time
	CreatedAt time.Time
	TaskID    string
	RunID     string
}

// L2AuthManager manages L2 cache (local fast path).
// DecisionQueue, pending tasks, and persistence moved to clawless web layer.
type L2AuthManager struct {
	mu            sync.RWMutex
	entries       map[string]*L2AuthEntry
	pending       map[string]CacheKey
	pendingRunIDs map[string]string
	clawless      *clawless.Client
	bus           *eventbus.Bus
	agentID       string
	sessionID     string
	escalation    time.Duration
}

// NewL2AuthManager creates a new L2 auth manager (cache only).
func NewL2AuthManager(client *clawless.Client, agentID string) *L2AuthManager {
	return &L2AuthManager{
		entries:       make(map[string]*L2AuthEntry),
		pending:       make(map[string]CacheKey),
		pendingRunIDs: make(map[string]string),
		clawless:      client,
		agentID:       agentID,
		escalation:    5 * time.Minute,
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
	if task.RunID != "" {
		m.pendingRunIDs[task.ID] = task.RunID
	}
}

// RunIDForTask returns the trace id captured when an L2 decision was opened.
func (m *L2AuthManager) RunIDForTask(taskID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.pendingRunIDs[taskID]
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
	}, pattern, duration, ActionPass, "", "")
}

func (m *L2AuthManager) AuthorizeTask(taskID, pattern, duration string) error {
	return m.authorizePending(taskID, pattern, duration, ActionPass)
}

func (m *L2AuthManager) authorizePending(taskID, pattern, duration, action string) error {
	m.mu.RLock()
	cacheKey, ok := m.pending[taskID]
	runID := m.pendingRunIDs[taskID]
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
	return m.authorizeWithKey(cacheKey, pattern, duration, action, taskID, runID)
}

func (m *L2AuthManager) authorizeWithKey(cacheKey CacheKey, pattern string, duration string, action string, taskID, runID string) error {
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
		TaskID:    taskID,
		RunID:     runID,
	}
	m.entries[key] = entry

	slog.Info("L2 authorized",
		"pattern", pattern,
		"cache_key", key,
		"action", action,
		"expires", expiresAt,
		"task_id", taskID,
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
	}, pattern, duration, ActionReject, "", "")
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
			delete(m.pendingRunIDs, taskID)
			removedPending++
		}
	}
	slog.Info("L2 session cleared", "session_id", sessionID, "entries", removedEntries, "pending", removedPending)
}

// expiredAudit carries the audit context for one expired L2 entry from
// the locked scan to the post-unlock I/O in writeExpiredAudits. log is
// nil when no correlatable run id was found for the entry's session.
type expiredAudit struct {
	log     *clawless.ReviewLog
	userID  string
	session string
	pattern string
	action  string
	expires time.Time
}

// ExpireStale removes expired entries and writes audit records for each.
// When a run id captured for the entry's session is available, the expiry is
// submitted as a canonical review log via the clawless client; otherwise a
// structured slog.Warn (userId/sessionId/reason) is emitted so the expiry is
// never silent. Returns the list of expired entries for further processing
// (e.g., session archive).
func (m *L2AuthManager) ExpireStale() []ExpiredEntry {
	m.mu.Lock()
	now := time.Now()
	expired := make([]ExpiredEntry, 0)
	audits := make([]expiredAudit, 0)
	for key, entry := range m.entries {
		if now.After(entry.ExpiresAt) {
			expired = append(expired, ExpiredEntry{
				SessionID: entry.SessionID,
				Pattern:   entry.Pattern,
				Action:    entry.Action,
				ExpiresAt: entry.ExpiresAt,
			})
			delete(m.entries, key)

			// Capture the audit context while the lock is held (reads
			// pendingRunIDs / clawless safely); I/O happens after unlock.
			audit := expiredAudit{
				userID:  entry.CacheKey.UserID,
				session: entry.SessionID,
				pattern: entry.Pattern,
				action:  entry.Action,
				expires: entry.ExpiresAt,
			}
			if taskID, runID := m.runIDForSessionLocked(entry); runID != "" {
				audit.log = &clawless.ReviewLog{
					TaskID:         taskID,
					SessionID:      entry.SessionID,
					RunID:          runID,
					Command:        entry.Pattern,
					Level:          "L2",
					Score:          0,
					Decision:       "expired",
					Reason:         fmt.Sprintf("L2 authorization expired (action=%s, expires_at=%s)", entry.Action, entry.ExpiresAt.Format(time.RFC3339)),
					IdempotencyKey: clawless.BuildReviewIdempotencyKey(taskID, "L2", "expired", entry.Pattern),
					Timestamp:      now,
				}
			}
			audits = append(audits, audit)
		}
	}
	client := m.clawless
	m.mu.Unlock()

	if len(expired) == 0 {
		return expired
	}
	slog.Info("L2 auth entries expired", "count", len(expired))
	m.writeExpiredAudits(client, audits)
	return expired
}

// runIDForSessionLocked resolves (taskID, runID) for the expiry audit of an
// entry created in the given session. Precise association first: entries
// written via authorizePending carry the TaskID/RunID of the pending task
// that opened them. Only legacy entries without that record fall back to
// scanning the session's pending tasks (first match — ambiguous when a
// session has multiple pending tasks, hence the Warn). Caller must hold m.mu.
func (m *L2AuthManager) runIDForSessionLocked(entry *L2AuthEntry) (taskID, runID string) {
	if entry == nil {
		return "", ""
	}
	if entry.TaskID != "" {
		if entry.RunID != "" {
			return entry.TaskID, entry.RunID
		}
		// Task recorded but no run id captured (task had none). Fall through
		// to the session scan rather than attributing a wrong run: the
		// audit will carry whatever the scan finds, or none at all.
		slog.Warn("L2 entry has task_id without run_id, falling back to session scan",
			"task_id", entry.TaskID,
			"session_id", entry.SessionID,
		)
	}
	sessionID := entry.SessionID
	matched := 0
	for tid, cacheKey := range m.pending {
		if cacheKey.SessionID != sessionID {
			continue
		}
		if rid, ok := m.pendingRunIDs[tid]; ok && rid != "" {
			matched++
			if taskID == "" && runID == "" {
				taskID, runID = tid, rid
			}
		}
	}
	if matched > 1 {
		slog.Warn("L2 expiry audit: multiple pending tasks share the session, attribution may be wrong",
			"session_id", sessionID,
			"pending_matches", matched,
			"chosen_task_id", taskID,
		)
	}
	return taskID, runID
}

// writeExpiredAudits submits expiry audit records. All entries that
// produced a canonical review log are sent in ONE client.WriteReviewLogs
// batch under a single timeout context (previously one HTTP call per
// entry, which serialised the cleanup loop on N round-trips). Entries
// without a log (no correlatable run id) or without a client still fall
// back to the structured slog.Warn so the expiry is never silent.
func (m *L2AuthManager) writeExpiredAudits(client *clawless.Client, audits []expiredAudit) {
	batch := make([]clawless.ReviewLog, 0, len(audits))
	for _, a := range audits {
		if a.log != nil {
			batch = append(batch, *a.log)
		} else {
			slog.Warn("L2 authorization expired without audit trace",
				"user_id", a.userID,
				"session_id", a.session,
				"reason", fmt.Sprintf("L2 authorization expired (action=%s, expires_at=%s); no run_id available for canonical review log", a.action, a.expires.Format(time.RFC3339)),
				"pattern", a.pattern,
				"action", a.action,
			)
		}
	}
	if client == nil || len(batch) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.WriteReviewLogs(ctx, batch); err != nil {
		slog.Warn("failed to write L2 expiry review logs",
			"batch_size", len(batch), "error", err)
	}
}

// ExpiredEntry holds information about an expired authorization.
type ExpiredEntry struct {
	SessionID string
	Pattern   string
	Action    string
	ExpiresAt time.Time
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
