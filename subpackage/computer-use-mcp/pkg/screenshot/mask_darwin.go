//go:build darwin

package screenshot

import (
	"image"
	"strings"
	"unsafe"

	"github.com/ebitengine/purego"
)

type WindowID uint64

var (
	coreGraphics uintptr

	// CoreFoundation functions
	cfRelease                    func(cf uintptr)
	cfArrayGetCount              func(array uintptr) int64
	cfArrayGetValueAtIndex       func(array uintptr, idx int64) uintptr
	cfDictionaryGetValue         func(dict uintptr, key uintptr) uintptr
	cfStringCreateWithCString    func(alloc uintptr, cStr *byte, encoding uint32) uintptr
	cfStringFind                 func(theString uintptr, stringToFind uintptr, compareOptions uint32) (location int64, length int64)
	cfNumberGetValue             func(number uintptr, theType int32, valuePtr unsafe.Pointer) bool
	cfStringGetCString           func(theString uintptr, buffer *byte, bufferSize int64, encoding uint32) bool
	cfStringGetLength            func(theString uintptr) int64
	cfStringGetMaximumSizeForEncoding func(theString uintptr, encoding uint32) int64
	cgRectMakeWithDict           func(dict uintptr, rect unsafe.Pointer) bool

	// CoreGraphics functions
	cgWindowListCopyWindowInfo func(option uint32, relativeToWindow uint32) uintptr

	// Constants
	kCGWindowListOptionOnScreenOnly uint32 = 0x01
	kCGNullWindowID                 uint32 = 0
	kCFStringEncodingUTF8           uint32 = 0x08000100
	kCFCompareCaseInsensitive       uint32 = 1
	kCFNumberSInt32Type             int32  = 3

	// Keys (as Go strings, we'll convert them on demand)
	kCGWindowOwnerName = "kCGWindowOwnerName"
	kCGWindowNumber    = "kCGWindowNumber"
	kCGWindowBounds    = "kCGWindowBounds"
)

func init() {
	// If anything below panics (missing symbol, partial framework), recover
	// and leave all func vars nil so getTerminalWindowIDs returns nil cleanly.
	defer func() {
		_ = recover()
	}()

	var err error
	coreGraphics, err = purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		// Silently fail - getTerminalWindowIDs will return nil
		return
	}

	coreFoundation, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}

	// Register CoreFoundation functions
	purego.RegisterLibFunc(&cfRelease, coreFoundation, "CFRelease")
	purego.RegisterLibFunc(&cfArrayGetCount, coreFoundation, "CFArrayGetCount")
	purego.RegisterLibFunc(&cfArrayGetValueAtIndex, coreFoundation, "CFArrayGetValueAtIndex")
	purego.RegisterLibFunc(&cfDictionaryGetValue, coreFoundation, "CFDictionaryGetValue")
	purego.RegisterLibFunc(&cfStringCreateWithCString, coreFoundation, "CFStringCreateWithCString")
	purego.RegisterLibFunc(&cfStringFind, coreFoundation, "CFStringFind")
	purego.RegisterLibFunc(&cfNumberGetValue, coreFoundation, "CFNumberGetValue")
	purego.RegisterLibFunc(&cfStringGetCString, coreFoundation, "CFStringGetCString")
	purego.RegisterLibFunc(&cfStringGetLength, coreFoundation, "CFStringGetLength")
	purego.RegisterLibFunc(&cfStringGetMaximumSizeForEncoding, coreFoundation, "CFStringGetMaximumSizeForEncoding")
	purego.RegisterLibFunc(&cgRectMakeWithDict, coreFoundation, "CGRectMakeWithDictionaryRepresentation")

	// Register CoreGraphics functions
	purego.RegisterLibFunc(&cgWindowListCopyWindowInfo, coreGraphics, "CGWindowListCopyWindowInfo")
}

// Known terminal bundle IDs and app names
var terminalIdentifiers = []string{
	"Terminal",
	"iTerm",
	"iTerm2",
	"WezTerm",
	"kitty",
	"Hyper",
	"Alacritty",
	"Code", // VSCode integrated terminal
}

func createCFString(s string) uintptr {
	if cfStringCreateWithCString == nil {
		return 0
	}
	cstr := append([]byte(s), 0)
	return cfStringCreateWithCString(0, &cstr[0], kCFStringEncodingUTF8)
}

