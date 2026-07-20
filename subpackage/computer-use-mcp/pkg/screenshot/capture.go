package screenshot

import (
	"fmt"
	"image"
)

// Display represents a physical display/monitor.
type Display struct {
	Index  int
	Bounds image.Rectangle
}

// GetDisplays returns all available displays.
// Returns empty slice if no display server is available.
func GetDisplays() ([]Display, error) {
	return getDisplays()
}

// CaptureDisplay captures the specified display and returns an RGBA image.
func CaptureDisplay(displayIndex int) (*image.RGBA, error) {
	displays, err := GetDisplays()
	if err != nil {
		return nil, fmt.Errorf("failed to enumerate displays: %w", err)
	}

	if len(displays) == 0 {
		return nil, fmt.Errorf("no displays available")
	}

	if displayIndex < 0 || displayIndex >= len(displays) {
		return nil, fmt.Errorf("display index %d out of range (0-%d)", displayIndex, len(displays)-1)
	}

	return captureDisplay(displays[displayIndex])
}

// NumActiveDisplays returns the number of active displays.
// Returns 0 if no display server is available (headless).
func NumActiveDisplays() int {
	displays, err := GetDisplays()
	if err != nil {
		return 0
	}
	return len(displays)
}

// GetDisplayBounds returns the bounds of the specified display.
func GetDisplayBounds(displayIndex int) image.Rectangle {
	displays, err := GetDisplays()
	if err != nil || displayIndex < 0 || displayIndex >= len(displays) {
		return image.Rectangle{}
	}
	return displays[displayIndex].Bounds
}
