//go:build linux

package screenshot

import (
	"image"
)

type WindowID uint64

func getTerminalWindowIDs() []WindowID {
	// Linux has no reliable cross-desktop API to identify terminal windows.
	// Return empty; we'll use conservative fallback in getTerminalWindowRects.
	return nil
}

func getTerminalWindowRects(ids []WindowID, monitorOrigin [2]int, width, height int) []image.Rectangle {
	// Conservative fallback: mask bottom 1/3 of screen where terminals typically sit.
	maskY := (height * 2) / 3
	return []image.Rectangle{
		image.Rect(0, maskY, width, height),
	}
}
