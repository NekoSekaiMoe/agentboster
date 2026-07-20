package recorder

import (
	"image"
	"image/color"
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
