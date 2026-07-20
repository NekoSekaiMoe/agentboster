//go:build darwin

package accessibility

func newBackend() (backend, error) {
	return newDarwinBackend()
}
