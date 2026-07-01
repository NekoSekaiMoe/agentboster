//go:build linux
// +build linux

package l0_rules

import (
	"context"
	"log/slog"
	"time"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// Loader periodically fetches L0 rules from ClawLess API and hot-reloads the engine.
type Loader struct {
	engine   *Engine
	client   *clawless.Client
	agentID  string
	interval time.Duration
	stopCh   chan struct{}
}

// NewLoader creates a new L0 rules loader.
func NewLoader(engine *Engine, client *clawless.Client, agentID string, interval time.Duration) *Loader {
	return &Loader{
		engine:   engine,
		client:   client,
		agentID:  agentID,
		interval: interval,
		stopCh:   make(chan struct{}),
	}
}

// Start begins the periodic rule fetch loop.
func (l *Loader) Start() {
	// Fetch immediately on start
	l.fetchAndReload()

	go func() {
		ticker := time.NewTicker(l.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				l.fetchAndReload()
			case <-l.stopCh:
				return
			}
		}
	}()
	slog.Info("L0 rules loader started", "agent_id", l.agentID, "interval", l.interval)
}

// Stop stops the loader.
func (l *Loader) Stop() {
	close(l.stopCh)
}

func (l *Loader) fetchAndReload() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	rules, err := l.client.GetL0Rules(ctx, l.agentID)
	if err != nil {
		slog.Warn("failed to fetch L0 rules from ClawLess, using existing rules", "error", err)
		return
	}

	// Convert from clawless.L0Rule to l0_rules.L0Rule
	localRules := make([]L0Rule, len(rules))
	for i, r := range rules {
		localRules[i] = L0Rule{
			ID:      r.ID,
			Pattern: r.Pattern,
			Type:    r.Type,
			Action:  r.Action,
			Scope:   r.Scope,
		}
	}

	if err := l.engine.Reload(localRules); err != nil {
		slog.Error("failed to reload L0 rules", "error", err)
	}
}
