package coord

import (
	"math"
	"testing"
)

func TestCoordMapper(t *testing.T) {
	tests := []struct {
		name        string
		scaleFactor float64
		originX     int
		originY     int
		scaledX     float64
		scaledY     float64
		nativeX     int
		nativeY     int
	}{
		{
			name:        "no scaling, no origin",
			scaleFactor: 1.0,
			originX:     0,
			originY:     0,
			scaledX:     100.0,
			scaledY:     200.0,
			nativeX:     100,
			nativeY:     200,
		},
		{
			name:        "2x scaling, no origin",
			scaleFactor: 2.0,
			originX:     0,
			originY:     0,
			scaledX:     100.0,
			scaledY:     200.0,
			nativeX:     200,
			nativeY:     400,
		},
		{
			name:        "2x scaling with origin",
			scaleFactor: 2.0,
			originX:     1920,
			originY:     0,
			scaledX:     100.0,
			scaledY:     200.0,
			nativeX:     2120,
			nativeY:     400,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := NewWithOrigin(tt.scaleFactor, tt.originX, tt.originY)

			// Test ToNative
			nx, ny := m.ToNative(tt.scaledX, tt.scaledY)
			if nx != tt.nativeX || ny != tt.nativeY {
				t.Errorf("ToNative(%f, %f) = (%d, %d), want (%d, %d)",
					tt.scaledX, tt.scaledY, nx, ny, tt.nativeX, tt.nativeY)
			}

			// Test ToScaled (roundtrip)
			sx, sy := m.ToScaled(nx, ny)
			if math.Abs(sx-tt.scaledX) > 0.01 || math.Abs(sy-tt.scaledY) > 0.01 {
				t.Errorf("ToScaled(%d, %d) = (%f, %f), want (%f, %f)",
					nx, ny, sx, sy, tt.scaledX, tt.scaledY)
			}
		})
	}
}
