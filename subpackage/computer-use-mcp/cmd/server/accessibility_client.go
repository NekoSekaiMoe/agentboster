package main

import (
	"fmt"
	"sync"

	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/accessibility"
)

// accessibilityClientOnce serializes the lazy construction of the shared
// accessibilityClient across concurrent tools/call dispatches. Without it,
// two handlers running in parallel could each observe accessibilityClient == nil
// and both call accessibility.New(), leaking one backend (and racing on the
// assignment). The first New() error is sticky: once initialization fails we
// keep returning the same error rather than retrying on every call, which
// avoids hammering a missing/blocked backend.
var (
	accessibilityInitOnce sync.Once
	accessibilityInitErr  error

	// accessibilityClient is read by handlers after accessibilityInitOnce has
	// run; it is nil only when accessibilityInitErr is non-nil.
	accessibilityClient *accessibility.Client
)

// ensureAccessibilityClient initializes the shared accessibility client
// exactly once and returns it, or the sticky initialization error. Callers
// must NOT mutate the returned client's state in a non-thread-safe way; the
// upstream Client is safe for concurrent use of its read methods (GetTree /
// GetNodeByID), and PerformAction is serialized by the backend.
func ensureAccessibilityClient() (*accessibility.Client, error) {
	accessibilityInitOnce.Do(func() {
		accessibilityClient, accessibilityInitErr = accessibility.New()
	})
	if accessibilityInitErr != nil {
		return nil, fmt.Errorf("failed to initialize accessibility client: %w", accessibilityInitErr)
	}
	return accessibilityClient, nil
}
