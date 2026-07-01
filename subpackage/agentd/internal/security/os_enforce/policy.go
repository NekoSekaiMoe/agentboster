//go:build linux
// +build linux

package os_enforce

import (
	"log/slog"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/l0_rules"
)

// OSPolicy represents OS-level security enforcement derived from L0 rules.
// It is consumed by sandbox providers to configure seccomp, capabilities,
// mount restrictions, and network isolation.
type OSPolicy struct {
	// Seccomp profile to apply (nil = no custom seccomp).
	Seccomp *SeccompProfile

	// CapDrop lists capabilities to explicitly drop.
	CapDrop []string

	// CapKeep lists capabilities to keep after dropping ALL.
	CapKeep []string

	// MaskedPaths are paths where /dev/null is bind-mounted over them,
	// making reads return empty and writes silently discarded.
	MaskedPaths []string

	// ReadonlyPaths are paths mounted read-only.
	ReadonlyPaths []string

	// NetworkNone disables network access entirely.
	NetworkNone bool
}

// CategorizedRules groups L0 rules by their security sub-type for OS mapping.
type CategorizedRules struct {
	PrivEscalation []l0_rules.L0Rule // sudo, su
	FilePerms      []l0_rules.L0Rule // chmod, chown
	SystemControl  []l0_rules.L0Rule // shutdown, reboot, killall, pkill
	DiskOps        []l0_rules.L0Rule // fdisk, mkfs, dd, wipefs
	NetScan        []l0_rules.L0Rule // nmap, masscan, hydra
	PathBlock      []l0_rules.L0Rule // /etc/shadow, /proc/, /sys/
	Destructive    []l0_rules.L0Rule // rm -rf /
	RemoteExec     []l0_rules.L0Rule // curl|bash, wget|sh
}

// ruleSubType classifies an L0 rule by inspecting its ID and pattern.
func ruleSubType(rule l0_rules.L0Rule) string {
	id := strings.ToLower(rule.ID)

	switch {
	case strings.Contains(id, "sudo") || strings.Contains(id, "su-"):
		return "privesc"
	case strings.Contains(id, "chmod") || strings.Contains(id, "chown"):
		return "fileperms"
	case strings.Contains(id, "shutdown") || strings.Contains(id, "reboot") ||
		strings.Contains(id, "killall") || strings.Contains(id, "pkill"):
		return "syscontrol"
	case strings.Contains(id, "fdisk") || strings.Contains(id, "mkfs") ||
		strings.Contains(id, "dd-dev") || strings.Contains(id, "wipefs"):
		return "diskops"
	case strings.Contains(id, "nmap") || strings.Contains(id, "masscan") ||
		strings.Contains(id, "hydra"):
		return "netscan"
	case strings.Contains(id, "curl-pipe") || strings.Contains(id, "wget-pipe"):
		return "remoteexec"
	case strings.Contains(id, "rm-rf"):
		return "destructive"
	case rule.Type == "path":
		return "pathblock"
	default:
		return "other"
	}
}

// CategorizeRules groups L0 rules by security sub-type.
func CategorizeRules(rules []l0_rules.L0Rule) *CategorizedRules {
	cat := &CategorizedRules{}
	for _, rule := range rules {
		switch ruleSubType(rule) {
		case "privesc":
			cat.PrivEscalation = append(cat.PrivEscalation, rule)
		case "fileperms":
			cat.FilePerms = append(cat.FilePerms, rule)
		case "syscontrol":
			cat.SystemControl = append(cat.SystemControl, rule)
		case "diskops":
			cat.DiskOps = append(cat.DiskOps, rule)
		case "netscan":
			cat.NetScan = append(cat.NetScan, rule)
		case "pathblock":
			cat.PathBlock = append(cat.PathBlock, rule)
		case "destructive":
			cat.Destructive = append(cat.Destructive, rule)
		case "remoteexec":
			cat.RemoteExec = append(cat.RemoteExec, rule)
		default:
			slog.Debug("L0 rule uncategorized", "rule_id", rule.ID, "type", rule.Type)
		}
	}
	return cat
}

// FromL0Rules converts L0 rules into an OSPolicy that sandbox providers
// can use to configure OS-level enforcement.
func FromL0Rules(rules []l0_rules.L0Rule) *OSPolicy {
	cat := CategorizeRules(rules)

	policy := &OSPolicy{
		Seccomp:     DefaultHardened(),
		CapDrop:     DangerousCaps(),
		CapKeep:     BaselineKeep(),
		NetworkNone: true, // default: isolate network
	}

	// Path rules → masked or readonly paths
	for _, rule := range cat.PathBlock {
		path := extractPathFromPattern(rule.Pattern)
		if path == "" {
			continue
		}
		switch {
		case path == "/proc/" || path == "/sys/":
			policy.ReadonlyPaths = append(policy.ReadonlyPaths, strings.TrimSuffix(path, "/"))
		default:
			policy.MaskedPaths = append(policy.MaskedPaths, path)
		}
	}

	// If no net-scan rules exist, still keep network isolated as baseline
	// (the user can override via config)
	if len(cat.NetScan) == 0 {
		slog.Debug("no network scan rules, keeping network isolated by default")
	}

	// Deduplicate
	policy.CapDrop = uniqueStrings(policy.CapDrop)
	policy.CapKeep = uniqueStrings(policy.CapKeep)
	policy.MaskedPaths = uniqueStrings(policy.MaskedPaths)
	policy.ReadonlyPaths = uniqueStrings(policy.ReadonlyPaths)

	slog.Info("OS policy generated from L0 rules",
		"cap_drop", len(policy.CapDrop),
		"cap_keep", len(policy.CapKeep),
		"masked_paths", len(policy.MaskedPaths),
		"readonly_paths", len(policy.ReadonlyPaths),
		"network_none", policy.NetworkNone,
	)

	return policy
}

// extractPathFromPattern extracts a filesystem path from an L0 rule pattern.
// Handles patterns like "/etc/shadow", "/proc/", "~/.ssh/".
func extractPathFromPattern(pattern string) string {
	p := strings.TrimSpace(pattern)
	if p == "" || strings.ContainsAny(p, "*?[](){}|\\") {
		return ""
	}
	// Expand ~ to a placeholder (sandbox maps /root)
	if strings.HasPrefix(p, "~/") {
		p = "/root/" + p[2:]
	}
	return p
}

func uniqueStrings(ss []string) []string {
	seen := make(map[string]struct{}, len(ss))
	result := make([]string, 0, len(ss))
	for _, s := range ss {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		result = append(result, s)
	}
	return result
}
