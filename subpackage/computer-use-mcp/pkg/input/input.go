package input

import (
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/coord"
)

// Controller simulates mouse and keyboard input.
type Controller struct {
	coordMapper *coord.Mapper
}

// Public accessor for coordinate mapper (used by main.go)
func (c *Controller) CoordMapper() *coord.Mapper {
	return c.coordMapper
}

// New creates an input controller with the given scale factor.
func New(scaleFactor float64) (*Controller, error) {
	return &Controller{
		coordMapper: coord.New(scaleFactor),
	}, nil
}

// NewWithOrigin creates an input controller with scale factor and monitor origin.
func NewWithOrigin(scaleFactor float64, originX, originY int) (*Controller, error) {
	return &Controller{
		coordMapper: coord.NewWithOrigin(scaleFactor, originX, originY),
	}, nil
}

// MouseMove moves the cursor to (x, y) in screenshot-scaled coordinates.
func (c *Controller) MouseMove(x, y float64) error {
	nx, ny := c.coordMapper.ToNative(x, y)
	return mouseMove(nx, ny)
}

// MouseClick clicks at (x, y) with the specified button.
// button: "left", "right", "middle", "back", "forward"
// double: true for double-click
func (c *Controller) MouseClick(x, y float64, button string, double bool) error {
	if err := c.MouseMove(x, y); err != nil {
		return err
	}
	if err := mouseClick(button); err != nil {
		return err
	}
	if double {
		if err := mouseClick(button); err != nil {
			return err
		}
	}
	return nil
}

// MouseDrag drags from (fromX, fromY) to (toX, toY).
func (c *Controller) MouseDrag(fromX, fromY, toX, toY float64) error {
	fx, fy := c.coordMapper.ToNative(fromX, fromY)
	tx, ty := c.coordMapper.ToNative(toX, toY)
	return mouseDrag(fx, fy, tx, ty)
}

// TypeText types a string of text.
func (c *Controller) TypeText(text string) error {
	return typeText(text)
}

// KeyEvent presses a key with optional modifiers.
func (c *Controller) KeyEvent(key string, direction string) error {
	return keyEvent(key, direction)
}

// KeyCombo presses a key combination (e.g., Ctrl+C).
func (c *Controller) KeyCombo(key string, modifiers []string) error {
	// Press modifiers
	for _, mod := range modifiers {
		if err := keyEvent(mod, "press"); err != nil {
			return err
		}
	}

	// Press main key
	if err := keyEvent(key, "click"); err != nil {
		return err
	}

	// Release modifiers in reverse order
	for i := len(modifiers) - 1; i >= 0; i-- {
		if err := keyEvent(modifiers[i], "release"); err != nil {
			return err
		}
	}

	return nil
}

// GetForegroundWindowID returns the foreground window ID, or 0 if unavailable.
func GetForegroundWindowID() uint64 {
	return getForegroundWindowID()
}

// ParseKey converts a key string to platform-specific key code.
func ParseKey(s string) (interface{}, error) {
	return parseKey(s)
}
