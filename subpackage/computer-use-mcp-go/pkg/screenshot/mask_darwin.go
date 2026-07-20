//go:build darwin

package screenshot

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework CoreGraphics -framework Foundation

#include <CoreGraphics/CoreGraphics.h>
#include <Foundation/Foundation.h>

// Get all terminal window IDs
void getTerminalWindows(CFArrayRef windowList, uint64_t** ids, int* count) {
    CFIndex windowCount = CFArrayGetCount(windowList);
    int terminalCount = 0;
    uint64_t* terminalIDs = malloc(sizeof(uint64_t) * windowCount);

    // Known terminal bundle IDs
    const char* terminalBundles[] = {
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "com.github.wez.wezterm",
        "net.kovidgoyal.kitty",
        "com.ragnar-brynjulfsson.hyperterm",
        "co.zeit.hyper",
        "com.sublimetext.4",
        "com.microsoft.VSCode",
        NULL
    };

    for (CFIndex i = 0; i < windowCount; i++) {
        CFDictionaryRef window = CFArrayGetValueAtIndex(windowList, i);

        // Get owner name (bundle ID)
        CFStringRef owner = CFDictionaryGetValue(window, kCGWindowOwnerName);
        if (!owner) continue;

        // Check if it's a terminal
        bool isTerminal = false;
        for (int j = 0; terminalBundles[j] != NULL; j++) {
            CFStringRef terminalName = CFStringCreateWithCString(NULL, terminalBundles[j], kCFStringEncodingUTF8);
            if (CFStringFind(owner, terminalName, kCFCompareCaseInsensitive).location != kCFNotFound) {
                isTerminal = true;
                CFRelease(terminalName);
                break;
            }
            CFRelease(terminalName);
        }

        if (isTerminal) {
            CFNumberRef windowID = CFDictionaryGetValue(window, kCGWindowNumber);
            if (windowID) {
                uint32_t wid;
                CFNumberGetValue(windowID, kCFNumberSInt32Type, &wid);
                terminalIDs[terminalCount++] = (uint64_t)wid;
            }
        }
    }

    *ids = terminalIDs;
    *count = terminalCount;
}

// Get window bounds for given window IDs
void getWindowRects(CFArrayRef windowList, uint64_t* ids, int idCount,
                   int monitorX, int monitorY, int screenWidth, int screenHeight,
                   int** rects, int* rectCount) {
    int found = 0;
    int* bounds = malloc(sizeof(int) * idCount * 4); // x, y, width, height per window

    CFIndex windowCount = CFArrayGetCount(windowList);
    for (int i = 0; i < idCount; i++) {
        uint64_t targetID = ids[i];

        for (CFIndex j = 0; j < windowCount; j++) {
            CFDictionaryRef window = CFArrayGetValueAtIndex(windowList, j);
            CFNumberRef windowID = CFDictionaryGetValue(window, kCGWindowNumber);
            if (!windowID) continue;

            uint32_t wid;
            CFNumberGetValue(windowID, kCFNumberSInt32Type, &wid);

            if ((uint64_t)wid == targetID) {
                CFDictionaryRef boundsDict = CFDictionaryGetValue(window, kCGWindowBounds);
                if (boundsDict) {
                    CGRect rect;
                    CGRectMakeWithDictionaryRepresentation(boundsDict, &rect);

                    // Convert to screen coordinates relative to monitor
                    int x = (int)rect.origin.x - monitorX;
                    int y = (int)rect.origin.y - monitorY;
                    int w = (int)rect.size.width;
                    int h = (int)rect.size.height;

                    // Clamp to screen bounds
                    if (x < 0) { w += x; x = 0; }
                    if (y < 0) { h += y; y = 0; }
                    if (x + w > screenWidth) w = screenWidth - x;
                    if (y + h > screenHeight) h = screenHeight - y;

                    if (w > 0 && h > 0) {
                        bounds[found * 4 + 0] = x;
                        bounds[found * 4 + 1] = y;
                        bounds[found * 4 + 2] = w;
                        bounds[found * 4 + 3] = h;
                        found++;
                    }
                }
                break;
            }
        }
    }

    *rects = bounds;
    *rectCount = found;
}
*/
import "C"
import (
	"image"
	"unsafe"
)

type WindowID uint64

func getTerminalWindowIDs() []WindowID {
	windowList := C.CGWindowListCopyWindowInfo(C.kCGWindowListOptionOnScreenOnly, C.kCGNullWindowID)
	if windowList == 0 {
		return nil
	}
	defer C.CFRelease(C.CFTypeRef(windowList))

	var ids *C.uint64_t
	var count C.int
	C.getTerminalWindows(C.CFArrayRef(windowList), &ids, &count)
	if count == 0 {
		return nil
	}
	defer C.free(unsafe.Pointer(ids))

	result := make([]WindowID, int(count))
	idSlice := unsafe.Slice(ids, int(count))
	for i, id := range idSlice {
		result[i] = WindowID(id)
	}
	return result
}

func getTerminalWindowRects(ids []WindowID, monitorOrigin [2]int, screenWidth, screenHeight int) []image.Rectangle {
	if len(ids) == 0 {
		return nil
	}

	windowList := C.CGWindowListCopyWindowInfo(C.kCGWindowListOptionOnScreenOnly, C.kCGNullWindowID)
	if windowList == 0 {
		return nil
	}
	defer C.CFRelease(C.CFTypeRef(windowList))

	cIDs := make([]C.uint64_t, len(ids))
	for i, id := range ids {
		cIDs[i] = C.uint64_t(id)
	}

	var rects *C.int
	var rectCount C.int
	C.getWindowRects(
		C.CFArrayRef(windowList),
		&cIDs[0],
		C.int(len(ids)),
		C.int(monitorOrigin[0]),
		C.int(monitorOrigin[1]),
		C.int(screenWidth),
		C.int(screenHeight),
		&rects,
		&rectCount,
	)
	if rectCount == 0 {
		return nil
	}
	defer C.free(unsafe.Pointer(rects))

	result := make([]image.Rectangle, int(rectCount))
	rectSlice := unsafe.Slice(rects, int(rectCount)*4)
	for i := 0; i < int(rectCount); i++ {
		result[i] = image.Rect(
			int(rectSlice[i*4+0]),
			int(rectSlice[i*4+1]),
			int(rectSlice[i*4+0])+int(rectSlice[i*4+2]),
			int(rectSlice[i*4+1])+int(rectSlice[i*4+3]),
		)
	}
	return result
}
