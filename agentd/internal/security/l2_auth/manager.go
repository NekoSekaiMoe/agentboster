package l2_auth

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/clawless/agentd/internal/clawless"
)

// Window represents an authorization time window.
type Window string

const (
	WindowOnce    Window = "once"
	Window10Min   Window = "10min"
	Window1Hour   Window = "1hour"
	Window1Day    Window = "1day"
	WindowAlways  Window = "always" // session-scoped
)

// L2AuthEntry represents a cached authorization decision.
type L2AuthEntry struct {
	TaskID    string
	Command   string
	Window    Window
	ExpiresAt time.Time
	SessionID string
}

// L2AuthManager manages L2 interactive authorization (replicating Manboster TTL + escalation).
type L2AuthManager struct {
	mu         sync.RWMutex
	entries    map[string]*L2AuthEntry // key = command pattern
	clawless   *clawless.Client
	agentID    string
	sessionID  string
	escalation time.Duration // timeout before escalating
}

// NewL2AuthManager creates a new L2 auth manager.
func NewL2AuthManager(client *clawless.Client, agentID string) *L2AuthManager {
	return &L2AuthManager{
		entries:    make(map[string]*L2AuthEntry),
		clawless:   client,
		agentID:    agentID,
		escalation: 5 * time.Minute,
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

// Check verifies if a command is authorized (cache hit).
func (m *L2AuthManager) Check(command string) (*L2AuthEntry, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	entry, ok := m.entries[command]
	if !ok {
		return nil, false
	}

	if time.Now().After(entry.ExpiresAt) {
		return nil, false
	}

	slog.Info("L2 auth cache hit", "command", command, "window", entry.Window, "expires", entry.ExpiresAt)
	return entry, true
}

// RequestAuthorization creates an authorization request and notifies the user via ClawLess.
func (m *L2AuthManager) RequestAuthorization(ctx context.Context, task *clawless.Task, score float64, reason string) error {
	slog.Warn("L2 authorization required",
		"task_id", task.ID,
		"command", task.Command,
		"score", score,
		"reason", reason,
	)

	// Notify user via ClawLess API (Phase 3: send message to user)
	// For now, we log and return — the dispatcher will handle the notification
	return nil
}

// Authorize records an authorization decision.
func (m *L2AuthManager) Authorize(command string, window Window) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	entry := &L2AuthEntry{
		Command:   command,
		Window:    window,
		SessionID: m.sessionID,
	}

	switch window {
	case WindowOnce:
		entry.ExpiresAt = time.Now() // Only valid for immediate use
	case Window10Min:
		entry.ExpiresAt = time.Now().Add(10 * time.Minute)
	case Window1Hour:
		entry.ExpiresAt = time.Now().Add(1 * time.Hour)
	case Window1Day:
		entry.ExpiresAt = time.Now().Add(24 * time.Hour)
	case WindowAlways:
		// Session-scoped: set far future, cleared on session end
		entry.ExpiresAt = time.Now().Add(365 * 24 * time.Hour)
	default:
		entry.ExpiresAt = time.Now().Add(10 * time.Minute)
	}

	m.entries[command] = entry
	slog.Info("L2 authorized", "command", command, "window", window, "expires", entry.ExpiresAt)
	return nil
}

// Revoke removes an authorization entry.
func (m *L2AuthManager) Revoke(command string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.entries, command)
}

// ClearSession removes all session-scoped entries.
func (m *L2AuthManager) ClearSession(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for cmd, entry := range m.entries {
		if entry.SessionID == sessionID || entry.Window == WindowAlways {
			delete(m.entries, cmd)
		}
	}
	slog.Info("L2 session cleared", "session_id", sessionID)
}

// ExpireStale removes expired entries.
func (m *L2AuthManager) ExpireStale() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for cmd, entry := range m.entries {
		if now.After(entry.ExpiresAt) {
			delete(m.entries, cmd)
		}
	}
}

// StartCleanup starts a background goroutine to clean expired entries.
func (m *L2AuthManager) StartCleanup(interval time.Duration) (stop func()) {
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

// FormatNotificationMessage formats the L2 authorization notification.
func FormatNotificationMessage(taskID, command string, score float64, reason string) string {
	return fmt.Sprintf(
		"⚠️ 高风险操作需要您的授权\n\n"+
			"任务 ID: %s\n"+
			"命令: %s\n"+
			"风险评分: %.2f/1.0\n"+
			"原因: %s\n\n"+
			"请选择授权时间窗口：\n"+
			"- once: 仅此次\n"+
			"- 10min: 10 分钟内同类操作自动放行\n"+
			"- 1hour: 1 小时内\n"+
			"- 1day: 今天内\n"+
			"- always: 本次会话内\n"+
			"- reject: 拒绝执行\n\n"+
			"回复对应选项即可。",
		taskID, command, score, reason,
	)
}
