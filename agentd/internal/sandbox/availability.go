//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// CheckDockerAvailable verifies that Docker is accessible via the given socket.
func CheckDockerAvailable(socket string) error {
	socketPath := socket
	if strings.HasPrefix(socketPath, "unix://") {
		socketPath = strings.TrimPrefix(socketPath, "unix://")
	}

	if _, err := os.Stat(socketPath); err != nil {
		return fmt.Errorf("docker socket not accessible at %s: %w", socketPath, err)
	}

	cmd := exec.Command("docker", "info")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker info failed: %w (output: %s)", err, string(output))
	}

	return nil
}

// PrePullDockerImage pulls a Docker image to warm up the cache.
func PrePullDockerImage(image string) error {
	cmd := exec.Command("docker", "pull", image)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("docker pull %s failed: %w (output: %s)", image, err, string(output))
	}
	return nil
}

// CheckLXCAvailable verifies that LXC tools are installed.
func CheckLXCAvailable() error {
	if _, err := exec.LookPath("lxc-create"); err != nil {
		return fmt.Errorf("lxc-create not found in PATH")
	}

	if _, err := exec.LookPath("lxc-start"); err != nil {
		return fmt.Errorf("lxc-start not found in PATH")
	}

	if _, err := exec.LookPath("lxc-attach"); err != nil {
		return fmt.Errorf("lxc-attach not found in PATH")
	}

	return nil
}
