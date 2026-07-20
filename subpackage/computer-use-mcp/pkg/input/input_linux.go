// +build linux

package input

import (
	"fmt"
	"os/exec"

	"github.com/ebitengine/purego"
)

var (
	xOpenDisplay          func(displayName *byte) uintptr
	xCloseDisplay         func(display uintptr) int
	xTestFakeMotionEvent  func(display uintptr, screen int, x, y int, delay uint32) int
	xTestFakeButtonEvent  func(display uintptr, button uint, isPress int, delay uint32) int
	xTestFakeKeyEvent     func(display uintptr, keycode uint, isPress int, delay uint32) int
	xFlush                func(display uintptr) int
	xKeysymToKeycode      func(display uintptr, keysym uint64) byte
)

// X11 keysyms
const (
	XK_Return      = 0xff0d
	XK_Tab         = 0xff09
	XK_space       = 0x0020
	XK_Escape      = 0xff1b
	XK_BackSpace   = 0xff08
	XK_Delete      = 0xffff
	XK_Home        = 0xff50
	XK_End         = 0xff57
	XK_Page_Up     = 0xff55
	XK_Page_Down   = 0xff56
	XK_Up          = 0xff52
	XK_Down        = 0xff54
	XK_Left        = 0xff51
	XK_Right       = 0xff53
	XK_Shift_L     = 0xffe1
	XK_Control_L   = 0xffe3
	XK_Alt_L       = 0xffe9
	XK_Super_L     = 0xffeb
)

func init() {
	x11, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		// Try alternative path
		x11, err = purego.Dlopen("libX11.so", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			panic(fmt.Sprintf("Failed to load libX11: %v", err))
		}
	}

	xtest, err := purego.Dlopen("libXtst.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		xtest, err = purego.Dlopen("libXtst.so", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			panic(fmt.Sprintf("Failed to load libXtst: %v", err))
		}
	}

	purego.RegisterLibFunc(&xOpenDisplay, x11, "XOpenDisplay")
	purego.RegisterLibFunc(&xCloseDisplay, x11, "XCloseDisplay")
	purego.RegisterLibFunc(&xFlush, x11, "XFlush")
	purego.RegisterLibFunc(&xKeysymToKeycode, x11, "XKeysymToKeycode")
	purego.RegisterLibFunc(&xTestFakeMotionEvent, xtest, "XTestFakeMotionEvent")
	purego.RegisterLibFunc(&xTestFakeButtonEvent, xtest, "XTestFakeButtonEvent")
	purego.RegisterLibFunc(&xTestFakeKeyEvent, xtest, "XTestFakeKeyEvent")
}

func mouseMove(x, y int) error {
	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	xTestFakeMotionEvent(display, -1, x, y, 0)
	xFlush(display)
	return nil
}

func mouseClick(button string) error {
	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	btn := uint(1) // left
	switch button {
	case "right":
		btn = 3
	case "middle":
		btn = 2
	case "back":
		btn = 8
	case "forward":
		btn = 9
	}

	xTestFakeButtonEvent(display, btn, 1, 0) // press
	xTestFakeButtonEvent(display, btn, 0, 0) // release
	xFlush(display)
	return nil
}

func mouseDrag(fromX, fromY, toX, toY int) error {
	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	// Move to start position
	xTestFakeMotionEvent(display, -1, fromX, fromY, 0)
	xFlush(display)

	// Press left button
	xTestFakeButtonEvent(display, 1, 1, 0)
	xFlush(display)

	// Move to end position
	xTestFakeMotionEvent(display, -1, toX, toY, 0)
	xFlush(display)

	// Release left button
	xTestFakeButtonEvent(display, 1, 0, 0)
	xFlush(display)

	return nil
}

func typeText(text string) error {
	// Use xdotool if available for better keyboard layout support
	if _, err := exec.LookPath("xdotool"); err == nil {
		cmd := exec.Command("xdotool", "type", "--clearmodifiers", "--delay", "10", "--", text)
		return cmd.Run()
	}

	// Fallback: character-by-character via XTest
	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	for _, ch := range text {
		// Simple ASCII mapping - more complete implementation would need XStringToKeysym
		keysym := uint64(ch)
		keycode := xKeysymToKeycode(display, keysym)
		if keycode == 0 {
			continue // Skip unmappable characters
		}

		xTestFakeKeyEvent(display, uint(keycode), 1, 0) // press
		xTestFakeKeyEvent(display, uint(keycode), 0, 0) // release
		xFlush(display)
	}

	return nil
}

func keyEvent(key string, direction string) error {
	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	keycode, err := parseKey(key)
	if err != nil {
		return err
	}

	kc := keycode.(byte)
	isPress := 0
	if direction == "press" || direction == "click" {
		isPress = 1
	}

	xTestFakeKeyEvent(display, uint(kc), isPress, 0)
	if direction == "click" {
		xTestFakeKeyEvent(display, uint(kc), 0, 0)
	}
	xFlush(display)
	return nil
}

func getForegroundWindowID() uint64 {
	// Linux doesn't have a reliable cross-desktop API for this
	return 0
}

func parseKey(s string) (interface{}, error) {
	display := xOpenDisplay(nil)
	if display == 0 {
		return nil, fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	var keysym uint64

	switch s {
	case "Return", "return", "Enter", "enter":
		keysym = XK_Return
	case "Tab", "tab":
		keysym = XK_Tab
	case "Space", "space":
		keysym = XK_space
	case "Escape", "escape", "Esc", "esc":
		keysym = XK_Escape
	case "Backspace", "backspace":
		keysym = XK_BackSpace
	case "Delete", "delete", "Del", "del":
		keysym = XK_Delete
	case "Home", "home":
		keysym = XK_Home
	case "End", "end":
		keysym = XK_End
	case "PageUp", "pageup":
		keysym = XK_Page_Up
	case "PageDown", "pagedown":
		keysym = XK_Page_Down
	case "Up", "up":
		keysym = XK_Up
	case "Down", "down":
		keysym = XK_Down
	case "Left", "left":
		keysym = XK_Left
	case "Right", "right":
		keysym = XK_Right
	case "Control", "control", "Ctrl", "ctrl":
		keysym = XK_Control_L
	case "Shift", "shift":
		keysym = XK_Shift_L
	case "Alt", "alt":
		keysym = XK_Alt_L
	case "Meta", "meta", "Super", "super":
		keysym = XK_Super_L
	default:
		// Single character
		if len(s) == 1 {
			keysym = uint64(s[0])
		} else {
			return nil, fmt.Errorf("unknown key: %s", s)
		}
	}

	keycode := xKeysymToKeycode(display, keysym)
	if keycode == 0 {
		return nil, fmt.Errorf("no keycode for key: %s", s)
	}

	return keycode, nil
}
