//go:build !windows

package accessibility

import "fmt"

func newWindowsBackend() (backend, error) {
	return nil, fmt.Errorf("windows backend not available on this platform")
}
