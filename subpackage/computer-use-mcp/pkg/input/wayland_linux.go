//go:build linux

package input

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
)

// Wayland input via ydotool.
//
// Under a native Wayland session the XTest calls in input_linux.go cannot drive
// non-Xwayland windows: the compositor never sees the synthetic X events. The
// portable escape hatch is ydotool, which talks to a background daemon
// (ydotoold) that owns a kernel uinput virtual device — input the compositor
// treats as real hardware, so it reaches every window regardless of toolkit.
//
// ydotool is best-effort: it needs ydotoold running with access to /dev/uinput
// (usually root). When it isn't installed or the command fails, callers fall
// back to the XTest path (which at least drives Xwayland-backed windows). The
// gate is "Wayland session AND ydotool on PATH"; a pure X11 session skips this
// file's logic entirely.

// waylandInputActive reports whether synthetic input should be routed through
// ydotool: a Wayland session is active and the ydotool client is installed.
//
// The ydotool-on-PATH check is memoized once per process with sync.Once:
// mouseMove/Click/Drag/typeText/keyEvent all funnel through this gate on every
// call, and exec.LookPath is a syscall (scanning $PATH) we don't want to repeat
// on the input hot path. PATH can't meaningfully change during a process's
// lifetime in our deployment model, so a one-shot probe is correct; the env
// check stays live so toggling WAYLAND_DISPLAY still takes effect.
var (
	waylandInputOnce  sync.Once
	waylandInputValue bool
)

func waylandInputActive() bool {
	waylandInputOnce.Do(func() {
		waylandInputValue = hasCmd("ydotool")
	})
	return os.Getenv("WAYLAND_DISPLAY") != "" && waylandInputValue
}

