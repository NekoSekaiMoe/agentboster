package sandbox

import (
	"fmt"

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
func ParseMemSpec(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	last := s[len(s)-1]
	mult := int64(1)
	num := s
	switch last {
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
	var n int64
	if _, err := fmt.Sscanf(num, "%d", &n); err != nil {
		return 0, false
	}
	return n * mult, true
}
