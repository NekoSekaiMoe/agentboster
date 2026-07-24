//go:build linux

package input

import (
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	xOpenDisplay         func(displayName *byte) uintptr
	xCloseDisplay        func(display uintptr) int
	xTestFakeMotionEvent func(display uintptr, screen int, x, y int, delay uint32) int
	xTestFakeButtonEvent func(display uintptr, button uint, isPress int, delay uint32) int
	xTestFakeKeyEvent    func(display uintptr, keycode uint, isPress int, delay uint32) int
	xFlush               func(display uintptr) int
	xKeysymToKeycode     func(display uintptr, keysym uint64) byte

	// Keyboard-mapping FFI, used by the pure-XTest typeText fallback to support
	// characters that XKeysymToKeycode can't resolve on the current layout
	// (non-ASCII, or symbols not bound to any key). See typeTextFallback.
	xDisplayKeycodes       func(display uintptr, minKC, maxKC *int32) int
	xGetKeyboardMapping    func(display uintptr, firstKC uint, count int32, keysymsPerKC *int32) unsafe.Pointer
	xChangeKeyboardMapping func(display uintptr, firstKC int32, keysymsPerKC int32, keysyms *uint64, numCodes int32) int
	xSync                  func(display uintptr, discard int32) int
	xFree                  func(data unsafe.Pointer) int
)

// X11 keysyms
const (
	XK_Return    = 0xff0d
	XK_Tab       = 0xff09
	XK_space     = 0x0020
	XK_Escape    = 0xff1b
	XK_BackSpace = 0xff08
	XK_Delete    = 0xffff
	XK_Home      = 0xff50
	XK_End       = 0xff57
	XK_Page_Up   = 0xff55
	XK_Page_Down = 0xff56
	XK_Up        = 0xff52
	XK_Down      = 0xff54
	XK_Left      = 0xff51
	XK_Right     = 0xff53
	XK_Shift_L   = 0xffe1
	XK_Shift_R   = 0xffe2
	XK_Control_L = 0xffe3
	XK_Alt_L     = 0xffe9
	XK_Super_L   = 0xffeb
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
	purego.RegisterLibFunc(&xDisplayKeycodes, x11, "XDisplayKeycodes")
	purego.RegisterLibFunc(&xGetKeyboardMapping, x11, "XGetKeyboardMapping")
	purego.RegisterLibFunc(&xChangeKeyboardMapping, x11, "XChangeKeyboardMapping")
	purego.RegisterLibFunc(&xSync, x11, "XSync")
	purego.RegisterLibFunc(&xFree, x11, "XFree")
	purego.RegisterLibFunc(&xTestFakeMotionEvent, xtest, "XTestFakeMotionEvent")
	purego.RegisterLibFunc(&xTestFakeButtonEvent, xtest, "XTestFakeButtonEvent")
	purego.RegisterLibFunc(&xTestFakeKeyEvent, xtest, "XTestFakeKeyEvent")
}

// xtestTypeTextMu serializes the pure-XTest typeText fallback below. That
// path calls XChangeKeyboardMapping (via keyMapper.remap/restore) which
// rewrites the X server's GLOBAL keyboard mapping — not per-connection — so
// two concurrent typeText calls would clobber each other's spare-keycode
// assignments and, worse, one call's restore() could revert a mapping the
// other call was still relying on, producing mistyped or stuck characters.
// The Wayland/xdotool fast paths don't touch the global mapping and skip this
// lock; only the XTest fallback acquires it.
var xtestTypeTextMu sync.Mutex

