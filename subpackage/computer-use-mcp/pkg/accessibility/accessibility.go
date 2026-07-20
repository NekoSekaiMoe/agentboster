package accessibility

// Node represents a unified accessibility tree node across platforms.
type Node struct {
	ID          string   `json:"id"`
	Role        string   `json:"role"`
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
	BoundingBox [4]int   `json:"bounding_box"` // [x, y, width, height]
	Enabled     bool     `json:"enabled"`
	Focused     bool     `json:"focused"`
	Children    []*Node  `json:"children,omitempty"`
}

// Client provides platform-independent accessibility tree access.
type Client struct {
	backend backend
}

// New creates a new accessibility client for the current platform.
func New() (*Client, error) {
	var b backend
	var err error

	b, err = newBackend()
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
