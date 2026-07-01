//go:build linux
// +build linux

package sandbox

import (
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/clawless"
)

// TestSelectSandbox_UserExplicit covers priority 1: the caller's explicit
// sandbox type wins over everything else.
func TestSelectSandbox_UserExplicit(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		sandboxTy string
		command   string
		agentSb   string
		want      string
	}{
		{"explicit docker", "docker", "rm -rf /", "", "docker"},
		{"explicit docker-strict beats high-risk", "docker-strict", "rm -rf /", "", "docker-strict"},
		{"explicit lxc beats persistence", "lxc", "git clone foo", "", "lxc"},
		{"auto falls through to agent default", "auto", "ls", "docker-strict", "docker-strict"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			task := &clawless.Task{Command: tc.command, SandboxType: tc.sandboxTy}
			agentCfg := &clawless.AgentConfig{DefaultSandbox: tc.agentSb}
			got := SelectSandbox(task, agentCfg)
			if got != tc.want {
				t.Fatalf("SelectSandbox(%q,%q) = %q; want %q", tc.command, tc.sandboxTy, got, tc.want)
			}
		})
	}
}

// TestSelectSandbox_HighRisk verifies the regex-based risk heuristics.
func TestSelectSandbox_HighRisk(t *testing.T) {
	t.Parallel()
	highRisk := []string{
		"rm -rf /",
		"sudo apt install evil",
		"chmod 777 /etc",
		"mkfs /dev/sda",
		"iptables -F",
	}
	for _, cmd := range highRisk {
		task := &clawless.Task{Command: cmd, SandboxType: "auto"}
		if got := SelectSandbox(task, nil); got != "docker-strict" {
			t.Errorf("high-risk command %q → %q; want docker-strict", cmd, got)
		}
	}
}

// TestSelectSandbox_Persistence verifies git/build commands route to LXC.
func TestSelectSandbox_Persistence(t *testing.T) {
	t.Parallel()
	persist := []string{
		"git clone https://example.com/repo",
		"npm install lodash",
		"go build ./...",
		// P2: all browser_* tools (tools_browser_v2.go) route to LXC so the
		// in-sandbox Playwright helper persists across calls in one session.
		"browser_navigate https://example.com",
		"browser_click",
		"browser_evaluate",
		"browser_act", // legacy name still matches the browser_ prefix
	}
	for _, cmd := range persist {
		task := &clawless.Task{Command: cmd, SandboxType: "auto"}
		if got := SelectSandbox(task, nil); got != "lxc" {
			t.Errorf("persistence command %q → %q; want lxc", cmd, got)
		}
	}
}

// TestSelectSandbox_AgentDefault verifies priority 4: when no pattern
// matches and the agent has a default, use it.
func TestSelectSandbox_AgentDefault(t *testing.T) {
	t.Parallel()
	task := &clawless.Task{Command: "ls -la", SandboxType: "auto"}
	agentCfg := &clawless.AgentConfig{DefaultSandbox: "lxc"}
	if got := SelectSandbox(task, agentCfg); got != "lxc" {
		t.Fatalf("agent default = %q; want lxc", got)
	}
}

// TestSelectSandbox_FallbackDefault verifies priority 5: bare commands
// with no agent config default to docker.
func TestSelectSandbox_FallbackDefault(t *testing.T) {
	t.Parallel()
	task := &clawless.Task{Command: "echo hi", SandboxType: "auto"}
	if got := SelectSandbox(task, nil); got != "docker" {
		t.Fatalf("default = %q; want docker", got)
	}
}

// TestSelectSandbox_NilAgentCfg verifies nil doesn't panic and falls
// through to docker.
func TestSelectSandbox_NilAgentCfg(t *testing.T) {
	t.Parallel()
	task := &clawless.Task{Command: "ls", SandboxType: "auto"}
	if got := SelectSandbox(task, nil); got != "docker" {
		t.Fatalf("nil agentCfg default = %q; want docker", got)
	}
}

// TestNormalizePermissionProfile (exists in production code) — sanity.
func TestNormalizePermissionProfile(t *testing.T) {
	t.Parallel()
	tests := []struct{ in, want string }{
		{"", PermissionProfileDefault},
		{"default", PermissionProfileDefault},
		{"strict", PermissionProfileStrict},
		{"network", PermissionProfileNetwork},
		{"package-install", PermissionProfilePackageInstall},
		{"browser", PermissionProfileBrowser},
		{"persistent", PermissionProfilePersistent},
		{"unknown", PermissionProfileDefault}, // unknown → default
	}
	for _, tc := range tests {
		if got := NormalizePermissionProfile(tc.in); got != tc.want {
			t.Errorf("NormalizePermissionProfile(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}
