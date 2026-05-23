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
		{ID: "cmd-nc-listen", Pattern: "nc\\s+-l", Type: "command", Action: "warn", Scope: "global"},
		{ID: "cmd-ncat-listen", Pattern: "ncat\\s+-l", Type: "command", Action: "warn", Scope: "global"},
		{ID: "cmd-python-http", Pattern: "python\\s+-m\\s+http\\.server", Type: "command", Action: "warn", Scope: "global"},

		// === Path blacklist (block) ===
		{ID: "path-etc-shadow", Pattern: "/etc/shadow", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-etc-passwd", Pattern: "/etc/passwd", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-etc-ssh", Pattern: "/etc/ssh/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-proc", Pattern: "/proc/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-sys", Pattern: "/sys/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-root-ssh", Pattern: "/root/.ssh/", Type: "path", Action: "block", Scope: "global"},
		{ID: "path-home-ssh", Pattern: "~/.ssh/", Type: "path", Action: "block", Scope: "global"},

		// === Network blacklist (warn) ===
		{ID: "net-nmap", Pattern: "nmap\\s", Type: "network", Action: "block", Scope: "global"},
		{ID: "net-masscan", Pattern: "masscan", Type: "network", Action: "block", Scope: "global"},
		{ID: "net-hydra", Pattern: "hydra", Type: "network", Action: "block", Scope: "global"},
	}
}
