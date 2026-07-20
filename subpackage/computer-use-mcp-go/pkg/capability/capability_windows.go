// +build windows

package capability

func checkAccessibilityPermission() bool {
	// Windows doesn't require explicit accessibility permission
	return true
}

func checkAdminStatus() bool {
	// TODO: Check if running as admin on Windows
	return false
}
