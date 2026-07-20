//go:build darwin

package input

import (
	"fmt"
	"time"
	"unicode/utf16"

	"github.com/ebitengine/purego"
)

var (
	cgEventCreateMouseEvent      func(source uintptr, mouseType uint32, mouseCursorPosition CGPoint, mouseButton uint32) uintptr
	cgEventCreateKeyboardEvent   func(source uintptr, virtualKey uint16, keyDown bool) uintptr
	cgEventPost                  func(tap uint32, event uintptr)
	cgEventGetLocation           func(event uintptr) CGPoint
	cgEventCreate                func(source uintptr) uintptr
	cgEventKeyboardSetUnicodeString func(event uintptr, stringLength uint64, unicodeString *uint16)
	cfRelease                    func(cf uintptr)
)

type CGPoint struct {
	X float64
	Y float64
}

const (
	kCGEventMouseMoved      = 5
	kCGEventLeftMouseDown   = 1
	kCGEventLeftMouseUp     = 2
	kCGEventRightMouseDown  = 3
	kCGEventRightMouseUp    = 4
	kCGEventOtherMouseDown  = 25
	kCGEventOtherMouseUp    = 26
	kCGEventLeftMouseDragged = 6
	kCGHIDEventTap          = 0

	kCGMouseButtonLeft   = 0
	kCGMouseButtonRight  = 1
	kCGMouseButtonCenter = 2
)

// Virtual key codes for macOS
const (
	kVK_Return        = 0x24
	kVK_Tab           = 0x30
	kVK_Space         = 0x31
	kVK_Delete        = 0x33 // Backspace
	kVK_Escape        = 0x35
	kVK_Command       = 0x37
	kVK_Shift         = 0x38
	kVK_CapsLock      = 0x39
	kVK_Option        = 0x3A
	kVK_Control       = 0x3B
	kVK_RightShift    = 0x3C
	kVK_RightOption   = 0x3D
	kVK_RightControl  = 0x3E
	kVK_Function      = 0x3F
	kVK_F17           = 0x40
	kVK_VolumeUp      = 0x48
	kVK_VolumeDown    = 0x49
	kVK_Mute          = 0x4A
	kVK_F18           = 0x4F
	kVK_F19           = 0x50
	kVK_F20           = 0x5A
	kVK_F5            = 0x60
	kVK_F6            = 0x61
	kVK_F7            = 0x62
	kVK_F3            = 0x63
	kVK_F8            = 0x64
	kVK_F9            = 0x65
	kVK_F11           = 0x67
	kVK_F13           = 0x69
	kVK_F16           = 0x6A
	kVK_F14           = 0x6B
	kVK_F10           = 0x6D
	kVK_F12           = 0x6F
	kVK_F15           = 0x71
	kVK_Help          = 0x72
	kVK_Home          = 0x73
	kVK_PageUp        = 0x74
	kVK_ForwardDelete = 0x75
	kVK_F4            = 0x76
	kVK_End           = 0x77
	kVK_F2            = 0x78
	kVK_PageDown      = 0x79
	kVK_F1            = 0x7A
	kVK_LeftArrow     = 0x7B
	kVK_RightArrow    = 0x7C
	kVK_DownArrow     = 0x7D
	kVK_UpArrow       = 0x7E
	kVK_ANSI_A        = 0x00
	kVK_ANSI_B        = 0x0B
	kVK_ANSI_C        = 0x08
	kVK_ANSI_D        = 0x02
	kVK_ANSI_E        = 0x0E
	kVK_ANSI_F        = 0x03
	kVK_ANSI_G        = 0x05
	kVK_ANSI_H        = 0x04
	kVK_ANSI_I        = 0x22
	kVK_ANSI_J        = 0x26
	kVK_ANSI_K        = 0x28
	kVK_ANSI_L        = 0x25
	kVK_ANSI_M        = 0x2E
	kVK_ANSI_N        = 0x2D
	kVK_ANSI_O        = 0x1F
	kVK_ANSI_P        = 0x23
	kVK_ANSI_Q        = 0x0C
	kVK_ANSI_R        = 0x0F
	kVK_ANSI_S        = 0x01
	kVK_ANSI_T        = 0x11
	kVK_ANSI_U        = 0x20
	kVK_ANSI_V        = 0x09
	kVK_ANSI_W        = 0x0D
	kVK_ANSI_X        = 0x07
	kVK_ANSI_Y        = 0x10
	kVK_ANSI_Z        = 0x06
)

