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
	defer h.mu.Unlock()
	if h.running {
		close(h.stopChan)
		h.running = false
	}
}