func hasCmd(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func runYdotool(args ...string) error {
	cmd := exec.Command("ydotool", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ydotool %v: %w: %s", args, err, string(out))
	}
	return nil
}

// ydotoolMouseMove moves the pointer to an absolute screen coordinate.
func ydotoolMouseMove(x, y int) error {
	return runYdotool("mousemove", "--absolute", "-x", strconv.Itoa(x), "-y", strconv.Itoa(y))
}

// ydotoolButtonCode maps a logical button name to ydotool's button byte. The low
// nibble selects the button (0 left, 1 right, 2 middle, 3 side, 4 extra); the
// 0x40/0x80 bits request press/release, so 0xC0|n is a full down+up click.
func ydotoolButtonCode(button string) string {
	var n byte
	switch button {
	case "right":
		n = 1
	case "middle":
		n = 2
	case "back":
		n = 3
	case "forward":
		n = 4
	default: // left
		n = 0
	}
	return fmt.Sprintf("0x%02X", 0xC0|n)
}

// ydotoolMouseClick performs a full press+release of the named button at the
// current pointer position.
func ydotoolMouseClick(button string) error {
	return runYdotool("click", ydotoolButtonCode(button))
}

// ydotoolMouseDrag moves to the start, presses the button down, moves to the
// end, then releases — a press-hold-move-release drag. 0x40|n is button-down,
// 0x80|n is button-up (left button = nibble 0).
func ydotoolMouseDrag(fromX, fromY, toX, toY int) error {
	if err := ydotoolMouseMove(fromX, fromY); err != nil {
		return err
	}
	if err := runYdotool("click", "0x40"); err != nil { // left down
		return err
	}
	if err := ydotoolMouseMove(toX, toY); err != nil {
		return err
	}
	return runYdotool("click", "0x80") // left up
}

// ydotoolType types a UTF-8 string. ydotool's `type` handles arbitrary Unicode
// via the uinput device, sidestepping the keysym/keycode dance the XTest
// fallback needs.
func ydotoolType(text string) error {
	return runYdotool("type", "--", text)
}

// ydotoolKeyEvent synthesizes a single named key. ydotool `key` speaks Linux
// evdev keycodes in code:state form (1 = press, 0 = release), so we translate
// via evdevKeycode. Returns ok=false when the key has no evdev mapping, letting
// the caller fall back to XTest.
func ydotoolKeyEvent(key, direction string) (bool, error) {
	code, ok := evdevKeycode(key)
	if !ok {
		return false, nil
	}
	var arg string
	switch direction {
	case "press":
		arg = fmt.Sprintf("%d:1", code)
	case "release":
		arg = fmt.Sprintf("%d:0", code)
	default: // click
		if err := runYdotool("key", fmt.Sprintf("%d:1", code), fmt.Sprintf("%d:0", code)); err != nil {
			return true, err
		}
		return true, nil
	}
	return true, runYdotool("key", arg)
}

// evdevKeycode maps a logical key name (the same vocabulary parseKey accepts)
// or a single US-QWERTY character to its Linux input-event-code. The character
// map is intentionally US-QWERTY-only: it exists to serve key combos like
// Ctrl+C, where the letter identifies a physical key, not to type text (that
// goes through ydotoolType, which is layout-agnostic). A miss returns ok=false
// so the caller can fall back to XTest.
func evdevKeycode(key string) (int, bool) {
	if c, ok := evdevNamed[key]; ok {
		return c, true
	}
	if len(key) == 1 {
		if c, ok := evdevChar[key[0]]; ok {
			return c, true
		}
	}
	return 0, false
}

// Linux input-event-codes (from <linux/input-event-codes.h>).
var evdevNamed = map[string]int{
	"Return": 28, "return": 28, "Enter": 28, "enter": 28,
	"Tab": 15, "tab": 15,
	"Space": 57, "space": 57,
	"Escape": 1, "escape": 1, "Esc": 1, "esc": 1,
	"Backspace": 14, "backspace": 14,
	"Delete": 111, "delete": 111, "Del": 111, "del": 111,
	"Home": 102, "home": 102,
	"End": 107, "end": 107,
	"PageUp": 104, "pageup": 104,
	"PageDown": 109, "pagedown": 109,
	"Up": 103, "up": 103,
	"Down": 108, "down": 108,
	"Left": 105, "left": 105,
	"Right": 106, "right": 106,
	"Control": 29, "control": 29, "Ctrl": 29, "ctrl": 29,
	"Shift": 42, "shift": 42,
	"Alt": 56, "alt": 56,
	"Meta": 125, "meta": 125, "Super": 125, "super": 125,
}

// evdevChar maps US-QWERTY printable characters to evdev keycodes. Letters are
// case-folded (Shift is a separate key); digits and the common symbols share the
// unshifted keycode of the physical key they sit on.
var evdevChar = map[byte]int{
	'a': 30, 'b': 48, 'c': 46, 'd': 32, 'e': 18, 'f': 33, 'g': 34,
	'h': 35, 'i': 23, 'j': 36, 'k': 37, 'l': 38, 'm': 50, 'n': 49,
	'o': 24, 'p': 25, 'q': 16, 'r': 19, 's': 31, 't': 20, 'u': 22,
	'v': 47, 'w': 17, 'x': 45, 'y': 21, 'z': 44,
	'A': 30, 'B': 48, 'C': 46, 'D': 32, 'E': 18, 'F': 33, 'G': 34,
	'H': 35, 'I': 23, 'J': 36, 'K': 37, 'L': 38, 'M': 50, 'N': 49,
	'O': 24, 'P': 25, 'Q': 16, 'R': 19, 'S': 31, 'T': 20, 'U': 22,
	'V': 47, 'W': 17, 'X': 45, 'Y': 21, 'Z': 44,
	'1': 2, '2': 3, '3': 4, '4': 5, '5': 6,
	'6': 7, '7': 8, '8': 9, '9': 10, '0': 11,
	'-': 12, '=': 13, '[': 26, ']': 27, '\\': 43,
	';': 39, '\'': 40, '`': 41, ',': 51, '.': 52, '/': 53,
}
