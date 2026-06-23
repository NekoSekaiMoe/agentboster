//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// EgressRule represents a single resolved egress rule.
// At apply time, glob patterns are resolved to concrete IPs via DNS.
type EgressRule struct {
	Pattern string   // original glob pattern (e.g., "*.npmjs.org")
	IPs     []net.IP // resolved IPs (IPv4 + IPv6)
}

// egressCache caches DNS resolutions so repeated sandbox creations with
// the same allowlist don't hammer the resolver.
var (
	egressCacheMu sync.RWMutex
	egressCache   = make(map[string]egressCacheEntry)
)

type egressCacheEntry struct {
	ips        []net.IP
	resolvedAt time.Time
}

const egressCacheTTL = 90 * time.Second

// egressRefresher tracks the background goroutine that periodically
// re-applies an allowlist to a sandbox so iptables rules track DNS
// rebinding of CDN-backed endpoints (npm registry, github.com, pypi…).
//
// P3.2: previously the egress script was applied exactly once at
// sandbox creation time. CDN/DNS-round-robin endpoints rotate their
// IP set every few minutes, so a sandbox that could reach github.com
// at t=0 started failing ~5 minutes later. The refresher re-runs the
// generator on a fixed cadence until Stop is called (typically from
// the sandbox manager when the sandbox is destroyed).
type egressRefresher struct {
	mu         sync.Mutex
	stopCh     chan struct{}
	stopped    bool
	sandboxID  string
	sbPath     string
	allowlist  []string
	provider   SandboxProvider
	interval   time.Duration
}

// egressRefreshers tracks live refreshers keyed by sandbox id so that
// manager.Destroy can stop them cleanly.
var (
	egressRefreshersMu sync.Mutex
	egressRefreshers   = make(map[string]*egressRefresher)
)

const defaultEgressRefreshInterval = 2 * time.Minute

// BuildEgressRules converts glob patterns (e.g., "*.npmjs.org",
// "github.com") into resolved IPs ready to feed to iptables/ip6tables.
// Patterns are matched as: exact hostname, or suffix match for wildcard
// ("*.x"). IPv4 and IPv6 addresses are both collected; the generated
// script applies iptables for IPv4 and ip6tables (when present) for
// IPv6, so dual-stack CDNs work transparently.
func BuildEgressRules(allowlist []string) ([]EgressRule, string) {
	if len(allowlist) == 0 {
		return nil, ""
	}

	rules := make([]EgressRule, 0, len(allowlist))
	v4 := make([]string, 0)
	v6 := make([]string, 0)
	for _, pattern := range allowlist {
		ips := resolveEgress(pattern)
		rules = append(rules, EgressRule{Pattern: pattern, IPs: ips})
		for _, ip := range ips {
			if ip.To4() != nil {
				v4 = append(v4, ip.String())
			} else {
				v6 = append(v6, ip.String())
			}
		}
	}

	if len(v4) == 0 && len(v6) == 0 {
		slog.Warn("egress: no patterns resolved; skipping iptables",
			"patterns", allowlist)
		return rules, ""
	}

	v4Body := buildEgressBlock("iptables", v4)
	v6Body := buildEgressBlock("ip6tables", v6)

	var sb strings.Builder
	sb.WriteString("#!/bin/sh\n")
	sb.WriteString("# Auto-generated egress allowlist (P3.2)\n")
	sb.WriteString("# Best-effort: if the sandbox lacks CAP_NET_ADMIN, exit 0.\n")
	sb.WriteString("# Refreshed periodically so DNS-rebinding CDNs keep working.\n")
	sb.WriteString("set -e\n")
	sb.WriteString(v4Body)
	sb.WriteString(v6Body)
	sb.WriteString("# End of egress rules\n")

	return rules, sb.String()
}

