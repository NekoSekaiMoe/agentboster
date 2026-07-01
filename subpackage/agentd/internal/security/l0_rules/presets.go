//go:build linux
// +build linux

package l0_rules

// DefaultPresets returns the built-in L0 rules (dangerous commands + path blocks).
func DefaultPresets() []L0Rule {
	return []L0Rule{
		// === Command blacklist (block) ===
		{ID: "cmd-rm-rf-root", Pattern: "rm -rf /", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-rm-rf-slash", Pattern: "rm -rf /*", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-mkfs", Pattern: "mkfs\\.*", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-dd-dev", Pattern: "dd if=.* of=/dev/", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-fdisk", Pattern: "fdisk", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-wipefs", Pattern: "wipefs", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-curl-pipe-bash", Pattern: "curl.*\\|\\s*bash", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-wget-pipe-sh", Pattern: "wget.*\\|\\s*sh", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-sudo", Pattern: "sudo\\s", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-su-", Pattern: "su\\s+-", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-chmod-777", Pattern: "chmod\\s+777", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-chown-root", Pattern: "chown\\s+root", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-iptables-flush", Pattern: "iptables\\s+-F", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-shutdown", Pattern: "shutdown", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-reboot", Pattern: "reboot", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-killall", Pattern: "killall", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-pkill", Pattern: "pkill", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-nc-listen", Pattern: "nc\\s+-l", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-ncat-listen", Pattern: "ncat\\s+-l", Type: "command", Action: "block", Scope: "global"},
		{ID: "cmd-python-http", Pattern: "python\\s+-m\\s+http\\.server", Type: "command", Action: "block", Scope: "global"},

		// === Path blacklist (block) ===
		{ID: "path-etc-shadow", Pattern: "/etc/shadow", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-etc-passwd", Pattern: "/etc/passwd", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-etc-ssh", Pattern: "/etc/ssh/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-proc", Pattern: "/proc/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-sys", Pattern: "/sys/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-root-ssh", Pattern: "/root/.ssh/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-home-ssh", Pattern: "~/.ssh/", Type: "path", Action: "block", Scope: "global"},

		// === Network blacklist (block) ===
		{ID: "net-nmap", Pattern: "nmap\\s", Type: "network", Action: "block", Scope: "global"},
		{ID: "net-masscan", Pattern: "masscan", Type: "network", Action: "block", Scope: "global"},
		{ID: "net-hydra", Pattern: "hydra", Type: "network", Action: "block", Scope: "global"},
 	}
}

// DefaultOutputRules returns built-in rules for validating LLM output content.
// These detect system prompt leaks, credential exposure, and injection patterns.
func DefaultOutputRules() []L0Rule {
	return []L0Rule{
		// === System prompt leak detection ===
		{
			ID:     "out-system-prompt-leak",
			Pattern: `(?i)(your\s+system\s+prompt|you\s+are\s+(AgentBoster|ClawLess)|##\s*安全规则|##\s*Safe|##\s*能力|##\s*沙箱选择策略)`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
		{
			ID:     "out-instruction-leak",
			Pattern: `(?i)(ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)|you\s+are\s+now\s+|DAN\s+mode|jailbreak|忽略.*之前的.*指令)`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
		// === Credential exposure detection ===
		{
			ID:     "out-api-key-leak",
			Pattern: `(?i)(api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9_\-]{16,}|Bearer\s+[a-zA-Z0-9_\-\.]{20,})`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
		{
			ID:     "out-password-leak",
			Pattern: `(?i)(password\s*[:=]\s*["']?[^\s"']{8,}|passwd\s*[:=]\s*["']?[^\s"']{8,})`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
		{
			ID:     "out-private-key-leak",
			Pattern: `-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
		// === Internal path leak detection ===
		{
			ID:     "out-internal-path-leak",
			Pattern: `(?i)(/etc/shadow|/etc/passwd|/etc/ssh/ssh_host|/proc/self/environ|/root/\.ssh/)`,
			Type:   "command",
			Action: "block",
			Scope:  "global",
		},
	}
}
