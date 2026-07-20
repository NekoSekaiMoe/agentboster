package accessibility

// backend is the platform-specific accessibility implementation.
type backend interface {
	GetTree() (*Node, error)
	GetNodeByID(id string) (*Node, error)
	PerformAction(id string, action string) error
	Close() error
}
