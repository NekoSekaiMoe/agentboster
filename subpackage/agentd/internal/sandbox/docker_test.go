//go:build linux
// +build linux

package sandbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NekoSekaiMoe/agentboster/subpackage/agentd/internal/security/os_enforce"
)

func TestDockerProviderCreateKeepsStrictTypeAndWorkspaceTmpfs(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "docker.args")
	fakeDocker := filepath.Join(dir, "docker")
	script := `#!/bin/sh
printf '%s\n' "$@" > "$AGENTD_TEST_DOCKER_ARGS"
echo fake-container-id
`
	if err := os.WriteFile(fakeDocker, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake docker: %v", err)
	}

	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("AGENTD_TEST_DOCKER_ARGS", argsFile)

	provider := NewDockerProvider("unix:///tmp/agentd-test-docker.sock", nil, 1, "512m")
	sb, err := provider.Create(SandboxSpec{
		Type:           "docker-strict",
		SecurityPolicy: &os_enforce.OSPolicy{Seccomp: os_enforce.DefaultHardened()},
	})
	if err != nil {
		t.Fatalf("create strict docker sandbox: %v", err)
	}

	if sb.Type != "docker-strict" {
		t.Fatalf("expected docker-strict sandbox type, got %q", sb.Type)
	}

	rawArgs, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read fake docker args: %v", err)
	}
	args := string(rawArgs)
	if !strings.Contains(args, "--tmpfs\n/workspace:size=512m\n") {
		t.Fatalf("expected writable /workspace tmpfs, got args:\n%s", args)
	}
	if !strings.Contains(args, "-w\n/workspace\n") {
		t.Fatalf("expected /workspace workdir, got args:\n%s", args)
	}
	if !strings.Contains(args, "--security-opt\nseccomp=") {
		t.Fatalf("expected hardened seccomp profile, got args:\n%s", args)
	}
}
