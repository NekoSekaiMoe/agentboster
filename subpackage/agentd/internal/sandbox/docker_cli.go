//go:build linux
// +build linux

package sandbox

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

func dockerCommand(socket string, args ...string) *exec.Cmd {
	cmd := exec.Command("docker", args...)
	setDockerHost(cmd, socket)
	return cmd
}

func dockerCommandContext(ctx context.Context, socket string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "docker", args...)
	setDockerHost(cmd, socket)
	return cmd
}

func setDockerHost(cmd *exec.Cmd, socket string) {
	if socket == "" {
		return
	}
	env := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if strings.HasPrefix(item, "DOCKER_HOST=") {
			continue
		}
		env = append(env, item)
	}
	cmd.Env = append(env, "DOCKER_HOST="+socket)
}
