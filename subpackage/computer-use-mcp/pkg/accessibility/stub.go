// +build !linux,!darwin,!windows

package accessibility

import "fmt"

func newDarwinBackend() (backend, error) {
	return nil, fmt.Errorf("darwin backend not available on this platform")
}

func newLinuxBackend() (backend, error) {
	return nil, fmt.Errorf("linux backend not available on this platform")
}

func newWindowsBackend() (backend, error) {
	return nil, fmt.Errorf("windows backend not available on this platform")
}
