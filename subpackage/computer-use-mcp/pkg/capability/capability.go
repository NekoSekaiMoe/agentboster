package capability

import (
	"os"
	"runtime"

	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/screenshot"
)

// Capabilities describes what the computer-use server can do on this platform.
type Capabilities struct {
	HasDisplay           bool     `json:"has_display"`
	Platform             string   `json:"platform"`
	DisplayServer        *string  `json:"display_server,omitempty"`
	DisplayResolution    *[2]int  `json:"display_resolution,omitempty"`
	ScaleFactor          float64  `json:"scale_factor"`
	AccessibilityGranted bool     `json:"accessibility_granted"`
	IsAdmin              bool     `json:"is_admin"`
	Issues               []string `json:"issues"`
}

// Detect returns the current platform's capabilities.
func Detect() Capabilities {
	platform := runtime.GOOS
	hasDisplay, displayServer := detectDisplayServer()

	var displayResolution *[2]int
	if hasDisplay {
		if res := detectResolution(); res != nil {
			displayResolution = res
		}
	}

	scaleFactor := 1.0
	if displayResolution != nil {
		w := displayResolution[0]
		if w > 2000 {
			scaleFactor = float64(w) / 1400.0
		}
	}

	accessibilityGranted := checkAccessibilityPermission()
	isAdmin := checkAdminStatus()

	var issues []string
	if !hasDisplay {
		issues = append(issues, "No display server detected. Computer use tools unavailable.")
	}
	if hasDisplay && !accessibilityGranted && platform == "darwin" {
		issues = append(issues, "Accessibility permission required. Grant in: System Preferences → Privacy & Security → Accessibility → Enable AgentBoster")
	}

	return Capabilities{
		HasDisplay:           hasDisplay,
		Platform:             platform,
		DisplayServer:        displayServer,
		DisplayResolution:    displayResolution,
		ScaleFactor:          scaleFactor,
		AccessibilityGranted: accessibilityGranted,
		IsAdmin:              isAdmin,
		Issues:               issues,
	}
}

func detectDisplayServer() (bool, *string) {
	switch runtime.GOOS {
	case "darwin":
		s := "quartz"
		return true, &s
	case "windows":
		s := "win32"
		return true, &s
	case "linux":
		if os.Getenv("WAYLAND_DISPLAY") != "" {
			s := "wayland"
			return true, &s
		}
		if os.Getenv("DISPLAY") != "" {
			s := "x11"
			return true, &s
		}
		return false, nil
	default:
		return false, nil
	}
}

func detectResolution() *[2]int {
	displays, err := screenshot.GetDisplays()
	if err != nil || len(displays) == 0 {
		return nil
	}

	bounds := displays[0].Bounds
	w := bounds.Dx()
	h := bounds.Dy()

	return &[2]int{w, h}
}