func cfStringToGoString(cfStr uintptr) string {
	if cfStr == 0 || cfStringGetLength == nil || cfStringGetCString == nil || cfStringGetMaximumSizeForEncoding == nil {
		return ""
	}

	length := cfStringGetLength(cfStr)
	if length == 0 {
		return ""
	}

	// CFStringGetLength returns UTF-16 code unit count, not bytes. Size the
	// buffer for the worst-case UTF-8 expansion plus the NUL terminator, so
	// supplementary-plane characters (emoji) do not overflow.
	maxBytes := cfStringGetMaximumSizeForEncoding(cfStr, kCFStringEncodingUTF8)
	bufSize := maxBytes + 1
	if bufSize < 1 {
		// Defensive: overflow / negative — bail out rather than under-allocate.
		return ""
	}

	buf := make([]byte, bufSize)
	if !cfStringGetCString(cfStr, &buf[0], bufSize, kCFStringEncodingUTF8) {
		return ""
	}

	// Find null terminator
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i])
		}
	}
	return string(buf)
}

func isTerminalApp(ownerName string) bool {
	lower := strings.ToLower(ownerName)
	for _, term := range terminalIdentifiers {
		if strings.Contains(lower, strings.ToLower(term)) {
			return true
		}
	}
	return false
}

func getTerminalWindowIDs() []WindowID {
	if cgWindowListCopyWindowInfo == nil {
		return nil
	}

	windowList := cgWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
	if windowList == 0 {
		return nil
	}
	defer cfRelease(windowList)

	windowCount := cfArrayGetCount(windowList)
	if windowCount == 0 {
		return nil
	}

	var terminalIDs []WindowID
	keyOwnerName := createCFString(kCGWindowOwnerName)
	if keyOwnerName != 0 {
		defer cfRelease(keyOwnerName)
	}
	keyWindowNumber := createCFString(kCGWindowNumber)
	if keyWindowNumber != 0 {
		defer cfRelease(keyWindowNumber)
	}

	for i := int64(0); i < windowCount; i++ {
		window := cfArrayGetValueAtIndex(windowList, i)
		if window == 0 {
			continue
		}

		// Get owner name
		ownerNameCF := cfDictionaryGetValue(window, keyOwnerName)
		if ownerNameCF == 0 {
			continue
		}

		ownerName := cfStringToGoString(ownerNameCF)
		if !isTerminalApp(ownerName) {
			continue
		}

		// Get window ID
		windowNumberCF := cfDictionaryGetValue(window, keyWindowNumber)
		if windowNumberCF == 0 {
			continue
		}

		var wid uint32
		if cfNumberGetValue(windowNumberCF, kCFNumberSInt32Type, unsafe.Pointer(&wid)) {
			terminalIDs = append(terminalIDs, WindowID(wid))
		}
	}

	return terminalIDs
}

type cgRect struct {
	x, y, width, height float64
}

func getTerminalWindowRects(ids []WindowID, monitorOrigin [2]int, screenWidth, screenHeight int) []image.Rectangle {
	if len(ids) == 0 || cgWindowListCopyWindowInfo == nil {
		return nil
	}

	windowList := cgWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
	if windowList == 0 {
		return nil
	}
	defer cfRelease(windowList)

	windowCount := cfArrayGetCount(windowList)
	if windowCount == 0 {
		return nil
	}

	keyWindowNumber := createCFString(kCGWindowNumber)
	if keyWindowNumber != 0 {
		defer cfRelease(keyWindowNumber)
	}
	keyWindowBounds := createCFString(kCGWindowBounds)
	if keyWindowBounds != 0 {
		defer cfRelease(keyWindowBounds)
	}

	// Build a map for quick lookup
	idMap := make(map[WindowID]bool, len(ids))
	for _, id := range ids {
		idMap[id] = true
	}

	var rects []image.Rectangle

	for i := int64(0); i < windowCount; i++ {
		window := cfArrayGetValueAtIndex(windowList, i)
		if window == 0 {
			continue
		}

		// Get window ID
		windowNumberCF := cfDictionaryGetValue(window, keyWindowNumber)
		if windowNumberCF == 0 {
			continue
		}

		var wid uint32
		if !cfNumberGetValue(windowNumberCF, kCFNumberSInt32Type, unsafe.Pointer(&wid)) {
			continue
		}

		// Check if this is one of our target windows
		if !idMap[WindowID(wid)] {
			continue
		}

		// Get window bounds
		boundsDict := cfDictionaryGetValue(window, keyWindowBounds)
		if boundsDict == 0 {
			continue
		}

		var rect cgRect
		if !cgRectMakeWithDict(boundsDict, unsafe.Pointer(&rect)) {
			continue
		}

		// Convert to screen coordinates relative to monitor
		x := int(rect.x) - monitorOrigin[0]
		y := int(rect.y) - monitorOrigin[1]
		w := int(rect.width)
		h := int(rect.height)

		// Clamp to screen bounds
		if x < 0 {
			w += x
			x = 0
		}
		if y < 0 {
			h += y
			y = 0
		}
		if x+w > screenWidth {
			w = screenWidth - x
		}
		if y+h > screenHeight {
			h = screenHeight - y
		}

		if w > 0 && h > 0 {
			rects = append(rects, image.Rect(x, y, x+w, y+h))
		}
	}

	return rects
}