func init() {
	coreGraphics, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		panic(fmt.Sprintf("Failed to load CoreGraphics: %v", err))
	}

	coreFoundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		panic(fmt.Sprintf("Failed to load CoreFoundation: %v", err))
	}

	purego.RegisterLibFunc(&cgEventCreateMouseEvent, coreGraphics, "CGEventCreateMouseEvent")
	purego.RegisterLibFunc(&cgEventCreateKeyboardEvent, coreGraphics, "CGEventCreateKeyboardEvent")
	purego.RegisterLibFunc(&cgEventPost, coreGraphics, "CGEventPost")
	purego.RegisterLibFunc(&cgEventGetLocation, coreGraphics, "CGEventGetLocation")
	purego.RegisterLibFunc(&cgEventCreate, coreGraphics, "CGEventCreate")
	purego.RegisterLibFunc(&cgEventKeyboardSetUnicodeString, coreGraphics, "CGEventKeyboardSetUnicodeString")
	purego.RegisterLibFunc(&cfRelease, coreFoundation, "CFRelease")
}

func mouseMove(x, y int) error {
	point := CGPoint{X: float64(x), Y: float64(y)}
	event := cgEventCreateMouseEvent(0, kCGEventMouseMoved, point, kCGMouseButtonLeft)
	if event == 0 {
		return fmt.Errorf("failed to create mouse event")
	}
	defer cfRelease(event)

	cgEventPost(kCGHIDEventTap, event)
	return nil
}

func mouseClick(button string) error {
	var btn uint32 = kCGMouseButtonLeft
	var downType, upType uint32

	switch button {
	case "right":
		btn = kCGMouseButtonRight
		downType = kCGEventRightMouseDown
		upType = kCGEventRightMouseUp
	case "middle":
		btn = kCGMouseButtonCenter
		downType = kCGEventOtherMouseDown
		upType = kCGEventOtherMouseUp
	default:
		downType = kCGEventLeftMouseDown
		upType = kCGEventLeftMouseUp
	}

	// Get current cursor position
	currentEvent := cgEventCreate(0)
	point := cgEventGetLocation(currentEvent)
	cfRelease(currentEvent)

	// Press
	downEvent := cgEventCreateMouseEvent(0, downType, point, btn)
	if downEvent == 0 {
		return fmt.Errorf("failed to create mouse down event")
	}
	cgEventPost(kCGHIDEventTap, downEvent)
	cfRelease(downEvent)

	time.Sleep(10 * time.Millisecond)

	// Release
	upEvent := cgEventCreateMouseEvent(0, upType, point, btn)
	if upEvent == 0 {
		return fmt.Errorf("failed to create mouse up event")
	}
	cgEventPost(kCGHIDEventTap, upEvent)
	cfRelease(upEvent)

	return nil
}

func mouseDrag(fromX, fromY, toX, toY int) error {
	// Move to start
	startPoint := CGPoint{X: float64(fromX), Y: float64(fromY)}
	moveEvent := cgEventCreateMouseEvent(0, kCGEventMouseMoved, startPoint, kCGMouseButtonLeft)
	if moveEvent == 0 {
		return fmt.Errorf("failed to create move event")
	}
	cgEventPost(kCGHIDEventTap, moveEvent)
	cfRelease(moveEvent)

	// Press button
	downEvent := cgEventCreateMouseEvent(0, kCGEventLeftMouseDown, startPoint, kCGMouseButtonLeft)
	if downEvent == 0 {
		return fmt.Errorf("failed to create mouse down event")
	}
	cgEventPost(kCGHIDEventTap, downEvent)
	cfRelease(downEvent)

	time.Sleep(10 * time.Millisecond)

	// Drag to end
	endPoint := CGPoint{X: float64(toX), Y: float64(toY)}
	dragEvent := cgEventCreateMouseEvent(0, kCGEventLeftMouseDragged, endPoint, kCGMouseButtonLeft)
	if dragEvent == 0 {
		return fmt.Errorf("failed to create drag event")
	}
	cgEventPost(kCGHIDEventTap, dragEvent)
	cfRelease(dragEvent)

	time.Sleep(10 * time.Millisecond)

	// Release button
	upEvent := cgEventCreateMouseEvent(0, kCGEventLeftMouseUp, endPoint, kCGMouseButtonLeft)
	if upEvent == 0 {
		return fmt.Errorf("failed to create mouse up event")
	}
	cgEventPost(kCGHIDEventTap, upEvent)
	cfRelease(upEvent)

	return nil
}

func typeText(text string) error {
	for _, ch := range text {
		// Convert rune to UTF-16, handling surrogate pairs for supplementary characters
		utf16Chars := utf16.Encode([]rune{ch})

		event := cgEventCreateKeyboardEvent(0, 0, true)
		if event == 0 {
			return fmt.Errorf("failed to create keyboard event")
		}

		cgEventKeyboardSetUnicodeString(event, uint64(len(utf16Chars)), &utf16Chars[0])
		cgEventPost(kCGHIDEventTap, event)
		cfRelease(event)

		time.Sleep(10 * time.Millisecond)

		upEvent := cgEventCreateKeyboardEvent(0, 0, false)
		if upEvent != 0 {
			cgEventKeyboardSetUnicodeString(upEvent, uint64(len(utf16Chars)), &utf16Chars[0])
			cgEventPost(kCGHIDEventTap, upEvent)
			cfRelease(upEvent)
		}
	}
	return nil
}

