// +build linux

package capability

import "os"

func checkAccessibilityPermission() bool {
	// Linux AT-SPI2 doesn't require explicit permission grants
	return true
}

func checkAdminStatus() bool {
	return os.Geteuid() == 0
}
