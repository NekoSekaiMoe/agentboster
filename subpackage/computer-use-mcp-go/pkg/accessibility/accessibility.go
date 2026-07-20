package accessibility

import (
	"fmt"
	"runtime"
)

// Node represents a unified accessibility tree node across platforms.
type Node struct {
	ID          string            `json:"id"`
	Role        string            `json:"role"`
	Name        string            `json:"name,omitempty"`
	Description string            `json:"description,omitempty"`
	Value       string            `json:"value,omitempty"`
	Bounds      Bounds            `json:"bounds"`
	Enabled     bool              `json:"enabled"`
	Focused     bool              `json:"focused"`
	Children    []*Node           `json:"children,omitempty"`
	Attributes  map[string]string `json:"attributes,omitempty"`
}

// Bounds represents the screen position and size of an element.
type Bounds struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Client provides platform-independent accessibility tree access.
type Client struct {
	backend backend
}

// backend is the platform-specific implementation interface.
type backend interface {
	GetTree() (*Node, error)
	GetNodeByID(id string) (*Node, error)
	PerformAction(id string, action string) error
	Close() error
}

// New creates a new accessibility client for the current platform.
func New() (*Client, error) {
	var b backend
	var err error

	switch runtime.GOOS {
	case "darwin":
		b, err = newDarwinBackend()
	case "linux":
		b, err = newLinuxBackend()
	case "windows":
		b, err = newWindowsBackend()
	default:
		return nil, fmt.Errorf("accessibility not supported on %s", runtime.GOOS)
	}

	if err != nil {
		return nil, err
	}

	return &Client{backend: b}, nil
}

// GetTree returns the complete accessibility tree from the root.
func (c *Client) GetTree() (*Node, error) {
	return c.backend.GetTree()
}

// GetNodeByID retrieves a specific node by its ID.
func (c *Client) GetNodeByID(id string) (*Node, error) {
	return c.backend.GetNodeByID(id)
}

// PerformAction executes an action on a node (e.g., "click", "focus").
func (c *Client) PerformAction(id string, action string) error {
	return c.backend.PerformAction(id, action)
}

// Close releases resources held by the accessibility client.
func (c *Client) Close() error {
	return c.backend.Close()
}
