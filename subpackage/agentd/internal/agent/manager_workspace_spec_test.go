//go:build linux

package agent

import (
	"context"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// TestBuildWorkspaceSandboxSpec_PopulatesResourceLimits verifies the M0b
// workspace sandbox spec built by ExecuteTool carries the per-agent
// resource overrides (P1.1) and egress allowlist (P2.2) from the
// execution-local AgentConfig, while preserving the fixed workspace
// fields (Type/Persistent/WorkspaceID/Ctx).
//
// Spec-construction level test: the sandbox manager is not involved —
// buildWorkspaceSandboxSpec is the single construction site for the
// ExecuteTool workspace path.
func TestBuildWorkspaceSandboxSpec_PopulatesResourceLimits(t *testing.T) {
	t.Parallel()
	cpu := 2.0
	pids := 128
	blkio := uint16(500)
	cfg := &clawless.AgentConfig{
		SandboxCPU:         &cpu,
		SandboxMem:         "512m",
		SandboxPids:        &pids,
		SandboxDisk:        "2g",
		SandboxBlkioWeight: &blkio,
		EgressAllowlist:    []string{"github.com", "*.npmjs.org"},
	}
	ctx := context.Background()

	spec := buildWorkspaceSandboxSpec("ws-123", ctx, cfg)

	// Fixed workspace fields preserved.
	if spec.Type != "lxc" {
		t.Errorf("Type = %q; want lxc", spec.Type)
	}
	if !spec.Persistent {
		t.Error("Persistent = false; want true")
	}
	if spec.WorkspaceID != "ws-123" {
		t.Errorf("WorkspaceID = %q; want ws-123", spec.WorkspaceID)
	}
	if spec.Ctx != ctx {
		t.Error("Ctx not propagated")
	}

	// Per-agent resource limits populated.
	if spec.CPULimit != 2.0 {
		t.Errorf("CPULimit = %v; want 2.0", spec.CPULimit)
	}
	if spec.MemoryLimit != 512*1024*1024 {
		t.Errorf("MemoryLimit = %d; want %d", spec.MemoryLimit, 512*1024*1024)
	}
	if spec.PidsLimit != 128 {
		t.Errorf("PidsLimit = %d; want 128", spec.PidsLimit)
	}
	if spec.DiskLimit != "2g" {
		t.Errorf("DiskLimit = %q; want 2g", spec.DiskLimit)
	}
	if spec.BlkioWeight != 500 {
		t.Errorf("BlkioWeight = %d; want 500", spec.BlkioWeight)
	}
	if len(spec.EgressAllowlist) != 2 ||
		spec.EgressAllowlist[0] != "github.com" ||
		spec.EgressAllowlist[1] != "*.npmjs.org" {
		t.Errorf("EgressAllowlist = %v; want [github.com *.npmjs.org]", spec.EgressAllowlist)
	}
}

// TestBuildWorkspaceSandboxSpec_NilConfig verifies a nil AgentConfig
// leaves provider defaults (zero resource knobs, unrestricted egress).
func TestBuildWorkspaceSandboxSpec_NilConfig(t *testing.T) {
	t.Parallel()
	spec := buildWorkspaceSandboxSpec("ws-abc", context.Background(), nil)

	if spec.Type != "lxc" || !spec.Persistent || spec.WorkspaceID != "ws-abc" {
		t.Errorf("fixed fields wrong: %+v", spec)
	}
	if spec.CPULimit != 0 || spec.MemoryLimit != 0 || spec.PidsLimit != 0 ||
		spec.DiskLimit != "" || spec.BlkioWeight != 0 || len(spec.EgressAllowlist) != 0 {
		t.Errorf("nil cfg should leave zero defaults; got %+v", spec)
	}
}
