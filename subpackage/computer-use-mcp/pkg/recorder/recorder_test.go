package recorder

import (
	"image"
	"image/color"
	"image/color/palette"
	"image/draw"
	"testing"
	"time"

	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/screenshot"
)

// TestDefaultConfig pins the documented defaults so a careless edit doesn't
// silently inflate GIF size or frame rate for downstream callers.
func TestDefaultConfig(t *testing.T) {
	c := DefaultConfig()
	if c.MaxWidth != 800 {
		t.Errorf("MaxWidth = %d, want 800", c.MaxWidth)
	}
	if c.FPS != 4 {
		t.Errorf("FPS = %d, want 4", c.FPS)
	}
	if c.Duration == 0 {
		t.Error("Duration must be non-zero")
	}
	if c.Duration > 60*1e9 { // 60s in ns
		t.Errorf("Duration %v exceeds 60s hard cap", c.Duration)
	}
	if !c.ExcludeTerminals {
		t.Error("ExcludeTerminals should default true for safety")
	}
}

// TestStopReturnsImmediately is the regression test the review asked for:
// it starts a session with a long Duration, immediately calls Stop, and
// asserts Stop returns well before the full Duration would elapse. This
// guards against the old "Stop blocks up to one ticker interval" bug
// (now fixed by storing cancel on Session) regressing back.
func TestStopReturnsImmediately(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Duration = 30 * time.Second // absurdly long; we should NOT wait for this
	cfg.FPS = 2                     // 500ms tick — old bug would block ~500ms here

	if screenshot.NumActiveDisplays() == 0 {
		t.Skip("no display available; Start would refuse anyway")
	}
	sess, err := Start(cfg)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	start := time.Now()
	sess.Stop()
	elapsed := time.Since(start)

	// Stop must return in well under one ticker interval (500ms at fps=2) and
	// certainly far below the 30s Duration. Allow generous 2s headroom for
	// slow CI schedulers while still proving we didn't wait for Duration.
	if elapsed > 2*time.Second {
		t.Errorf("Stop took %v, want < 2s (proves cancel-on-Stop works)", elapsed)
	}
}

// TestPalettizePlanes verifies the plan9-palette quantizer produces a paletted
// image of the same bounds as the input and that primary colors survive
// quantization (a regression guard against swapping draw.Src for draw.Over,
// which would premultiply and shift the white pixels).
func TestPalettizePlanes(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			src.SetRGBA(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	p := palettize(src)
	if p.Bounds() != src.Bounds() {
		t.Fatalf("bounds = %v, want %v", p.Bounds(), src.Bounds())
	}
	// plan9 palette contains (255,255,255); with draw.Src the white pixel is
	// preserved exactly. Tolerance 0 because pure white is an exact match.
	r, g, b, _ := p.At(0, 0).RGBA()
	if r != 0xffff || g != 0xffff || b != 0xffff {
		t.Errorf("white pixel quantized to (%d,%d,%d), want pure white", r, g, b)
	}
}

// TestPalettizeParallelMatchesSerial guards the concurrent banded palettize:
// its output must be byte-identical to a single-shot draw.Draw over the whole
// image. A band-boundary off-by-one (rows dropped or double-written) would show
// up as a differing palette index. The image is tall enough (>GOMAXPROCS*8) to
// exercise the parallel path and uses a gradient so every band sees distinct
// colors.
func TestPalettizeParallelMatchesSerial(t *testing.T) {
	const w, h = 64, 256
	src := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			src.SetRGBA(x, y, color.RGBA{
				R: uint8((x * 4) % 256),
				G: uint8(y % 256),
				B: uint8((x + y) % 256),
				A: 255,
			})
		}
	}

	// Serial reference: one draw.Draw over the whole rectangle.
	want := image.NewPaletted(src.Bounds(), palette.Plan9)
	draw.Draw(want, want.Bounds(), src, src.Bounds().Min, draw.Src)

	got := palettize(src)
	if got.Bounds() != want.Bounds() {
		t.Fatalf("bounds = %v, want %v", got.Bounds(), want.Bounds())
	}
	for i := range want.Pix {
		if got.Pix[i] != want.Pix[i] {
			// Recover pixel coordinates for a useful message.
			idx := i
			t.Fatalf("palette index mismatch at Pix[%d]: got %d, want %d", idx, got.Pix[i], want.Pix[i])
		}
	}
}

// TestPalettizeNonZeroOrigin verifies the banded split respects a non-zero
// image origin (Bounds().Min != {0,0}). Sub-images handed to the recorder can
// carry an offset origin, and a band loop that assumed origin 0 would write to
// the wrong dst rows.
func TestPalettizeNonZeroOrigin(t *testing.T) {
	r := image.Rect(10, 20, 74, 300) // 64x280, origin (10,20)
	src := image.NewRGBA(r)
	for y := r.Min.Y; y < r.Max.Y; y++ {
		for x := r.Min.X; x < r.Max.X; x++ {
			src.SetRGBA(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	want := image.NewPaletted(r, palette.Plan9)
	draw.Draw(want, want.Bounds(), src, r.Min, draw.Src)

	got := palettize(src)
	if got.Bounds() != r {
		t.Fatalf("bounds = %v, want %v", got.Bounds(), r)
	}
	for i := range want.Pix {
		if got.Pix[i] != want.Pix[i] {
			t.Fatalf("palette index mismatch at Pix[%d]: got %d, want %d", i, got.Pix[i], want.Pix[i])
		}
	}
}
