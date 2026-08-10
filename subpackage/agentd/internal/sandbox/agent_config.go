package sandbox

import (
	"math"
	"strconv"
	"strings"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// ApplyAgentConfigToSpec populates the resource knobs on a SandboxSpec
// from a (possibly nil) clawless.AgentConfig. Nil cfg → no-op (provider
// defaults apply).
//
// Shared by the worker dispatcher (task sandboxes) and the agent
// manager's ExecuteTool workspace path (M0b lazy LXC create) so both
// honor the same per-agent sandbox overrides (P1.1: CPU/mem/pids/disk/
// blkio) and the P2.2 egress allowlist. Previously this logic lived
// unexported in internal/worker, leaving the ExecuteTool workspace spec
// without any of these knobs.
func ApplyAgentConfigToSpec(spec *SandboxSpec, cfg *clawless.AgentConfig) {
	if cfg == nil {
		return
	}
	if cfg.SandboxCPU != nil {
		spec.CPULimit = *cfg.SandboxCPU
	}
	if cfg.SandboxMem != "" {
		// Parse "256m"/"1g" into bytes; ignore on parse error.
		if bytes, ok := ParseMemSpec(cfg.SandboxMem); ok {
			spec.MemoryLimit = bytes
		}
	}
	if cfg.SandboxPids != nil {
		spec.PidsLimit = *cfg.SandboxPids
	}
	if cfg.SandboxDisk != "" {
		spec.DiskLimit = cfg.SandboxDisk
	}
	if cfg.SandboxBlkioWeight != nil {
		spec.BlkioWeight = *cfg.SandboxBlkioWeight
	}
	if len(cfg.EgressAllowlist) > 0 {
		spec.EgressAllowlist = append(spec.EgressAllowlist, cfg.EgressAllowlist...)
	}
}

// ParseMemSpec parses memory strings like "256m", "1g", "1024" into bytes.
// Suffixes: k/K = KiB, m/M = MiB, g/G = GiB, none = bytes. The ENTIRE
// numeric portion must be a base-10 integer — fmt.Sscanf's partial-parse
// %d used to accept "256mb" (256 bytes), "1.5g" (1 GiB), and "-5g"
// (negative bytes), and never checked n*mult overflow; all of those are
// now rejected. Returns (0, false) for any invalid input.
func ParseMemSpec(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	mult := int64(1)
	num := s
	switch s[len(s)-1] {
	case 'g', 'G':
		mult = 1024 * 1024 * 1024
		num = s[:len(s)-1]
	case 'm', 'M':
		mult = 1024 * 1024
		num = s[:len(s)-1]
	case 'k', 'K':
		mult = 1024
		num = s[:len(s)-1]
	}
	// ParseInt validates the whole string: rejects empty ("g"), decimals
	// ("1.5"), trailing junk ("256b" after suffix strip), and non-digits.
	n, err := strconv.ParseInt(num, 10, 64)
	if err != nil {
		return 0, false
	}
	if n <= 0 {
		return 0, false
	}
	if n > math.MaxInt64/mult {
		return 0, false
	}
	return n * mult, true
}