func mouseMove(x, y int) error {
	if waylandInputActive() {
		if err := ydotoolMouseMove(x, y); err == nil {
			return nil
		}
		// ydotool present but failed (daemon down, no /dev/uinput perms); fall
		// through to XTest, which still drives Xwayland-backed windows.
	}
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
	if waylandInputActive() {
		if err := ydotoolMouseClick(button); err == nil {
			return nil
		}
	}
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
	if waylandInputActive() {
		if err := ydotoolMouseDrag(fromX, fromY, toX, toY); err == nil {
			return nil
		}
	}
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
	// On a Wayland session prefer ydotool: xdotool/XTest can't reach native
	// Wayland windows. Falls through on failure (daemon down / perms).
	if waylandInputActive() {
		if err := ydotoolType(text); err == nil {
			return nil
		}
	}

	// Use xdotool if available for better keyboard layout support
	if _, err := exec.LookPath("xdotool"); err == nil {
		cmd := exec.Command("xdotool", "type", "--clearmodifiers", "--delay", "10", "--", text)
		return cmd.Run()
	}

	// Fallback: character-by-character via XTest. This path handles the full
	// Unicode range, not just ASCII: each rune is converted to an X11 keysym,
	// located on the current layout (respecting the shift level), and — when the
	// keysym is bound to no key at all — temporarily grafted onto a spare keycode
	// via XChangeKeyboardMapping so it can still be synthesized. The remap/
	// restore calls rewrite the X server's GLOBAL keyboard mapping, so the
	// whole fallback is serialized by xtestTypeTextMu to keep concurrent
	// typeText calls from cross-contaminating each other's mapping changes.
	xtestTypeTextMu.Lock()
	defer xtestTypeTextMu.Unlock()

	display := xOpenDisplay(nil)
	if display == 0 {
		return fmt.Errorf("failed to open X display")
	}
	defer xCloseDisplay(display)

	// Prefer XK_Shift_L; fall back to XK_Shift_R for layouts that bind only the
	// right Shift (or have Shift_L unmapped). A 0 result means Shift is entirely
	// unavailable, in which case shifted characters simply can't be typed and
	// are emitted unshifted (the existing behavior).
	shiftKC := xKeysymToKeycode(display, XK_Shift_L)
	if shiftKC == 0 {
		shiftKC = xKeysymToKeycode(display, XK_Shift_R)
	}
	km := newKeyMapper(display)
	defer km.restore()

	for _, ch := range text {
		keysym := runeToKeysym(ch)
		if keysym == 0 {
			continue // no representable keysym for this rune
		}

		keycode, needShift, ok := km.lookup(keysym)
		if !ok {
			// Keysym is not on the layout; graft it onto a spare keycode.
			keycode, ok = km.remap(keysym)
			if !ok {
				continue // no spare keycode available; skip rather than mistype
			}
			needShift = false
		}

		if needShift && shiftKC != 0 {
			xTestFakeKeyEvent(display, uint(shiftKC), 1, 0)
		}
		xTestFakeKeyEvent(display, uint(keycode), 1, 0) // press
		xTestFakeKeyEvent(display, uint(keycode), 0, 0) // release
		if needShift && shiftKC != 0 {
			xTestFakeKeyEvent(display, uint(shiftKC), 0, 0)
		}
		xFlush(display)
	}

	return nil
}

// runeToKeysym converts a Unicode rune to its X11 keysym following the standard
// X convention: Latin-1 (U+0020..U+00FF) maps to the identical keysym value,
// and any other code point maps to 0x01000000 | codepoint (the "Unicode
// keysym" range understood by modern X servers). Control characters below
// space have no printable keysym and return 0.
func runeToKeysym(ch rune) uint64 {
	switch {
	case ch == '\n' || ch == '\r':
		return XK_Return
	case ch == '\t':
		return XK_Tab
	case ch < 0x20:
		return 0
	case ch <= 0x00ff:
		return uint64(ch)
	default:
		return 0x01000000 | uint64(ch)
	}
}

// keyMapper resolves keysyms to keycodes against the live keyboard mapping and,
// for keysyms bound to no key, temporarily rewrites a spare keycode. All
// remapped keycodes are reverted by restore() when typing finishes, so the
// user's layout is left untouched.
type keyMapper struct {
	display      uintptr
	minKC, maxKC int32
	perKC        int32
	keysyms      []uint64 // flattened mapping: (kc-minKC)*perKC + level

	// spare keycodes we commandeered, with the keysym we assigned and whether we
	// have already used a fresh one this session (round-robin over the spares).
	remapped map[uint64]int32 // keysym -> keycode we assigned it
	spares   []int32          // keycodes with no bound keysym, available to graft
	nextSpre int
}

func newKeyMapper(display uintptr) *keyMapper {
	km := &keyMapper{display: display, remapped: map[uint64]int32{}}

	if xDisplayKeycodes == nil || xGetKeyboardMapping == nil {
		return km // FFI unavailable; lookups will simply miss and be skipped
	}
	xDisplayKeycodes(display, &km.minKC, &km.maxKC)
	if km.minKC <= 0 || km.maxKC < km.minKC {
		return km
	}

	count := km.maxKC - km.minKC + 1
	var perKC int32
	ptr := xGetKeyboardMapping(display, uint(km.minKC), count, &perKC)
	if ptr == nil || perKC <= 0 {
		return km
	}
	km.perKC = perKC
	n := int(count * perKC)
	// The server returns a KeySym array (each KeySym is CARD32 on the wire but
	// unsigned long / 8 bytes in Xlib's client-side representation).
	src := unsafe.Slice((*uint64)(ptr), n)
	km.keysyms = make([]uint64, n)
	copy(km.keysyms, src)
	xFree(ptr)

	// Identify spare keycodes: those whose every level maps to NoSymbol (0).
	for kc := km.minKC; kc <= km.maxKC; kc++ {
		base := int(kc-km.minKC) * int(perKC)
		empty := true
		for l := int32(0); l < perKC; l++ {
			if km.keysyms[base+int(l)] != 0 {
				empty = false
				break
			}
		}
		if empty {
			km.spares = append(km.spares, kc)
		}
	}
	return km
}

