//go:build linux

package sandbox

import (
	"fmt"
	"strings"
)

// ContainerIP returns the IPv4 address of a running sandbox container.
// Uses exec inside the container to avoid provider-specific CLI tools.
func (m *Manager) ContainerIP(sandboxID string) (string, error) {
	result, err := m.Exec(sandboxID, "hostname -I", nil, 5)
	if err != nil {
		return "", fmt.Errorf("get container IP: %w", err)
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("get container IP: exit %d: %s", result.ExitCode, result.Stderr)
	}

	ips := strings.Fields(strings.TrimSpace(result.Stdout))
	if len(ips) == 0 {
		return "", fmt.Errorf("container %s has no IP address", sandboxID)
	}
	return ips[0], nil
}
