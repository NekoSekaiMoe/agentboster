package capability

import (
	"runtime"
	"testing"
)

func TestDetect(t *testing.T) {
	caps := Detect()

	// Basic sanity checks
	if caps.DisplayServer != nil && *caps.DisplayServer == "" {
		t.Error("DisplayServer should not be empty string")
	}

	if caps.DisplayResolution != nil {
		if caps.DisplayResolution[0] == 0 || caps.DisplayResolution[1] == 0 {
			t.Error("Resolution should not be zero")
		}
	}

	if caps.ScaleFactor <= 0 {
		t.Error("ScaleFactor should be positive")
	}

	// Platform-specific checks
	if caps.DisplayServer != nil {
		switch runtime.GOOS {
		case "darwin":
			if *caps.DisplayServer != "quartz" {
				t.Errorf("Expected quartz on macOS, got %s", *caps.DisplayServer)
			}
		case "linux":
			if *caps.DisplayServer != "x11" && *caps.DisplayServer != "wayland" {
				t.Errorf("Expected x11 or wayland on Linux, got %s", *caps.DisplayServer)
			}
		case "windows":
			if *caps.DisplayServer != "win32" {
				t.Errorf("Expected win32 on Windows, got %s", *caps.DisplayServer)
			}
		}
	}
}

func TestDetectResolution(t *testing.T) {
	res := detectResolution()

	if res != nil {
		if res[0] == 0 || res[1] == 0 {
			t.Error("Resolution should not be zero")
		}
		t.Logf("Detected resolution: %dx%d", res[0], res[1])
	} else {
		t.Log("No resolution detected (headless environment)")
	}
}

func TestCheckAccessibilityPermission(t *testing.T) {
	hasPermission := checkAccessibilityPermission()

	// Just log the result, don't fail
	// (permission might not be granted in test environment)
	t.Logf("Accessibility permission: %v", hasPermission)
}

func TestCheckAdminStatus(t *testing.T) {
	isAdmin := checkAdminStatus()

	// Just log the result
	t.Logf("Admin status: %v", isAdmin)
}

func TestHasDisplay(t *testing.T) {
	caps := Detect()

	// In most test environments, HasDisplay should be true
	if !caps.HasDisplay && runtime.GOOS != "linux" {
		t.Log("Warning: HasDisplay is false (headless environment?)")
	}
}
