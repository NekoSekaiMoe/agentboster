//go:build darwin

package escape

import (
	"github.com/ebitengine/purego"
)

func (h *Hook) startPlatform() error {
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
