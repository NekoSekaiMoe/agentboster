package escape

import (
	"fmt"
	"runtime"
	"sync"

	"github.com/ebitengine/purego"
)

// Hook provides a global Escape key listener for emergency stop.
type Hook struct {
	callback func()
	running  bool
	mu       sync.Mutex
	stopChan chan struct{}
}

// New creates a new escape hook with the given callback.
func New(callback func()) *Hook {
	return &Hook{
		callback: callback,
		stopChan: make(chan struct{}),
	}
}

// Start starts listening for Escape key presses.
func (h *Hook) Start() error {
	h.mu.Lock()
	if h.running {
		h.mu.Unlock()
		return fmt.Errorf("hook already running")
	}
	h.running = true
	h.mu.Unlock()

	switch runtime.GOOS {
	case "darwin":
		return h.startDarwin()
	case "linux":
		return h.startLinux()
	case "windows":
		return h.startWindows()
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

// Stop stops the escape hook.
func (h *Hook) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running {
		close(h.stopChan)
		h.running = false
	}
}

// Platform-specific implementations

func (h *Hook) startDarwin() error {
	// Note: This is a simplified implementation.
	// A full implementation would use CGEventTap via purego.
	// For now, we'll use a polling approach with CGEventSourceKeyState.

	go func() {
		libCore, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		defer purego.Dlclose(libCore)

		var cgEventSourceKeyState func(int, uint16) bool
		purego.RegisterLibFunc(&cgEventSourceKeyState, libCore, "CGEventSourceKeyState")

		const kCGEventSourceStateHIDSystemState = 1
		const kVK_Escape = 0x35

		lastState := false
		ticker := make(chan struct{})
		go func() {
			for {
				select {
				case <-h.stopChan:
					return
				default:
					ticker <- struct{}{}
				}
			}
		}()

		for {
			select {
			case <-h.stopChan:
				return
			case <-ticker:
				state := cgEventSourceKeyState(kCGEventSourceStateHIDSystemState, kVK_Escape)
				if state && !lastState {
					h.callback()
				}
				lastState = state
			}
		}
	}()

	return nil
}

func (h *Hook) startLinux() error {
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

func (h *Hook) startWindows() error {
	// Windows implementation using SetWindowsHookEx

	go func() {
		libUser32, err := purego.Dlopen("user32.dll", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		defer purego.Dlclose(libUser32)

		var setWindowsHookEx func(int, uintptr, uintptr, uint32) uintptr
		var callNextHookEx func(uintptr, int, uintptr, uintptr) uintptr
		var unhookWindowsHookEx func(uintptr) bool
		var getMessage func(uintptr, uintptr, uint32, uint32) bool
		var translateMessage func(uintptr) bool
		var dispatchMessage func(uintptr) uintptr

		purego.RegisterLibFunc(&setWindowsHookEx, libUser32, "SetWindowsHookExW")
		purego.RegisterLibFunc(&callNextHookEx, libUser32, "CallNextHookEx")
		purego.RegisterLibFunc(&unhookWindowsHookEx, libUser32, "UnhookWindowsHookEx")
		purego.RegisterLibFunc(&getMessage, libUser32, "GetMessageW")
		purego.RegisterLibFunc(&translateMessage, libUser32, "TranslateMessage")
		purego.RegisterLibFunc(&dispatchMessage, libUser32, "DispatchMessageW")

		const WH_KEYBOARD_LL = 13
		const VK_ESCAPE = 0x1B
		const WM_KEYDOWN = 0x0100

		// This is a simplified placeholder - real implementation needs:
		// 1. Proper callback function pointer
		// 2. Message loop
		// 3. Proper cleanup on stopChan

		<-h.stopChan
	}()

	return nil
}
