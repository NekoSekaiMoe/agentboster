//go:build linux
// +build linux

package system

import (
	"fmt"
	"os/exec"
	"strings"
)

// CheckDependencies verifies required system dependencies are available
func CheckDependencies(sandboxDefault string) error {
	var missing []string

	// Check Docker dependencies
	if strings.HasPrefix(sandboxDefault, "docker") {
		if !commandExists("docker") {
			missing = append(missing, "docker")
		}
		if !libraryExists("libseccomp.so.2") {
			missing = append(missing, "libseccomp2")
		}
	}

	// Check LXC dependencies
	if sandboxDefault == "lxc" {
		if !commandExists("lxc-create") {
			missing = append(missing, "lxc")
		}
		if !libraryExists("libcap.so.2") {
			missing = append(missing, "libcap2")
		}
		if !commandExists("debootstrap") && !commandExists("yum") && !commandExists("dnf") {
			missing = append(missing, "debootstrap (or yum/dnf)")
		}
	}

	if len(missing) > 0 {
		return fmt.Errorf("missing required dependencies: %s", strings.Join(missing, ", "))
	}

	return nil
}

func commandExists(cmd string) bool {
	_, err := exec.LookPath(cmd)
	return err == nil
}

func libraryExists(lib string) bool {
	// Try ldconfig to check if library is available
	out, err := exec.Command("ldconfig", "-p").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), lib)
}
