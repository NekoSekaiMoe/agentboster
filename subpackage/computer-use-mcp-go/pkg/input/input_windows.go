// +build windows

package input

import (
	"fmt"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	user32             uintptr
	sendInput          func(nInputs uint32, pInputs uintptr, cbSize int32) uint32
	getCursorPos       func(lpPoint uintptr) bool
	getAsyncKeyState   func(vKey int32) int16
	getSystemMetrics   func(nIndex int32) int32
)

const (
	INPUT_MOUSE    = 0
	INPUT_KEYBOARD = 1

	MOUSEEVENTF_MOVE       = 0x0001
	MOUSEEVENTF_LEFTDOWN   = 0x0002
	MOUSEEVENTF_LEFTUP     = 0x0004
	MOUSEEVENTF_RIGHTDOWN  = 0x0008
	MOUSEEVENTF_RIGHTUP    = 0x0010
	MOUSEEVENTF_MIDDLEDOWN = 0x0020
	MOUSEEVENTF_MIDDLEUP   = 0x0040
	MOUSEEVENTF_ABSOLUTE   = 0x8000

	KEYEVENTF_KEYDOWN      = 0x0000
	KEYEVENTF_KEYUP        = 0x0002
	KEYEVENTF_UNICODE      = 0x0004
	KEYEVENTF_SCANCODE     = 0x0008

	VK_SHIFT   = 0x10
	VK_CONTROL = 0x11
	VK_MENU    = 0x12 // Alt
	VK_LWIN    = 0x5B // Windows key
	VK_RETURN  = 0x0D
	VK_TAB     = 0x09
	VK_SPACE   = 0x20
	VK_ESCAPE  = 0x1B
	VK_BACK    = 0x08
	VK_DELETE  = 0x2E
	VK_HOME    = 0x24
	VK_END     = 0x23
	VK_PRIOR   = 0x21 // Page Up
	VK_NEXT    = 0x22 // Page Down
	VK_UP      = 0x26
	VK_DOWN    = 0x28
	VK_LEFT    = 0x25
	VK_RIGHT   = 0x27
	VK_F1      = 0x70
	VK_F2      = 0x71
	VK_F3      = 0x72
	VK_F4      = 0x73
	VK_F5      = 0x74
	VK_F6      = 0x75
	VK_F7      = 0x76
	VK_F8      = 0x77
	VK_F9      = 0x78
	VK_F10     = 0x79
	VK_F11     = 0x7A
	VK_F12     = 0x7B

	SM_CXSCREEN = 0
	SM_CYSCREEN = 1
)

type POINT struct {
	X int32
	Y int32
}

