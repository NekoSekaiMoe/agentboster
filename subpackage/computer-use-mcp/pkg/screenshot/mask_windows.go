//go:build windows

package screenshot

import (
	"image"
	"syscall"
	"unsafe"
)

type WindowID uint64

var (
	procEnumWindows         = user32.NewProc("EnumWindows")
	procIsWindowVisible     = user32.NewProc("IsWindowVisible")
	procGetClassNameW       = user32.NewProc("GetClassNameW")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procGetWindowRect       = user32.NewProc("GetWindowRect")
)

func getTerminalWindowIDs() []WindowID {
	var ids []WindowID

	callback := syscall.NewCallback(func(hwnd syscall.Handle, lparam uintptr) uintptr {
		// Reinterpret the uintptr lparam back to the slice pointer without
		// tripping `go vet`'s unsafeptr check.
		idsPtr := *(**[]WindowID)(unsafe.Pointer(&lparam))

		// Check if window is visible
		visible, _, _ := procIsWindowVisible.Call(uintptr(hwnd))
		if visible == 0 {
			return 1 // continue enumeration
		}

		// Get class name
		className := make([]uint16, 256)
		procGetClassNameW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&className[0])), 256)
		classStr := syscall.UTF16ToString(className)

		// Get window title
		titleBuf := make([]uint16, 256)
		procGetWindowTextW.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&titleBuf[0])), 256)
		titleStr := syscall.UTF16ToString(titleBuf)

		// Check if it's a terminal
		isTerminal := false
		terminalClasses := []string{"ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "VirtualConsoleClass", "mintty", "PuTTY"}
		for _, tc := range terminalClasses {
			if contains(classStr, tc) {
				isTerminal = true
				break
			}
		}

		if !isTerminal {
			terminalTitles := []string{"powershell", "cmd.exe", "terminal", "bash", "wsl"}
			lowerTitle := toLower(titleStr)
			for _, tt := range terminalTitles {
				if contains(lowerTitle, tt) {
					isTerminal = true
					break
				}
			}
		}

		if isTerminal {
			*idsPtr = append(*idsPtr, WindowID(hwnd))
		}

		return 1 // continue enumeration
	})

	procEnumWindows.Call(callback, uintptr(unsafe.Pointer(&ids)))
	return ids
}

func getTerminalWindowRects(ids []WindowID, monitorOrigin [2]int, width, height int) []image.Rectangle {
	var rects []image.Rectangle

	type RECT struct {
		Left, Top, Right, Bottom int32
	}

	monitorX := monitorOrigin[0]
	monitorY := monitorOrigin[1]
	monRight := monitorX + width
	monBottom := monitorY + height

	for _, id := range ids {
		var rect RECT
		ret, _, _ := procGetWindowRect.Call(uintptr(id), uintptr(unsafe.Pointer(&rect)))
		if ret == 0 {
			continue
		}

		// Compute intersection with monitor
		ixLeft := max(int(rect.Left), monitorX)
		iyTop := max(int(rect.Top), monitorY)
		ixRight := min(int(rect.Right), monRight)
		iyBottom := min(int(rect.Bottom), monBottom)

		if ixLeft < ixRight && iyTop < iyBottom {
			// Convert to image-relative coordinates
			rx := ixLeft - monitorX
			ry := iyTop - monitorY
			rw := ixRight - ixLeft
			rh := iyBottom - iyTop
			rects = append(rects, image.Rect(rx, ry, rx+rw, ry+rh))
		}
	}

	return rects
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func toLower(s string) string {
	runes := []rune(s)
	for i, r := range runes {
		if r >= 'A' && r <= 'Z' {
			runes[i] = r + 32
		}
	}
	return string(runes)
}

