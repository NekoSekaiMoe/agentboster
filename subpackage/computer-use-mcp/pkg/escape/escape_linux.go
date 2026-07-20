//go:build linux

package escape

import (
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

func (h *Hook) startPlatform() error {
	// Linux implementation using X11 XGrabKey on the root window.
	//
	// We open the default display, grab the Escape key with AnyModifier,
	// then run XPendingWindow-driven polling loop that:
	//   1. drains already-queued events with XEventsQueued(QueuedAfterFlush)
	//      in non-blocking mode,
	//   2. calls XNextEvent only when at least one event is available,
	//   3. sleeps briefly between polls to avoid burning CPU,
	//   4. honors h.stopChan for prompt shutdown.
	//
	// XGrabKey + XNextEvent on the root window receives KeyPress events
	// for the Escape key globally (subject to window-manager cooperation).

	go func() {
		libX11, err := purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		defer purego.Dlclose(libX11)

		var (
			xOpenDisplay       func(name *byte) uintptr
			xCloseDisplay      func(display uintptr)
			xDefaultRootWindow func(display uintptr) uintptr
			xGrabKey           func(display uintptr, keycode, modifier int, grabWindow uintptr, ownerEvents, pointerMode, keyboardMode int) int
			xUngrabKey         func(display uintptr, keycode, modifier int, grabWindow uintptr) int
			xSelectInput       func(display uintptr, window uintptr, eventMask int64) int
			xEventsQueued      func(display uintptr, mode int) int
			xNextEvent         func(display uintptr, event uintptr) int
			xFlush             func(display uintptr) int
		)

		purego.RegisterLibFunc(&xOpenDisplay, libX11, "XOpenDisplay")
		purego.RegisterLibFunc(&xCloseDisplay, libX11, "XCloseDisplay")
		purego.RegisterLibFunc(&xDefaultRootWindow, libX11, "XDefaultRootWindow")
		purego.RegisterLibFunc(&xGrabKey, libX11, "XGrabKey")
		purego.RegisterLibFunc(&xUngrabKey, libX11, "XUngrabKey")
		purego.RegisterLibFunc(&xSelectInput, libX11, "XSelectInput")
		purego.RegisterLibFunc(&xEventsQueued, libX11, "XEventsQueued")
		purego.RegisterLibFunc(&xNextEvent, libX11, "XNextEvent")
		purego.RegisterLibFunc(&xFlush, libX11, "XFlush")

		display := xOpenDisplay(nil)
		if display == 0 {
			return
		}
		defer xCloseDisplay(display)

		root := xDefaultRootWindow(display)

		const (
			escapeKeycode = 9 // XK_Escape keycode on the standard PC keyboard
			anyModifier   = 0x8000
			// GrabModeAsync = 1 (don't freeze the keyboard while we handle it).
			grabModeAsync   = 1
			keyPressMask    = 1 << 0 // KeyPressMask
			queuedAfterFlush = 2     // QueuedAfterFlush mode for XEventsQueued
			xKeyPressType    = 2     // XEvent type id for KeyPress
		)

		// Grab Escape key on the root window so we see it globally.
		xGrabKey(display, escapeKeycode, anyModifier, root, 1, grabModeAsync, grabModeAsync)
		defer xUngrabKey(display, escapeKeycode, anyModifier, root)
		xSelectInput(display, root, keyPressMask)

		// XEvent union is 96 bytes on 64-bit (longest member XClientMessage).
		// We allocate a fixed buffer; XNextEvent will write the leading fields.
		var eventBuf [96]byte

		const pollInterval = 50 * time.Millisecond

		for {
			// Drain any queued events without blocking.
			for xEventsQueued(display, queuedAfterFlush) > 0 {
				if xNextEvent(display, uintptr(unsafe.Pointer(&eventBuf[0]))) == 0 {
					// First int field of any XEvent is the type.
					evType := *(*int32)(unsafe.Pointer(&eventBuf[0]))
					if evType == xKeyPressType {
						// We only grabbed Escape (escapeKeycode) on the root
						// window, so any KeyPress that reaches us here is
						// Escape — trigger the emergency-stop callback.
						h.callback()
					}
				}

				// Allow prompt shutdown between events.
				select {
				case <-h.stopChan:
					return
				default:
				}
			}

			// Flush any output and wait briefly before re-polling.
			xFlush(display)

			select {
			case <-h.stopChan:
				return
			case <-time.After(pollInterval):
			}
		}
	}()

	return nil
}
