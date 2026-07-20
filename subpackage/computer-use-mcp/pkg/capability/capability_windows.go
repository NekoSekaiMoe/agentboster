//go:build windows

package capability

import (
	"golang.org/x/sys/windows"
)

func checkAccessibilityPermission() bool {
	// Windows doesn't require explicit accessibility permission
	return true
}

func checkAdminStatus() bool {
	// Check if running as admin using Windows token elevation status
	token := windows.GetCurrentProcessToken()
	elevated := token.IsElevated()
	return elevated
}