// buildEgressBlock emits one self-contained iptables/ip6tables block
// for a given family. The block is a no-op when the binary is absent
// (docker light) or when no IPs of that family were resolved.
func buildEgressBlock(binary string, ips []string) string {
	if len(ips) == 0 {
		return ""
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "if command -v %s >/dev/null 2>&1 && %s -L OUTPUT >/dev/null 2>&1; then\n", binary, binary)
	fmt.Fprintf(&sb, "  %s -F OUTPUT || true\n", binary)
	fmt.Fprintf(&sb, "  %s -P OUTPUT DROP || true\n", binary)
	fmt.Fprintf(&sb, "  %s -A OUTPUT -o lo -j ACCEPT || true\n", binary)
	fmt.Fprintf(&sb, "  %s -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT || true\n", binary)
	fmt.Fprintf(&sb, "  %s -A OUTPUT -p udp --dport 53 -j ACCEPT || true\n", binary)
	fmt.Fprintf(&sb, "  %s -A OUTPUT -p tcp --dport 53 -j ACCEPT || true\n", binary)
	for _, ip := range dedupStrings(ips) {
		fmt.Fprintf(&sb, "  %s -A OUTPUT -d %s -j ACCEPT || true\n", binary, ip)
	}
	sb.WriteString("fi\n")
	return sb.String()
}

// resolveEgress converts a glob pattern to a list of IPs (v4 + v6).
// "*.npmjs.org" → resolves "npmjs.org", "www.npmjs.org", "registry.npmjs.org"
// "github.com" → resolves "github.com"
func resolveEgress(pattern string) []net.IP {
	egressCacheMu.RLock()
	if entry, ok := egressCache[pattern]; ok && time.Since(entry.resolvedAt) < egressCacheTTL {
		egressCacheMu.RUnlock()
		return entry.ips
	}
	egressCacheMu.RUnlock()

	candidates := []string{pattern}
	if strings.HasPrefix(pattern, "*.") {
		base := pattern[2:]
		candidates = []string{
			base,
			"www." + base,
			"registry." + base,
			"api." + base,
		}
	}

	var ips []net.IP
	for _, host := range candidates {
		resolved, err := net.LookupHost(host)
		if err != nil {
			continue
		}
		for _, r := range resolved {
			if ip := net.ParseIP(r); ip != nil {
				ips = append(ips, ip)
			}
		}
	}

	egressCacheMu.Lock()
	egressCache[pattern] = egressCacheEntry{ips: ips, resolvedAt: time.Now()}
	egressCacheMu.Unlock()

	if len(ips) == 0 {
		slog.Warn("egress: pattern resolved to no IPs", "pattern", pattern)
	}
	return ips
}

// applyEgressAllowlist writes the iptables script to the sandbox and
// tries to apply it via a one-shot exec. Failures are non-fatal — the
// sandbox still starts without egress filtering. A background refresher
// is started so DNS rebinding of CDN-backed endpoints is tracked.
func (m *Manager) applyEgressAllowlist(sandboxID, sbPath string, allowlist []string) {
	_, script := BuildEgressRules(allowlist)
	if script == "" {
		return
	}

	if sbPath == "" {
		return
	}
	scriptPath := filepath.Join(sbPath, "egress-rules.sh")
	if err := writeHostFile(scriptPath, []byte(script), 0o755); err != nil {
		slog.Warn("egress: failed to write script", "error", err)
		return
	}

	provider := m.lookupProvider(sandboxID)
	if provider == nil {
		return
	}
	result, err := provider.Exec(sandboxID, "sh /workspace/egress-rules.sh", nil, 10)
	if err != nil {
		slog.Debug("egress: apply skipped (provider error)", "error", err)
	} else if result.ExitCode != 0 && result.Stderr != "" {
		slog.Debug("egress: apply non-fatal", "stderr", result.Stderr)
	}
	slog.Info("egress: allowlist applied",
		"sandbox", sandboxID,
		"patterns", len(allowlist),
	)

	m.startEgressRefresher(sandboxID, sbPath, allowlist, provider, defaultEgressRefreshInterval)
}

