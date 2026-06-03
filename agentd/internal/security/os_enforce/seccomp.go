//go:build linux
// +build linux

package os_enforce

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SeccompProfile represents a seccomp-bpf profile for container sandboxes.
// Compatible with Docker's --security-opt seccomp= JSON format.
type SeccompProfile struct {
	DefaultAction string        `json:"defaultAction"`
	Architectures []string      `json:"architectures,omitempty"`
	Syscalls      []SyscallRule `json:"syscalls"`
}

// SyscallRule defines an action for a set of syscalls.
type SyscallRule struct {
	Names  []string `json:"names"`
	Action string   `json:"action"`
	Args   []Arg    `json:"args,omitempty"`
}

// Arg defines a syscall argument filter (for fine-grained seccomp rules).
type Arg struct {
	Index    uint   `json:"index"`
	Value    uint64 `json:"value"`
	ValueTwo uint64 `json:"valueTwo,omitempty"`
	Op       string `json:"op"` // "SCMP_CMP_EQ", "SCMP_CMP_MASKED_EQ"
}

// Docker seccomp actions
const (
	ActAllow = "SCMP_ACT_ALLOW"
	ActErrno = "SCMP_ACT_ERRNO"
	ActKill  = "SCMP_ACT_KILL_PROCESS"
	ActTrap  = "SCMP_ACT_TRAP"
)

// DefaultHardened returns a baseline seccomp profile that blocks dangerous
// syscalls while allowing normal container operations. This is more
// restrictive than Docker's default profile.
func DefaultHardened() *SeccompProfile {
	return &SeccompProfile{
		DefaultAction: ActAllow,
		Architectures: []string{
			"SCMP_ARCH_X86_64",
			"SCMP_ARCH_X86",
			"SCMP_ARCH_AARCH64",
		},
		Syscalls: []SyscallRule{
			// === Kernel module loading ===
			{
				Names:  []string{"init_module", "finit_module", "delete_module"},
				Action: ActErrno,
			},
			// === Kernel execution ===
			{
				Names:  []string{"kexec_load", "kexec_file_load"},
				Action: ActErrno,
			},
			// === System reboot/poweroff ===
			{
				Names:  []string{"reboot"},
				Action: ActErrno,
			},
			// === Mount operations (prevent filesystem manipulation) ===
			{
				Names:  []string{"mount", "umount2", "pivot_root"},
				Action: ActErrno,
			},
			// === Process tracing (prevent container escape via ptrace) ===
			{
				Names:  []string{"ptrace", "process_vm_readv", "process_vm_writev"},
				Action: ActErrno,
			},
			// === Swap operations ===
			{
				Names:  []string{"swapon", "swapoff"},
				Action: ActErrno,
			},
			// === Kernel logging ===
			{
				Names:  []string{"syslog"},
				Action: ActErrno,
			},
			// === x86 legacy ===
			{
				Names:  []string{"vm86", "vm86old", "modify_ldt"},
				Action: ActErrno,
			},
			// === Namespace creation (prevent nested container escapes) ===
			{
				Names:  []string{"unshare", "clone3"},
				Action: ActErrno,
			},
			// === BPF/JIT (prevent kernel code injection) ===
			{
				Names:  []string{"bpf", "perf_event_open"},
				Action: ActErrno,
			},
			// === Keyring (prevent credential theft) ===
			{
				Names:  []string{"add_key", "request_key", "keyctl"},
				Action: ActErrno,
			},
			// === Memory protection bypass ===
			{
				Names:  []string{"memfd_create"},
				Action: ActErrno,
			},
			// === User namespace (prevent UID mapping attacks) ===
			{
				Names:  []string{"setns"},
				Action: ActErrno,
			},
			// === Dangerous ioctl subset ===
			{
				Names:  []string{"ioctl"},
				Action: ActErrno,
				Args: []Arg{
					{
						Index: 1,
						Value: 0x5412, // TIOCSTI (terminal injection)
						Op:    "SCMP_CMP_EQ",
					},
				},
			},
		},
	}
}

// ToDockerJSON serializes the profile to Docker's seccomp JSON format.
func (p *SeccompProfile) ToDockerJSON() ([]byte, error) {
	if p == nil {
		return nil, fmt.Errorf("nil seccomp profile")
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal seccomp profile: %w", err)
	}
	return data, nil
}

// ToLXCFormat serializes the profile to LXC's seccomp text format.
// LXC uses a line-based format: [rule] followed by syscall name = action.
func (p *SeccompProfile) ToLXCFormat() string {
	if p == nil {
		return ""
	}
	var sb strings.Builder

	sb.WriteString("2\n") // version

	defaultAction := lxcAction(p.DefaultAction)
	sb.WriteString(fmt.Sprintf("[all]\n"))
	sb.WriteString(fmt.Sprintf("default = %s\n", defaultAction))

	for _, rule := range p.Syscalls {
		action := lxcAction(rule.Action)
		for _, name := range rule.Names {
			if len(rule.Args) > 0 {
				// LXC supports arg filtering with [syscall,arg=value,op]
				for _, arg := range rule.Args {
					sb.WriteString(fmt.Sprintf("[%s,arg=%d=%d,%s]\n",
						name, arg.Index, arg.Value, lxcOp(arg.Op)))
					sb.WriteString(fmt.Sprintf("default = %s\n", action))
				}
			} else {
				sb.WriteString(fmt.Sprintf("[%s]\n", name))
				sb.WriteString(fmt.Sprintf("default = %s\n", action))
			}
		}
	}

	return sb.String()
}

func lxcAction(action string) string {
	switch action {
	case ActAllow:
		return "allow"
	case ActErrno:
		return "errno"
	case ActKill:
		return "kill"
	case ActTrap:
		return "trap"
	default:
		return "errno"
	}
}

func lxcOp(op string) string {
	switch op {
	case "SCMP_CMP_EQ":
		return "eq"
	case "SCMP_CMP_MASKED_EQ":
		return "masked_eq"
	default:
		return "eq"
	}
}