func keyEvent(key string, direction string) error {
	keycode, err := parseKey(key)
	if err != nil {
		return err
	}

	kc := keycode.(uint16)
	down := direction == "press" || direction == "click"

	event := cgEventCreateKeyboardEvent(0, kc, down)
	if event == 0 {
		return fmt.Errorf("failed to create keyboard event")
	}
	defer cfRelease(event)

	cgEventPost(kCGHIDEventTap, event)

	if direction == "click" {
		time.Sleep(10 * time.Millisecond)
		upEvent := cgEventCreateKeyboardEvent(0, kc, false)
		if upEvent != 0 {
			cgEventPost(kCGHIDEventTap, upEvent)
			cfRelease(upEvent)
		}
	}

	return nil
}

func getForegroundWindowID() uint64 {
	// Will be implemented in safety module using CGWindowListCopyWindowInfo
	return 0
}

func parseKey(s string) (interface{}, error) {
	var keycode uint16

	switch s {
	case "Return", "return", "Enter", "enter":
		keycode = kVK_Return
	case "Tab", "tab":
		keycode = kVK_Tab
	case "Space", "space":
		keycode = kVK_Space
	case "Escape", "escape", "Esc", "esc":
		keycode = kVK_Escape
	case "Backspace", "backspace":
		keycode = kVK_Delete
	case "Delete", "delete", "Del", "del":
		keycode = kVK_ForwardDelete
	case "Home", "home":
		keycode = kVK_Home
	case "End", "end":
		keycode = kVK_End
	case "PageUp", "pageup":
		keycode = kVK_PageUp
	case "PageDown", "pagedown":
		keycode = kVK_PageDown
	case "Up", "up":
		keycode = kVK_UpArrow
	case "Down", "down":
		keycode = kVK_DownArrow
	case "Left", "left":
		keycode = kVK_LeftArrow
	case "Right", "right":
		keycode = kVK_RightArrow
	case "Control", "control", "Ctrl", "ctrl":
		keycode = kVK_Control
	case "Shift", "shift":
		keycode = kVK_Shift
	case "Alt", "alt", "Option", "option":
		keycode = kVK_Option
	case "Meta", "meta", "Cmd", "cmd", "Command", "command":
		keycode = kVK_Command
	case "F1":
		keycode = kVK_F1
	case "F2":
		keycode = kVK_F2
	case "F3":
		keycode = kVK_F3
	case "F4":
		keycode = kVK_F4
	case "F5":
		keycode = kVK_F5
	case "F6":
		keycode = kVK_F6
	case "F7":
		keycode = kVK_F7
	case "F8":
		keycode = kVK_F8
	case "F9":
		keycode = kVK_F9
	case "F10":
		keycode = kVK_F10
	case "F11":
		keycode = kVK_F11
	case "F12":
		keycode = kVK_F12
	// Single character keys
	case "a", "A":
		keycode = kVK_ANSI_A
	case "b", "B":
		keycode = kVK_ANSI_B
	case "c", "C":
		keycode = kVK_ANSI_C
	case "d", "D":
		keycode = kVK_ANSI_D
	case "e", "E":
		keycode = kVK_ANSI_E
	case "f", "F":
		keycode = kVK_ANSI_F
	case "g", "G":
		keycode = kVK_ANSI_G
	case "h", "H":
		keycode = kVK_ANSI_H
	case "i", "I":
		keycode = kVK_ANSI_I
	case "j", "J":
		keycode = kVK_ANSI_J
	case "k", "K":
		keycode = kVK_ANSI_K
	case "l", "L":
		keycode = kVK_ANSI_L
	case "m", "M":
		keycode = kVK_ANSI_M
	case "n", "N":
		keycode = kVK_ANSI_N
	case "o", "O":
		keycode = kVK_ANSI_O
	case "p", "P":
		keycode = kVK_ANSI_P
	case "q", "Q":
		keycode = kVK_ANSI_Q
	case "r", "R":
		keycode = kVK_ANSI_R
	case "s", "S":
		keycode = kVK_ANSI_S
	case "t", "T":
		keycode = kVK_ANSI_T
	case "u", "U":
		keycode = kVK_ANSI_U
	case "v", "V":
		keycode = kVK_ANSI_V
	case "w", "W":
		keycode = kVK_ANSI_W
	case "x", "X":
		keycode = kVK_ANSI_X
	case "y", "Y":
		keycode = kVK_ANSI_Y
	case "z", "Z":
		keycode = kVK_ANSI_Z
	default:
		return nil, fmt.Errorf("unknown key: %s", s)
	}

	return keycode, nil
}
