//go:build linux

package screenshot

import (
	"bytes"
	"fmt"
	"image"
	"testing"
)

// buildPPM assembles a minimal binary P6 PPM from an RGB pixel slice so the
// decoder tests don't depend on grim being installed.
func buildPPM(w, h int, rgb []byte, header string) []byte {
	var buf bytes.Buffer
	if header == "" {
		header = fmt.Sprintf("P6\n%d %d\n255\n", w, h)
	}
	buf.WriteString(header)
	buf.Write(rgb)
	return buf.Bytes()
}

// TestDecodePPMRoundTrip verifies the P6 parser reproduces pixel values exactly
// and lands RGBA alpha at 255. This is the grim hot path, so a channel-order or
// stride bug here would corrupt every Wayland screenshot.
func TestDecodePPMRoundTrip(t *testing.T) {
	const w, h = 2, 2
	rgb := []byte{
		255, 0, 0, 0, 255, 0, // row 0: red, green
		0, 0, 255, 255, 255, 255, // row 1: blue, white
	}
	img, err := decodePPM(buildPPM(w, h, rgb, ""))
	if err != nil {
		t.Fatalf("decodePPM: %v", err)
	}
	if img.Bounds() != image.Rect(0, 0, w, h) {
		t.Fatalf("bounds = %v, want 2x2", img.Bounds())
	}
	want := [][4]uint8{
		{255, 0, 0, 255}, {0, 255, 0, 255},
		{0, 0, 255, 255}, {255, 255, 255, 255},
	}
	for i, px := range []image.Point{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
		r, g, b, a := img.At(px.X, px.Y).RGBA()
		got := [4]uint8{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
		if got != want[i] {
			t.Errorf("pixel %v = %v, want %v", px, got, want[i])
		}
	}
}

// TestDecodePPMComments checks the tokenizer skips '#' comments between header
// tokens, which the PPM spec permits and some encoders emit.
func TestDecodePPMComments(t *testing.T) {
	header := "P6\n# grim output\n1 1\n# maxval below\n255\n"
	img, err := decodePPM(buildPPM(1, 1, []byte{10, 20, 30}, header))
	if err != nil {
		t.Fatalf("decodePPM with comments: %v", err)
	}
	r, g, b, _ := img.At(0, 0).RGBA()
	if uint8(r>>8) != 10 || uint8(g>>8) != 20 || uint8(b>>8) != 30 {
		t.Errorf("pixel = (%d,%d,%d), want (10,20,30)", r>>8, g>>8, b>>8)
	}
}

// TestDecodePPMRejects covers the guard rails: wrong magic, 16-bit maxval, and a
// truncated pixel buffer must all error rather than return a partial image.
func TestDecodePPMRejects(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"wrong magic", []byte("P3\n1 1\n255\n\x00\x00\x00")},
		{"16-bit maxval", buildPPM(1, 1, []byte{0, 0, 0}, "P6\n1 1\n65535\n")},
		{"truncated pixels", buildPPM(2, 2, []byte{1, 2, 3}, "")}, // needs 12 bytes, has 3
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := decodePPM(c.data); err == nil {
				t.Errorf("decodePPM(%s) = nil error, want error", c.name)
			}
		})
	}
}

// TestCropRGBA confirms cropping re-bases to origin (0,0) and clamps an
// over-large rectangle to the source bounds.
func TestCropRGBA(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			src.Pix[y*src.Stride+x*4+0] = uint8(x)
			src.Pix[y*src.Stride+x*4+1] = uint8(y)
			src.Pix[y*src.Stride+x*4+3] = 255
		}
	}
	got := cropRGBA(src, image.Rect(1, 1, 3, 3))
	if got.Bounds() != image.Rect(0, 0, 2, 2) {
		t.Fatalf("bounds = %v, want 2x2 at origin", got.Bounds())
	}
	r, g, _, _ := got.At(0, 0).RGBA()
	if uint8(r>>8) != 1 || uint8(g>>8) != 1 {
		t.Errorf("crop origin pixel = (%d,%d), want (1,1)", r>>8, g>>8)
	}
}
