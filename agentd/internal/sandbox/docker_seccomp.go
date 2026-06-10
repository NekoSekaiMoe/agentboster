//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/clawless/agentd/internal/security/os_enforce"
)

const dockerSeccompDir = "/tmp/agentd-seccomp"

func writeDockerSeccompProfile(name string, profile *os_enforce.SeccompProfile) (string, error) {
	if profile == nil {
		return "", fmt.Errorf("nil seccomp profile")
	}
	seccompJSON, err := profile.ToDockerJSON()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dockerSeccompDir, 0o755); err != nil {
		return "", err
	}
	seccompPath := filepath.Join(dockerSeccompDir, name+".json")
	if err := os.WriteFile(seccompPath, seccompJSON, 0o644); err != nil {
		return "", err
	}
	return seccompPath, nil
}
