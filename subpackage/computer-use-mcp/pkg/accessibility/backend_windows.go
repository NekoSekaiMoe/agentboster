//go:build windows

package accessibility

func newBackend() (backend, error) {
	return newWindowsBackend()
}
