//go:build !linux

package accessibility

import "fmt"

func newLinuxBackend() (backend, error) {
	return nil, fmt.Errorf("linux backend not available on this platform")
}