type MOUSEINPUT struct {
	Dx          int32
	Dy          int32
	MouseData   uint32
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type KEYBDINPUT struct {
	WVk         uint16
	WScan       uint16
	DwFlags     uint32
	Time        uint32
	DwExtraInfo uintptr
}

type INPUT struct {
	Type uint32
	_    [4]byte // padding for alignment
	Mi   [24]byte // union of MOUSEINPUT and KEYBDINPUT
}

func init() {
	var err error
	user32, err = purego.Dlopen("user32.dll", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		panic(fmt.Sprintf("Failed to load user32.dll: %v", err))
	}

	purego.RegisterLibFunc(&sendInput, user32, "SendInput")
	purego.RegisterLibFunc(&getCursorPos, user32, "GetCursorPos")
	purego.RegisterLibFunc(&getAsyncKeyState, user32, "GetAsyncKeyState")
	purego.RegisterLibFunc(&getSystemMetrics, user32, "GetSystemMetrics")
}

func mouseMove(x, y int) error {
	screenWidth := getSystemMetrics(SM_CXSCREEN)
	screenHeight := getSystemMetrics(SM_CYSCREEN)

	// Convert to absolute coordinates (0-65535 range)
	absX := int32((x * 65536) / int(screenWidth))
	absY := int32((y * 65536) / int(screenHeight))

	var input INPUT
	input.Type = INPUT_MOUSE

	mi := (*MOUSEINPUT)(unsafe.Pointer(&input.Mi[0]))
	mi.Dx = absX
	mi.Dy = absY
	mi.DwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE

	sendInput(1, uintptr(unsafe.Pointer(&input)), int32(unsafe.Sizeof(input)))
	return nil
}

func mouseClick(button string) error {
	var downFlag, upFlag uint32

	switch button {
	case "right":
		downFlag = MOUSEEVENTF_RIGHTDOWN
		upFlag = MOUSEEVENTF_RIGHTUP
	case "middle":
		downFlag = MOUSEEVENTF_MIDDLEDOWN
		upFlag = MOUSEEVENTF_MIDDLEUP
	default:
		downFlag = MOUSEEVENTF_LEFTDOWN
		upFlag = MOUSEEVENTF_LEFTUP
	}

	// Press
	var inputDown INPUT
	inputDown.Type = INPUT_MOUSE
	mi := (*MOUSEINPUT)(unsafe.Pointer(&inputDown.Mi[0]))
	mi.DwFlags = downFlag
	sendInput(1, uintptr(unsafe.Pointer(&inputDown)), int32(unsafe.Sizeof(inputDown)))

	time.Sleep(10 * time.Millisecond)

	// Release
	var inputUp INPUT
	inputUp.Type = INPUT_MOUSE
	mi = (*MOUSEINPUT)(unsafe.Pointer(&inputUp.Mi[0]))
	mi.DwFlags = upFlag
	sendInput(1, uintptr(unsafe.Pointer(&inputUp)), int32(unsafe.Sizeof(inputUp)))

	return nil
}

func mouseDrag(fromX, fromY, toX, toY int) error {
	// Move to start
	if err := mouseMove(fromX, fromY); err != nil {
		return err
	}

	time.Sleep(10 * time.Millisecond)

	// Press button
	var inputDown INPUT
	inputDown.Type = INPUT_MOUSE
	mi := (*MOUSEINPUT)(unsafe.Pointer(&inputDown.Mi[0]))
	mi.DwFlags = MOUSEEVENTF_LEFTDOWN
	sendInput(1, uintptr(unsafe.Pointer(&inputDown)), int32(unsafe.Sizeof(inputDown)))

	time.Sleep(10 * time.Millisecond)

	// Move to end
	if err := mouseMove(toX, toY); err != nil {
		return err
	}

	time.Sleep(10 * time.Millisecond)

	// Release button
	var inputUp INPUT
	inputUp.Type = INPUT_MOUSE
	mi = (*MOUSEINPUT)(unsafe.Pointer(&inputUp.Mi[0]))
	mi.DwFlags = MOUSEEVENTF_LEFTUP
	sendInput(1, uintptr(unsafe.Pointer(&inputUp)), int32(unsafe.Sizeof(inputUp)))

	return nil
}

func typeText(text string) error {
	// Convert string to UTF-16 to handle surrogate pairs for supplementary characters
	runes := []rune(text)
	utf16Chars := utf16.Encode(runes)

	for _, utf16Char := range utf16Chars {
		// Press
		var inputDown INPUT
		inputDown.Type = INPUT_KEYBOARD
		ki := (*KEYBDINPUT)(unsafe.Pointer(&inputDown.Mi[0]))
		ki.WVk = 0
		ki.WScan = utf16Char
		ki.DwFlags = KEYEVENTF_UNICODE
		sendInput(1, uintptr(unsafe.Pointer(&inputDown)), int32(unsafe.Sizeof(inputDown)))

		time.Sleep(10 * time.Millisecond)

		// Release
		var inputUp INPUT
		inputUp.Type = INPUT_KEYBOARD
		ki = (*KEYBDINPUT)(unsafe.Pointer(&inputUp.Mi[0]))
		ki.WVk = 0
		ki.WScan = utf16Char
		ki.DwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
		sendInput(1, uintptr(unsafe.Pointer(&inputUp)), int32(unsafe.Sizeof(inputUp)))
	}
	return nil
}

func keyEvent(key string, direction string) error {
	keycode, err := parseKey(key)
	if err != nil {
		return err
	}

	vk := keycode.(uint16)
	isDown := direction == "press" || direction == "click"

	var input INPUT
	input.Type = INPUT_KEYBOARD
	ki := (*KEYBDINPUT)(unsafe.Pointer(&input.Mi[0]))
	ki.WVk = vk
	if !isDown {
		ki.DwFlags = KEYEVENTF_KEYUP
	}

	sendInput(1, uintptr(unsafe.Pointer(&input)), int32(unsafe.Sizeof(input)))

	if direction == "click" {
		time.Sleep(10 * time.Millisecond)
		var inputUp INPUT
		inputUp.Type = INPUT_KEYBOARD
		ki = (*KEYBDINPUT)(unsafe.Pointer(&inputUp.Mi[0]))
		ki.WVk = vk
		ki.DwFlags = KEYEVENTF_KEYUP
		sendInput(1, uintptr(unsafe.Pointer(&inputUp)), int32(unsafe.Sizeof(inputUp)))
	}

	return nil
}

func getForegroundWindowID() uint64 {
	// Will be implemented in safety module using GetForegroundWindow
	return 0
}

func parseKey(s string) (interface{}, error) {
	var vk uint16

	switch s {
	case "Return", "return", "Enter", "enter":
		vk = VK_RETURN
	case "Tab", "tab":
		vk = VK_TAB
	case "Space", "space":
		vk = VK_SPACE
	case "Escape", "escape", "Esc", "esc":
		vk = VK_ESCAPE
	case "Backspace", "backspace":
		vk = VK_BACK
	case "Delete", "delete", "Del", "del":
		vk = VK_DELETE
	case "Home", "home":
		vk = VK_HOME
	case "End", "end":
		vk = VK_END
	case "PageUp", "pageup":
		vk = VK_PRIOR
	case "PageDown", "pagedown":
		vk = VK_NEXT
	case "Up", "up":
		vk = VK_UP
	case "Down", "down":
		vk = VK_DOWN
	case "Left", "left":
		vk = VK_LEFT
	case "Right", "right":
		vk = VK_RIGHT
	case "Control", "control", "Ctrl", "ctrl":
		vk = VK_CONTROL
	case "Shift", "shift":
		vk = VK_SHIFT
	case "Alt", "alt":
		vk = VK_MENU
	case "Meta", "meta", "Win", "win", "Windows", "windows":
		vk = VK_LWIN
	case "F1":
		vk = VK_F1
	case "F2":
		vk = VK_F2
	case "F3":
		vk = VK_F3
	case "F4":
		vk = VK_F4
	case "F5":
		vk = VK_F5
	case "F6":
		vk = VK_F6
	case "F7":
		vk = VK_F7
	case "F8":
		vk = VK_F8
	case "F9":
		vk = VK_F9
	case "F10":
		vk = VK_F10
	case "F11":
		vk = VK_F11
	case "F12":
		vk = VK_F12
	default:
		// Single character - use VkKeyScan for better mapping
		if len(s) == 1 {
			vk = uint16(s[0])
			if vk >= 'a' && vk <= 'z' {
				vk = vk - 'a' + 'A' // Convert to uppercase VK code
			}
		} else {
			return nil, fmt.Errorf("unknown key: %s", s)
		}
	}

	return vk, nil
}
