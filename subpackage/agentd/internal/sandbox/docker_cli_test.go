//go:build linux
// +build linux

package sandbox

import (
	"strings"
	"testing"
)

func TestDockerCommandSetsDockerHost(t *testing.T) {
	cmd := dockerCommand("unix:///run/user/1001/docker.sock", "info")

	found := false
	for _, env := range cmd.Env {
		if env == "DOCKER_HOST=unix:///run/user/1001/docker.sock" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected DOCKER_HOST in env, got %s", strings.Join(cmd.Env, "\n"))
	}
}

func TestDockerCommandLeavesEnvUnsetWithoutSocket(t *testing.T) {
	cmd := dockerCommand("", "info")
	for _, env := range cmd.Env {
		if strings.HasPrefix(env, "DOCKER_HOST=") {
			t.Fatalf("did not expect DOCKER_HOST in env, got %s", env)
		}
	}
}
