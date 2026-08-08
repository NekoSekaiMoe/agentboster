package coord

import (
	"math"
	"testing"
)

// Edge-case coverage for Mapper that complements mapper_test.go:
// - the New() constructor (origin 0,0) is not exercised by the existing table
// - fractional / sub-1 scale factors
// - negative coordinates and negative monitor origins
// - scale-factor of exactly 1.0 (identity)
// - zero point
// - round-trip symmetry under extreme scale

func TestNewUsesZeroOrigin(t *testing.T) {
	m := New(1.5)
	// With origin (0,0), ToScaled should invert ToNative exactly.
	nx, ny := m.ToNative(10, 20)
	if nx != 15 || ny != 30 {
		t.Fatalf("New(1.5).ToNative(10,20) = (%d,%d), want (15,30)", nx, ny)
	}
	// And the origin is implicitly 0,0 — scaled of (0,0) is (0,0).
	sx, sy := m.ToScaled(0, 0)
	if sx != 0 || sy != 0 {
		t.Fatalf("New(1.5).ToScaled(0,0) = (%f,%f), want (0,0)", sx, sy)
	}
}

func TestScaleFactorOneIsIdentity(t *testing.T) {
	m := New(1.0)
	for _, tc := range []struct{ x, y int }{
		{0, 0}, {100, 200}, {-50, -75}, {1920, 1080},
	} {
		nx, ny := m.ToNative(float64(tc.x), float64(tc.y))
		if nx != tc.x || ny != tc.y {
			t.Errorf("identity ToNative(%d,%d) = (%d,%d), want identity", tc.x, tc.y, nx, ny)
		}
		sx, sy := m.ToScaled(tc.x, tc.y)
		if sx != float64(tc.x) || sy != float64(tc.y) {
			t.Errorf("identity ToScaled(%d,%d) = (%f,%f), want identity", tc.x, tc.y, sx, sy)
		}
	}
}

func TestFractionalScaleRoundTrip(t *testing.T) {
	m := New(0.5)
	// 0.5 scale: native = scaled * 0.5
	nx, ny := m.ToNative(100, 200)
	if nx != 50 || ny != 100 {
		t.Fatalf("ToNative(100,200) at scale 0.5 = (%d,%d), want (50,100)", nx, ny)
	}
	// round-trip: ToScaled(ToNative(x)) ≈ x (float)
	sx, sy := m.ToScaled(nx, ny)
	if math.Abs(sx-100) > 1e-9 || math.Abs(sy-200) > 1e-9 {
		t.Errorf("round-trip at scale 0.5 = (%f,%f), want (100,200)", sx, sy)
	}
}

func TestNegativeOriginMultiMonitor(t *testing.T) {
	// A monitor whose top-left is at (-1920, 0) in the virtual desktop.
	m := NewWithOrigin(1.0, -1920, 0)
	nx, ny := m.ToNative(100, 100)
	if nx != -1820 || ny != 100 {
		t.Fatalf("ToNative with origin (-1920,0) = (%d,%d), want (-1820,100)", nx, ny)
	}
	// Inverse: a native point in that monitor maps back to local scaled.
	sx, sy := m.ToScaled(-1820, 100)
	if sx != 100 || sy != 100 {
		t.Errorf("ToScaled(-1820,100) = (%f,%f), want (100,100)", sx, sy)
	}
}

func TestNegativeScaledCoordinates(t *testing.T) {
	m := New(2.0)
	nx, ny := m.ToNative(-50, -25)
	if nx != -100 || ny != -50 {
		t.Fatalf("ToNative(-50,-25) at scale 2 = (%d,%d), want (-100,-50)", nx, ny)
	}
}

func TestZeroPointWithNonZeroOrigin(t *testing.T) {
	m := NewWithOrigin(2.0, 100, 200)
	// scaled (0,0) → native (origin) because ToNative = scaled*scale + origin
	nx, ny := m.ToNative(0, 0)
	if nx != 100 || ny != 200 {
		t.Fatalf("ToNative(0,0) = (%d,%d), want origin (100,200)", nx, ny)
	}
	// native origin → scaled (0,0) because ToScaled = (native - origin)/scale
	sx, sy := m.ToScaled(100, 200)
	if sx != 0 || sy != 0 {
		t.Fatalf("ToScaled(origin) = (%f,%f), want (0,0)", sx, sy)
	}
}

func TestTruncationBehaviorToNative(t *testing.T) {
	// ToNative truncates toward zero via int() conversion. With scale 3,
	// scaled 10.9 → 32 (truncated from 32.7).
	m := New(3.0)
	nx, _ := m.ToNative(10.9, 0)
	if nx != 32 {
		t.Errorf("ToNative(10.9, 0) = %d, want 32 (truncation of 32.7)", nx)
	}
}
