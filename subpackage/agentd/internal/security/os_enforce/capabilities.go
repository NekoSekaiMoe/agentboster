//go:build linux
// +build linux

package os_enforce

// DangerousCaps returns the full list of Linux capabilities that should
// be dropped for any sandboxed agent process. These map directly to L0
// rule categories (privilege escalation, disk ops, network abuse, etc.).
func DangerousCaps() []string {
	return []string{
		// === Privilege escalation ===
		"CAP_SYS_ADMIN",    // mount, ptrace, namespace, etc.
		"CAP_SYS_PTRACE",   // process tracing
		"CAP_SYS_RAWIO",    // raw I/O (dd to /dev/)
		"CAP_SYS_BOOT",     // reboot
		"CAP_SYS_MODULE",   // kernel module loading
		"CAP_SYS_TIME",     // clock manipulation
		"CAP_SYS_TTY_CONFIG", // TTY config
		"CAP_SYS_NICE",     // process priority

		// === Network abuse ===
		"CAP_NET_ADMIN",    // iptables, routing, interface config
		"CAP_NET_RAW",      // raw sockets (nmap, ping spoofing)
		"CAP_NET_BROADCAST", // broadcast packets

		// === Filesystem manipulation ===
		"CAP_MKNOD",        // create device nodes
		"CAP_AUDIT_CONTROL", // audit subsystem
		"CAP_AUDIT_READ",
		"CAP_AUDIT_WRITE",

		// === IPC / namespace ===
		"CAP_IPC_LOCK",     // lock memory
		"CAP_IPC_OWNER",    // IPC bypass
		"CAP_SYS_IPC",      // IPC operations

		// === Other dangerous ===
		"CAP_LINUX_IMMUTABLE", // immutable file attr
		"CAP_LEASE",        // file leases
		"CAP_BLOCK_SUSPEND",
		"CAP_WAKE_ALARM",
		"CAP_SYS_PACCT",    // process accounting
		"CAP_SYS_CHROOT",   // chroot (prevent escape)
		"CAP_SYS_RESOURCE", // override resource limits
		"CAP_MAC_ADMIN",    // MAC policy
		"CAP_MAC_OVERRIDE", // MAC override
		"CAP_SYSLOG",       // kernel syslog
		"CAP_PERFMON",      // performance monitoring
		"CAP_BPF",          // BPF operations
		"CAP_CHECKPOINT_RESTORE",
	}
}

// BaselineKeep returns the minimum capabilities that a functional sandbox
// needs for normal agent operations (package install, build, file ops).
func BaselineKeep() []string {
	return []string{
		"CAP_CHOWN",          // change file ownership (npm install, etc.)
		"CAP_DAC_OVERRIDE",   // bypass file read/write checks (build tools)
		"CAP_FOWNER",         // bypass file ownership checks (chmod)
		"CAP_FSETID",         // set SUID/SGID bits
		"CAP_SETGID",         // set group ID (needed for suid helpers)
		"CAP_SETUID",         // set user ID (needed for suid helpers)
		"CAP_SETPCAP",        // set process capabilities
		"CAP_NET_BIND_SERVICE", // bind to ports < 1024
		"CAP_KILL",           // send signals to own processes
		"CAP_SETFCAP",        // set file capabilities
	}
}

// LXCFormatCaps converts capability names to LXC's lowercase format.
// LXC expects "cap_drop = sys_admin net_raw ..." (lowercase, no CAP_ prefix).
func LXCFormatCaps(caps []string) []string {
	result := make([]string, len(caps))
	for i, cap := range caps {
		name := cap
		if len(name) > 4 && name[:4] == "CAP_" {
			name = name[4:]
		}
		result[i] = toLower(name)
	}
	return result
}

func toLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
