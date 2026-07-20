//go:build darwin

package escape

import (
	"time"

	"github.com/ebitengine/purego"
)

// startPlatform polls the global Escape key state via CoreGraphics'
// CGEventSourceKeyState. A full implementation would use CGEventTap, but
// that requires Accessibility permission and a more elaborate run-loop
// bridge. Polling is good enough for the emergency-stop use case.
//
// We avoid the previous producer/consumer pattern (an unbuffered channel
// fed by a tight goroutine) because it burned CPU on the producer side
// without providing any real back-pressure. A simple time.Sleep loop with
// a rising-edge check on the key state is cheaper and easier to reason
// about, while still honoring h.stopChan for prompt shutdown.
func (h *Hook) startPlatform() error {
	go func() {
		libCore, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return
		}
		defer purego.Dlclose(libCore)

		var cgEventSourceKeyState func(stateID int, key uint16) bool
		purego.RegisterLibFunc(&cgEventSourceKeyState, libCore, "CGEventSourceKeyState")

		const (
			kCGEventSourceStateHIDSystemState = 1
			kVK_Escape                        = 0x35
			pollInterval                      = 50 * time.Millisecond
		)

		lastState := false
		for {
			// Check for shutdown first so a fast repeat Stop() doesn't have
			// to wait for the next poll.
			select {
			case <-h.stopChan:
				return
			default:
			}

			state := cgEventSourceKeyState(kCGEventSourceStateHIDSystemState, kVK_Escape)
			// Rising edge: false -> true. Suppresses auto-repeat by only
			// firing the callback once per physical press.
			if state && !lastState {
				h.callback()
			}
			lastState = state

			select {
			case <-h.stopChan:
				return
			case <-time.After(pollInterval):
			}
		}
	}()

	return nil
}
