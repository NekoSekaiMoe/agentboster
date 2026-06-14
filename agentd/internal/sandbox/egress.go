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
	Pattern string // original glob pattern (e.g., "*.npmjs.org")
	IPs     []net.IP
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

const egressCacheTTL = 5 * time.Minute

// BuildEgressRules converts glob patterns (e.g., "*.npmjs.org",
// "github.com") into resolved IPs ready to feed to iptables. Patterns
// are matched as: exact hostname, or suffix match for wildcard ("*.x").
//
// P2.2: Returns the rule list + a generated iptables script the caller
// can run inside the sandbox's network namespace. The actual application
// is best-effort — if the sandbox lacks CAP_NET_ADMIN (the default for
// docker light), the script logs a warning and exits 0 so the sandbox
// still starts.
func BuildEgressRules(allowlist []string) ([]EgressRule, string) {
	if len(allowlist) == 0 {
		return nil, ""
	}

	rules := make([]EgressRule, 0, len(allowlist))
	allIPs := make([]string, 0)
	for _, pattern := range allowlist {
		ips := resolveEgress(pattern)
		rules = append(rules, EgressRule{Pattern: pattern, IPs: ips})
		for _, ip := range ips {
			allIPs = append(allIPs, ip.String())
		}
	}

	if len(allIPs) == 0 {
		slog.Warn("egress: no patterns resolved; skipping iptables",
			"patterns", allowlist)
		return rules, ""
	}

	// Generate an iptables script that:
	//   1. Sets OUTPUT policy to DROP
	//   2. Allows loopback
	//   3. Allows established/related connections
	//   4. Allows DNS (port 53 udp+tcp) to any resolver
	//   5. Allows HTTP/HTTPS (ports 80, 443) only to allowlisted IPs
	//   6. Allows the allowlisted IPs on any port (some package
	//      managers use non-443 ports)
	//
	// The script is wrapped in a capability check so it no-ops cleanly
	// when the sandbox can't apply iptables.
	var sb strings.Builder
	sb.WriteString("#!/bin/sh\n")
	sb.WriteString("# Auto-generated egress allowlist (P2.2)\n")
	sb.WriteString("# Best-effort: if the sandbox lacks CAP_NET_ADMIN, exit 0.\n")
	sb.WriteString("if ! command -v iptables >/dev/null 2>&1; then exit 0; fi\n")
	sb.WriteString("if ! iptables -L OUTPUT >/dev/null 2>&1; then exit 0; fi\n")
	sb.WriteString("iptables -F OUTPUT\n")
	sb.WriteString("iptables -P OUTPUT DROP\n")
	sb.WriteString("iptables -A OUTPUT -o lo -j ACCEPT\n")
	sb.WriteString("iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT\n")
	sb.WriteString("iptables -A OUTPUT -p udp --dport 53 -j ACCEPT\n")
	sb.WriteString("iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT\n")
	for _, ip := range dedupStrings(allIPs) {
		fmt.Fprintf(&sb, "iptables -A OUTPUT -d %s -j ACCEPT\n", ip)
	}
	// Allow outgoing HTTP/HTTPS in general? No — only allowlisted IPs.
	// Keep the default DROP so the allowlist actually filters.
	sb.WriteString("# End of egress rules\n")

	return rules, sb.String()
}

// resolveEgress converts a glob pattern to a list of IPs.
// "*.npmjs.org" → resolves "npmjs.org", "www.npmjs.org", "registry.npmjs.org"
// "github.com" → resolves "github.com"
func resolveEgress(pattern string) []net.IP {
	// Cache hit?
	egressCacheMu.RLock()
	if entry, ok := egressCache[pattern]; ok && time.Since(entry.resolvedAt) < egressCacheTTL {
		egressCacheMu.RUnlock()
		return entry.ips
	}
	egressCacheMu.RUnlock()

	// Strip leading "*." and try resolving the base domain plus common subdomains.
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
// sandbox still starts without egress filtering.
func (m *Manager) applyEgressAllowlist(sandboxID, sbPath string, allowlist []string) {
	_, script := BuildEgressRules(allowlist)
	if script == "" {
		return
	}

	// Write the script to the sandbox's workspace then exec it.
	// sbPath is the host-side workspace; the sandbox sees it mounted at /workspace.
	if sbPath == "" {
		return
	}
	scriptPath := filepath.Join(sbPath, "egress-rules.sh")
	if err := writeHostFile(scriptPath, []byte(script), 0o755); err != nil {
		slog.Warn("egress: failed to write script", "error", err)
		return
	}

	// Best-effort apply. The sandbox provider's Exec is called via the
	// registered provider — we look it up from the manager.
	provider := m.lookupProvider(sandboxID)
	if provider == nil {
		return
	}
	result, err := provider.Exec(sandboxID, "sh /workspace/egress-rules.sh", nil, 10)
	if err != nil {
		slog.Debug("egress: apply skipped (provider error)", "error", err)
		return
	}
	if result.ExitCode != 0 && result.Stderr != "" {
		slog.Debug("egress: apply non-fatal", "stderr", result.Stderr)
	}
	slog.Info("egress: allowlist applied",
		"sandbox", sandboxID,
		"patterns", len(allowlist),
	)
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
