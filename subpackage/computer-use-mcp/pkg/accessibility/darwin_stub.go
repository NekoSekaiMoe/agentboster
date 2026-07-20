//go:build !darwin

package accessibility

import "fmt"

func newDarwinBackend() (backend, error) {
	return nil, fmt.Errorf("darwin backend not available on this platform")
}
