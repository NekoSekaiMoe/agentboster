//go:build linux
// +build linux

package l0_rules

import (
	"fmt"
	"log/slog"
	"path"
	"regexp"
	"strings"
	"sync"
)

// L0Rule represents a level-0 security rule.
type L0Rule struct {
	ID      string `json:"id" toml:"id"`
	Pattern string `json:"pattern" toml:"pattern"`
	Type    string `json:"type" toml:"type"`     // "command", "path", "network"
	Action  string `json:"action" toml:"action"` // "block"
	Scope   string `json:"scope" toml:"scope"`   // "workspace", "global"
}

// L0Result is the result of an L0 check.
type L0Result struct {
	Blocked bool
	Rule    L0Rule
	Reason  string
}

// Engine is the L0 rules engine (replicating Asika Label Rules + Spam Detector).
type Engine struct {
	mu             sync.RWMutex
	rules          []L0Rule
	compiledRegexp sync.Map // map[string]*regexp.Regexp — concurrent-safe cache
}

// NewEngine creates a new L0 rules engine with default presets.
func NewEngine() *Engine {
	e := &Engine{}
	e.rules = DefaultPresets()
	return e
}

// Check evaluates a command against all L0 rules.
// L0 only blocks — no warn escalation. Anything not blocked passes to L1.
func (e *Engine) Check(command, workDir string) (*L0Result, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, rule := range e.rules {
		matched, err := e.matchRule(rule, command, workDir)
		if err != nil {
			slog.Warn("L0 rule match error", "rule_id", rule.ID, "error", err)
			continue
		}
		if !matched {
			continue
		}

		if rule.Action == "block" {
			slog.Warn("L0 blocked", "rule_id", rule.ID, "command", command)
			return &L0Result{
				Blocked: true,
				Rule:    rule,
				Reason:  fmt.Sprintf("L0 rule matched: %s (pattern: %s, type: %s)", rule.ID, rule.Pattern, rule.Type),
			}, nil
		}
	}

	return nil, nil
}

// matchRule checks if a single rule matches the command or workDir.
func (e *Engine) matchRule(rule L0Rule, command, workDir string) (bool, error) {
	switch rule.Type {
	case "command":
		return e.matchPattern(rule.Pattern, command)
	case "path":
		// Check both command and workDir for path access
		matched, err := e.matchPattern(rule.Pattern, command)
		if err != nil || matched {
			return matched, err
		}
		return e.matchPattern(rule.Pattern, workDir)
	case "network":
		return e.matchPattern(rule.Pattern, command)
	default:
		return e.matchPattern(rule.Pattern, command)
	}
}

// matchPattern matches a pattern against a target string.
// Replicates Asika's two-step cascade: glob first, then regex.
func (e *Engine) matchPattern(pattern, target string) (bool, error) {
	// Step 1: Glob matching (if pattern contains glob chars)
	if strings.ContainsAny(pattern, "*?[") {
		matched, err := path.Match(pattern, target)
		if err != nil {
			// Invalid glob — fall through to regex
			slog.Debug("glob match error, falling back to regex", "pattern", pattern, "error", err)
		} else if matched {
			return true, nil
		}
	}

	// Step 2: Regex matching (using sync.Map to avoid deadlock with Check's RLock)
	if cached, ok := e.compiledRegexp.Load(pattern); ok {
		return cached.(*regexp.Regexp).MatchString(target), nil
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return false, fmt.Errorf("invalid regex pattern %q: %w", pattern, err)
	}
	e.compiledRegexp.Store(pattern, re)

	return re.MatchString(target), nil
}

// Reload replaces all rules (hot-reload from ClawLess API).
func (e *Engine) Reload(rules []L0Rule) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Validate all patterns before applying
	for _, rule := range rules {
		if rule.Pattern == "" {
			return fmt.Errorf("rule %s has empty pattern", rule.ID)
		}
		if _, err := regexp.Compile(rule.Pattern); err != nil {
			return fmt.Errorf("rule %s has invalid pattern %q: %w", rule.ID, rule.Pattern, err)
		}
	}

	e.rules = rules
	e.compiledRegexp = sync.Map{} // clear cache
	slog.Info("L0 rules reloaded", "count", len(rules))
	return nil
}

// AddRule adds a single rule.
func (e *Engine) AddRule(rule L0Rule) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rules = append(e.rules, rule)
	slog.Info("L0 rule added", "rule_id", rule.ID)
	return nil
}

// Rules returns a copy of current rules.
func (e *Engine) Rules() []L0Rule {
	e.mu.RLock()
	defer e.mu.RUnlock()
	result := make([]L0Rule, len(e.rules))
	copy(result, e.rules)
	return result
}
