package escape

import (
	"fmt"
	"sync"
)

// Hook provides a global Escape key listener for emergency stop.
type Hook struct {
	callback func()
	running  bool
	mu       sync.Mutex
	stopChan chan struct{}

	// wakeLoop and wakeThreadID are platform hooks used by startPlatform
	// (currently only on Windows) to unblock the message loop on the
	// dedicated hook thread when Stop is called from another goroutine.
	// Defined as no-ops on platforms that don't need them.
	wakeLoop func()
	// wakeThreadID holds the OS thread id of the hook loop on platforms
	// that publish it (Windows). Always accessed under h.mu.
	wakeThreadID uint32
}

// New creates a new escape hook with the given callback.
func New(callback func()) *Hook {
	return &Hook{
		callback: callback,
		stopChan: make(chan struct{}),
	}
}

// Start starts listening for Escape key presses.
// The platform-specific implementation lives in escape_{darwin,linux,windows}.go.
func (h *Hook) Start() error {
	h.mu.Lock()
	if h.running {
		h.mu.Unlock()
		return fmt.Errorf("hook already running")
	}
	h.running = true
	h.mu.Unlock()

	return h.startPlatform()
}

// Stop stops the escape hook.
func (h *Hook) Stop() {
	h.mu.Lock()
	if !h.running {
		h.mu.Unlock()
		return
	}
	close(h.stopChan)
	h.running = false
	wake := h.wakeLoop
	h.mu.Unlock()

	// Give platform implementations a chance to unblock their event loop
	// (no-op on platforms where reading stopChan is sufficient). Called
	// AFTER releasing h.mu because the platform hook typically re-acquires
	// it to read a published thread id.
	if wake != nil {
		wake()
	}
}