// startEgressRefresher runs a background goroutine that regenerates
// and re-applies the egress script on a fixed cadence. This keeps the
// iptables rules in sync with DNS rebinding used by CDN-backed package
// registries (npm / pypi / GitHub releases) so a sandbox that worked
// at creation time doesn't silently lose connectivity five minutes
// later.
//
// Only one refresher per sandbox is allowed; starting again for the
// same id stops the previous one first.
func (m *Manager) startEgressRefresher(sandboxID, sbPath string, allowlist []string, provider SandboxProvider, interval time.Duration) {
	if interval <= 0 {
		return
	}

	m.StopEgressRefresher(sandboxID)

	r := &egressRefresher{
		stopCh:    make(chan struct{}),
		sandboxID: sandboxID,
		sbPath:    sbPath,
		allowlist: allowlist,
		provider:  provider,
		interval:  interval,
	}

	egressRefreshersMu.Lock()
	egressRefreshers[sandboxID] = r
	egressRefreshersMu.Unlock()

	// Drop the cached resolutions so the first refresh tick uses fresh
	// DNS data instead of whatever the creation-time resolve cached.
	flushEgressCacheFor(allowlist)

	go r.loop()
}

// StopEgressRefresher stops the background refresher for a sandbox, if
// one is running. Safe to call unconditionally (destroy path, etc.).
func (m *Manager) StopEgressRefresher(sandboxID string) {
	egressRefreshersMu.Lock()
	r := egressRefreshers[sandboxID]
	delete(egressRefreshers, sandboxID)
	egressRefreshersMu.Unlock()
	if r == nil {
		return
	}
	r.stop()
}

func (r *egressRefresher) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return
	}
	r.stopped = true
	close(r.stopCh)
}

func (r *egressRefresher) loop() {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.tick()
		}
	}
}

func (r *egressRefresher) tick() {
	// Force fresh DNS resolution by flushing only the patterns in this
	// sandbox's allowlist (other sandboxes may still benefit from their
	// own cache).
	flushEgressCacheFor(r.allowlist)

	_, script := BuildEgressRules(r.allowlist)
	if script == "" {
		return
	}
	scriptPath := filepath.Join(r.sbPath, "egress-rules.sh")
	if err := writeHostFile(scriptPath, []byte(script), 0o755); err != nil {
		slog.Debug("egress refresh: write failed",
			"sandbox", r.sandboxID,
			"error", err,
		)
		return
	}
	if _, err := r.provider.Exec(r.sandboxID, "sh /workspace/egress-rules.sh", nil, 10); err != nil {
		slog.Debug("egress refresh: exec failed",
			"sandbox", r.sandboxID,
			"error", err,
		)
		return
	}
	slog.Debug("egress refresh: applied",
		"sandbox", r.sandboxID,
		"patterns", len(r.allowlist),
	)
}

// flushEgressCacheFor drops cached DNS resolutions for the given
// patterns so the next BuildEgressRules call performs fresh lookups.
func flushEgressCacheFor(patterns []string) {
	egressCacheMu.Lock()
	defer egressCacheMu.Unlock()
	for _, p := range patterns {
		delete(egressCache, p)
	}
}

// writeHostFile is a thin helper for writing to the host-side workspace
// path (the sandbox mounts this at /workspace).
func writeHostFile(path string, data []byte, mode uint32) error {
	return hostWriteFile(path, data, mode)
}

// hostWriteFile is replaced by a real os.WriteFile call in non-test
// builds. Using an indirection makes this package testable without
// hitting the actual filesystem.
var hostWriteFile = defaultHostWriteFile

func defaultHostWriteFile(path string, data []byte, mode uint32) error {
	return os.WriteFile(path, data, os.FileMode(mode))
}

// osWriteFile kept as a stable name for tests that swap it out.
var osWriteFile = func(path string, data []byte, mode uint32) error {
	return os.WriteFile(path, data, os.FileMode(mode))
}

// lookupProvider finds the provider that owns the sandbox.
// (sandbox ownership is tracked in m.sandboxes; provider is identified
// by the sandbox's Type.)
func (m *Manager) lookupProvider(sandboxID string) SandboxProvider {
	m.mu.RLock()
	defer m.mu.RUnlock()
	sb, ok := m.sandboxes[sandboxID]
	if !ok {
		return nil
	}
	return m.providers[sb.Type]
}

func dedupStrings(xs []string) []string {
	seen := make(map[string]bool, len(xs))
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}
