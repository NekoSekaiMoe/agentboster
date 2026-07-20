//go:build linux

package escape

import (
	"github.com/ebitengine/purego"
)

func (h *Hook) startPlatform() error {
	// Linux implementation using X11 XGrabKey
	// This is a simplified version - production code would need proper X11 event loop

	go func() {
		libX11, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		defer purego.Dlclose(libX11)

		var xOpenDisplay func(*byte) uintptr
		var xCloseDisplay func(uintptr)
		var xDefaultRootWindow func(uintptr) uintptr
		var xGrabKey func(uintptr, int, uint, uintptr, int, int, int)
		var xSelectInput func(uintptr, uintptr, int64)
		var xNextEvent func(uintptr, uintptr)

		purego.RegisterLibFunc(&xOpenDisplay, libX11, "XOpenDisplay")
		purego.RegisterLibFunc(&xCloseDisplay, libX11, "XCloseDisplay")
		purego.RegisterLibFunc(&xDefaultRootWindow, libX11, "XDefaultRootWindow")
		purego.RegisterLibFunc(&xGrabKey, libX11, "XGrabKey")
		purego.RegisterLibFunc(&xSelectInput, libX11, "XSelectInput")
		purego.RegisterLibFunc(&xNextEvent, libX11, "XNextEvent")

		display := xOpenDisplay(nil)
		if display == 0 {
			return
		}
		defer xCloseDisplay(display)

		root := xDefaultRootWindow(display)
		const escapeKeycode = 9 // XK_Escape keycode
		const anyModifier = 0x8000

		// Grab Escape key
		xGrabKey(display, escapeKeycode, anyModifier, root, 1, 1, 1)
		xSelectInput(display, root, 1) // KeyPressMask

		// Event loop (simplified - real implementation needs proper XEvent handling)
		for {
			select {
			case <-h.stopChan:
				return
			default:
				// This is a placeholder - real implementation needs proper event polling
				// with select/epoll to avoid blocking
			}
		}
	}()

	return nil
}
