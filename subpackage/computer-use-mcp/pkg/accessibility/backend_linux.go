//go:build linux

package accessibility

func newBackend() (backend, error) {
	return newLinuxBackend()
}
