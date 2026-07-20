package coord

// Mapper converts between screenshot-scaled coordinates and native screen coordinates.
type Mapper struct {
	scaleFactor float64
	originX     int
	originY     int
}

// New creates a coordinate mapper with the given scale factor and origin at (0, 0).
func New(scaleFactor float64) *Mapper {
	return &Mapper{
		scaleFactor: scaleFactor,
		originX:     0,
		originY:     0,
	}
}

// NewWithOrigin creates a coordinate mapper with the given scale factor and monitor origin.
func NewWithOrigin(scaleFactor float64, originX, originY int) *Mapper {
	return &Mapper{
		scaleFactor: scaleFactor,
		originX:     originX,
		originY:     originY,
	}
}

// ToNative converts screenshot-scaled coordinates to native screen coordinates.
func (m *Mapper) ToNative(x, y float64) (int, int) {
	nx := int(x*m.scaleFactor) + m.originX
	ny := int(y*m.scaleFactor) + m.originY
	return nx, ny
}

// ToScaled converts native screen coordinates to screenshot-scaled coordinates.
func (m *Mapper) ToScaled(x, y int) (float64, float64) {
	sx := float64(x-m.originX) / m.scaleFactor
	sy := float64(y-m.originY) / m.scaleFactor
	return sx, sy
}
