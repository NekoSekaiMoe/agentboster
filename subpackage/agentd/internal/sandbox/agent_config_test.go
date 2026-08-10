//go:build linux
// +build linux

package sandbox

import (
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// TestParseMemSpec covers the P1.1 memory string parser used by
// ApplyAgentConfigToSpec. Edge cases: k/m/g suffixes, no suffix, invalid.
func TestParseMemSpec(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in     string
		want   int64
		wantOk bool
	}{
		// Valid: k/m/g suffixes (both cases), no suffix, whitespace.
		{"256m", 256 * 1024 * 1024, true},
		{"1g", 1024 * 1024 * 1024, true},
		{"512M", 512 * 1024 * 1024, true},
		{"512K", 512 * 1024, true},
		{"2G", 2 * 1024 * 1024 * 1024, true},
		{"1024", 1024, true},
		{"100k", 100 * 1024, true},
		{" 256m ", 256 * 1024 * 1024, true},
		{"  1g", 1024 * 1024 * 1024, true},
		// Invalid: empty, negatives, zero, decimals, trailing junk,
		// non-numeric, int64 parse overflow, n*mult overflow.
		{"", 0, false},
		{"   ", 0, false},
		{"-5g", 0, false},
		{"0", 0, false},
		{"0g", 0, false},
		{"1.5g", 0, false},
		{"12.5m", 0, false},
		{"256mb", 0, false},
		{"abc", 0, false},
		{"g", 0, false},
		// ParseInt overflow: value > math.MaxInt64.
		{"9999999999999999999g", 0, false},
		// Multiplication overflow: 9e9 GiB > math.MaxInt64 bytes.
		{"9000000000g", 0, false},
	}
	for _, tc := range tests {
		got, ok := ParseMemSpec(tc.in)
		if ok != tc.wantOk {
			t.Errorf("ParseMemSpec(%q) ok = %v; want %v", tc.in, ok, tc.wantOk)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("ParseMemSpec(%q) = %d; want %d", tc.in, got, tc.want)
		}
	}
}

// TestApplyAgentConfigToSpec_NilCfg verifies nil config is a no-op.
func TestApplyAgentConfigToSpec_NilCfg(t *testing.T) {
	t.Parallel()
	spec := SandboxSpec{CPULimit: 0.5}
	before := spec
	ApplyAgentConfigToSpec(&spec, nil)
	if spec.CPULimit != before.CPULimit {
		t.Errorf("nil cfg should not modify spec; CPU before=%v after=%v", before.CPULimit, spec.CPULimit)
	}
}

// TestApplyAgentConfigToSpec_PopulatesAllFields verifies every resource
// knob on AgentConfig flows into SandboxSpec.
func TestApplyAgentConfigToSpec_PopulatesAllFields(t *testing.T) {
	t.Parallel()
	cpu := 1.5
	pids := 256
	blkio := uint16(750)
	cfg := &clawless.AgentConfig{
		SandboxCPU:         &cpu,
		SandboxMem:         "1g",
		SandboxPids:        &pids,
		SandboxDisk:        "5g",
		SandboxBlkioWeight: &blkio,
		EgressAllowlist:    []string{"*.npmjs.org", "github.com"},
	}
	spec := SandboxSpec{}
	ApplyAgentConfigToSpec(&spec, cfg)

	if spec.CPULimit != 1.5 {
		t.Errorf("CPU = %v; want 1.5", spec.CPULimit)
	}
	if spec.MemoryLimit != 1024*1024*1024 {
		t.Errorf("Mem = %d; want 1GiB", spec.MemoryLimit)
	}
	if spec.PidsLimit != 256 {
		t.Errorf("Pids = %v; want 256", spec.PidsLimit)
	}
	if spec.DiskLimit != "5g" {
		t.Errorf("Disk = %q; want 5g", spec.DiskLimit)
	}
	if spec.BlkioWeight != 750 {
		t.Errorf("Blkio = %v; want 750", spec.BlkioWeight)
	}
	if len(spec.EgressAllowlist) != 2 {
		t.Errorf("Egress len = %d; want 2", len(spec.EgressAllowlist))
	}
}

// TestApplyAgentConfigToSpec_InvalidMemIsIgnored verifies a malformed
// sandbox_mem doesn't zero out the existing MemoryLimit.
func TestApplyAgentConfigToSpec_InvalidMemIsIgnored(t *testing.T) {
	t.Parallel()
	cfg := &clawless.AgentConfig{SandboxMem: "not-a-size"}
	spec := SandboxSpec{MemoryLimit: 999}
	ApplyAgentConfigToSpec(&spec, cfg)
	if spec.MemoryLimit != 999 {
		t.Errorf("invalid mem should not change spec; got %d want 999", spec.MemoryLimit)
	}
}

// TestApplyAgentConfigToSpec_PartialFields verifies setting only one knob
// leaves the others at their zero defaults.
func TestApplyAgentConfigToSpec_PartialFields(t *testing.T) {
	t.Parallel()
	pids := 100
	cfg := &clawless.AgentConfig{SandboxPids: &pids}
	spec := SandboxSpec{}
	ApplyAgentConfigToSpec(&spec, cfg)
	if spec.PidsLimit != 100 {
		t.Errorf("Pids = %v; want 100", spec.PidsLimit)
	}
	if spec.CPULimit != 0 {
		t.Errorf("CPU should be zero when unset; got %v", spec.CPULimit)
	}
	if spec.DiskLimit != "" {
		t.Errorf("Disk should be empty when unset; got %q", spec.DiskLimit)
	}
}