// lookup finds a keycode whose group-1 mapping produces keysym. It returns the
// keycode, whether Shift must be held (keysym sits at level 1), and ok=false if
// the keysym is not present on the layout at either level.
func (km *keyMapper) lookup(keysym uint64) (byte, bool, bool) {
	if km.perKC == 0 || len(km.keysyms) == 0 {
		// No cached mapping; fall back to the server's own resolver for level 0.
		if xKeysymToKeycode != nil {
			if kc := xKeysymToKeycode(km.display, keysym); kc != 0 {
				return kc, false, true
			}
		}
		return 0, false, false
	}
	for kc := km.minKC; kc <= km.maxKC; kc++ {
		base := int(kc-km.minKC) * int(km.perKC)
		if km.keysyms[base] == keysym { // level 0: unshifted
			return byte(kc), false, true
		}
		if km.perKC > 1 && km.keysyms[base+1] == keysym { // level 1: shifted
			return byte(kc), true, true
		}
	}
	return 0, false, false
}

// remap grafts keysym onto a spare keycode (level 0) via
// XChangeKeyboardMapping so it can be synthesized, caching the assignment so a
// repeated rune reuses the same keycode. Returns ok=false when no spare exists.
//
// Spares are round-robined: once every spare has been used at least once, the
// oldest assignment's keycode is overwritten. Before claiming a recycled
// keycode we evict any prior keysym still pointing at it from the cache, so a
// later lookup of that evicted keysym doesn't return a keycode the server has
// already rebound to something else (which would silently type the wrong
// character). The caller (typeText) holds xtestTypeTextMu, so this mutation is
// race-free.
func (km *keyMapper) remap(keysym uint64) (byte, bool) {
	if xChangeKeyboardMapping == nil || xSync == nil {
		return 0, false
	}
	if kc, ok := km.remapped[keysym]; ok {
		return byte(kc), true
	}
	if len(km.spares) == 0 {
		return 0, false
	}
	// Round-robin over spares so a long string with many distinct unmapped runes
	// doesn't exhaust them permanently (each new keysym overwrites the oldest).
	kc := km.spares[km.nextSpre%len(km.spares)]
	km.nextSpre++

	// Evict any cached assignment that still points at this keycode; the server
	// is about to rebind it to our new keysym, so the stale entry would otherwise
	// cause a future lookup to synthesize the wrong character.
	for oldKeysym, oldKC := range km.remapped {
		if oldKC == kc {
			delete(km.remapped, oldKeysym)
		}
	}

	// Assign the keysym to every level of this keycode so Shift state is
	// irrelevant when we synthesize it.
	levels := make([]uint64, km.perKC)
	for i := range levels {
		levels[i] = keysym
	}
	xChangeKeyboardMapping(km.display, kc, km.perKC, &levels[0], 1)
	xSync(km.display, 0)

	km.remapped[keysym] = kc
	return byte(kc), true
}

// restore reverts every keycode we grafted a keysym onto back to NoSymbol,
// leaving the user's keyboard layout exactly as we found it.
func (km *keyMapper) restore() {
	if len(km.remapped) == 0 || xChangeKeyboardMapping == nil || xSync == nil {
		return
	}
	zeros := make([]uint64, km.perKC)
	for _, kc := range km.remapped {
		xChangeKeyboardMapping(km.display, kc, km.perKC, &zeros[0], 1)
	}
	xSync(km.display, 0)
}

func keyEvent(key string, direction string) error {
	if waylandInputActive() {
		if handled, err := ydotoolKeyEvent(key, direction); handled {
			if err == nil {
				return nil
			}
			// ydotool knows this key but the command failed (daemon down, perms);
			// fall through to XTest.
		}
		// handled==false → no evdev mapping for this key name; fall through to
		// XTest, which resolves it via keysym.
	}
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
