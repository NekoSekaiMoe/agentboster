//go:build linux
// +build linux

package sandbox

import (
	"testing"

	"github.com/clawless/agentd/internal/security/os_enforce"
)

func TestPrepareSpecStrictProfileUsesDockerStrict(t *testing.T) {
	m := &Manager{policy: &os_enforce.OSPolicy{NetworkNone: false}}

	spec := m.prepareSpec(SandboxSpec{PermissionProfile: PermissionProfileStrict})

	if spec.Type != "docker-strict" {
		t.Fatalf("expected docker-strict, got %q", spec.Type)
	}
	if spec.SecurityLevel != "strict" {
		t.Fatalf("expected strict security level, got %q", spec.SecurityLevel)
	}
}

func TestPrepareSpecNetworkProfileAllowsNetwork(t *testing.T) {
	m := &Manager{policy: &os_enforce.OSPolicy{NetworkNone: true}}

	spec := m.prepareSpec(SandboxSpec{PermissionProfile: PermissionProfileNetwork})

	if spec.Type != "docker" {
		t.Fatalf("expected docker, got %q", spec.Type)
	}
	if spec.SecurityPolicy == nil || spec.SecurityPolicy.NetworkNone {
		t.Fatalf("expected network-enabled security policy, got %#v", spec.SecurityPolicy)
	}
	if m.policy.NetworkNone != true {
		t.Fatal("prepareSpec mutated manager policy")
	}
}

func TestPrepareSpecPackageInstallUsesPersistentLXC(t *testing.T) {
	m := &Manager{policy: &os_enforce.OSPolicy{NetworkNone: true}}

	spec := m.prepareSpec(SandboxSpec{PermissionProfile: PermissionProfilePackageInstall})

	if spec.Type != "lxc" {
		t.Fatalf("expected lxc, got %q", spec.Type)
	}
	if !spec.Persistent {
		t.Fatal("expected persistent sandbox")
	}
	if spec.SecurityPolicy == nil || spec.SecurityPolicy.NetworkNone {
		t.Fatalf("expected network-enabled security policy, got %#v", spec.SecurityPolicy)
	}
}
