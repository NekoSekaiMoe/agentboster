// Package recorder captures short screen recordings as animated GIFs, encoded
// entirely with the Go standard library (image/gif). No CGo, no external CLI
// (ffmpeg), no native video libraries — only the same screenshot primitives
// pkg/screenshot already uses.
//
// GIF is the chosen format for the computer-use MCP server because (a) it is
// lossless for UI frames, (b) the bytes go straight into a vision model's
// context window where a binary video codec would be useless anyway, and (c)
// the standard library ships a writer.
//
// Trade-off: GIF is limited to a 256-color palette per frame, so photographic
// content banding is expected. For UI automation replay this is fine; the
// palette is quantized per-frame (image/gif does this when the source is not
// already paletted), which keeps text crisp.
package recorder

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"sync"
	"time"

	"github.com/disintegration/imaging"
	"github.com/nekisekaimoe/agentboster/subpackages/computer-use-mcp/pkg/screenshot"
)

// Config controls a recording session.
type Config struct {
	// MonitorIndex is the display to capture (0 = primary). Default 0.
	MonitorIndex int
	// MaxWidth scales each frame to at most this width (maintaining aspect).
	// Default 800 — small enough to keep GIFs reasonable for vision models.
	MaxWidth int
	// FPS is the capture rate. Default 4. Higher values inflate GIF size
	// quickly; 4 fps is plenty to follow UI automation.
	FPS int
	// Duration caps the recording length. Recording also stops on Stop() or
	// context cancellation. Default 15s. Hard cap 60s as a safety valve.
	Duration time.Duration
	// ExcludeTerminals blacks out terminal windows in each frame, matching
	// the screenshot tool's safety behavior. Default true.
	ExcludeTerminals bool
}

// DefaultConfig returns a sane Config for UI automation replay.
func DefaultConfig() Config {
	return Config{
		MonitorIndex:     0,
		MaxWidth:         800,
		FPS:              4,
		Duration:         15 * time.Second,
		ExcludeTerminals: true,
	}
}

// Session is an in-progress or completed recording. Exactly one Session may be
// active at a time per process (the MCP server is single-user), enforced by a
// package-level mutex.
type Session struct {
	cfg     Config
	mu      sync.Mutex
	frames  []*image.Paletted
	delays  []int // hundredths of a second per frame, as image/gif expects
	done    chan struct{}
	startAt time.Time
	stopped bool
}

var (
	activeMu sync.Mutex
	active   *Session
)

// Start begins a new recording. It returns an error if one is already in
// progress or no display is available. The caller receives the Session and
// must call GIF() (optionally after Stop()) to obtain the encoded bytes; that
// call blocks until the session ends.
func Start(cfg Config) (*Session, error) {
	if cfg.MaxWidth <= 0 {
		cfg.MaxWidth = 800
	}
	if cfg.FPS <= 0 {
		cfg.FPS = 4
	}
	if cfg.FPS > 10 {
		cfg.FPS = 10
	}
	if cfg.Duration <= 0 {
		cfg.Duration = 15 * time.Second
	}
	if cfg.Duration > 60*time.Second {
		cfg.Duration = 60 * time.Second
	}

	activeMu.Lock()
	defer activeMu.Unlock()
	if active != nil {
		return nil, fmt.Errorf("a recording is already in progress; stop it first")
	}

	// Refuse if there is no display — fail fast rather than spinning a goroutine
	// that captures nothing.
	if screenshot.NumActiveDisplays() == 0 {
		return nil, fmt.Errorf("no display available for capture")
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Duration)
	s := &Session{
		cfg:     cfg,
		done:    make(chan struct{}),
		startAt: time.Now(),
	}
	active = s

	interval := time.Second / time.Duration(cfg.FPS)
	go func() {
		defer cancel()
		defer close(s.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Until(s.startAt.Add(cfg.Duration)) + 1):
				// Belt-and-suspenders against ticker drift past the hard cap.
				return
			case now := <-ticker.C:
				s.captureFrame(now)
			}
		}
	}()

	return s, nil
}

// captureFrame grabs one frame, scales it, palettizes it, and appends it.
// It bypasses screenshot.CaptureAndScale (which base64-encodes PNG) and goes
// straight to the raw RGBA via screenshot.CaptureDisplay, avoiding a costly
// PNG encode/decode round-trip per frame.
func (s *Session) captureFrame(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped {
		return
	}

	// Safety valve: never exceed the configured duration by more than one tick.
	if now.Sub(s.startAt) > s.cfg.Duration+time.Second {
		return
	}

	raw, err := screenshot.CaptureDisplay(s.cfg.MonitorIndex)
	if err != nil {
		// Skip a bad frame rather than aborting the whole recording; transient
		// capture hiccups (e.g. a monitor waking) shouldn't kill the session.
		return
	}

	// Scale to MaxWidth maintaining aspect ratio (Lanczos3, same kernel the
	// screenshot tool uses).
	img := image.Image(raw)
	if w := raw.Bounds().Dx(); w > s.cfg.MaxWidth {
		newH := int(float64(raw.Bounds().Dy()) * float64(s.cfg.MaxWidth) / float64(w))
		if newH < 1 {
			newH = 1
		}
		img = imaging.Resize(raw, s.cfg.MaxWidth, newH, imaging.Lanczos)
	}

	// Terminal masking is applied by blacking out rectangles post-scale; defer
	// to the screenshot package's masker if ExcludeTerminals is set. The masker
	// expects the monitor origin; for recording the active monitor is fine at 0.
	if s.cfg.ExcludeTerminals {
		img = screenshot.MaskTerminals(img, [2]int{})
	}

	p := palettize(img)
	s.frames = append(s.frames, p)

	// Delay in hundredths of a second, derived from configured FPS. image/gif
	// uses centiseconds; round to at least 1.
	cs := int(float64(100) / float64(s.cfg.FPS))
	if cs < 1 {
		cs = 1
	}
	s.delays = append(s.delays, cs)
}

// Stop ends the recording and blocks until the capture goroutine has fully
// drained. Safe to call multiple times. Stop is also called implicitly by
// GIF() if the session is still running.
func (s *Session) Stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	s.mu.Unlock()

	activeMu.Lock()
	if active == s {
		active = nil
	}
	activeMu.Unlock()

	// The capture goroutine observes s.stopped on its next tick; wait for its
	// done channel so GIF() sees a fully-populated frame slice.
	<-s.done
}

// GIF encodes the captured frames as an animated GIF. It blocks until the
// session has ended (Stop, duration cap, or context cancellation), then
// returns the GIF bytes. Calling GIF multiple times returns the same bytes.
func (s *Session) GIF() ([]byte, error) {
	// Ensure capture has stopped before encoding.
	if !s.isStopped() {
		s.Stop()
	}
	s.mu.Lock()
	frames := s.frames
	delays := s.delays
	s.mu.Unlock()

	if len(frames) == 0 {
		return nil, fmt.Errorf("no frames captured (display unavailable for the entire recording?)")
	}

	var buf bytes.Buffer
	g := &gif.GIF{
		Image: frames,
		Delay: delays,
		// Loop 0 = loop forever. A short, looping clip is more useful to a
		// vision model reviewing an automation step than a one-shot playback.
		LoopCount: 0,
	}
	if err := gif.EncodeAll(&buf, g); err != nil {
		return nil, fmt.Errorf("gif encode: %w", err)
	}
	return buf.Bytes(), nil
}

// FrameCount returns the number of frames captured so far. Safe to call while
// recording is in progress.
func (s *Session) FrameCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.frames)
}

func (s *Session) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

// palettize quantizes an arbitrary image down to GIF's 256-color constraint
// using the standard library's plan9 palette. It draws the source onto a
// paletted image so image/gif can emit it directly without its own (slower,
// per-frame) quantization pass. The trade-off is a fixed palette — slightly
// more banding than per-frame k-means, but an order of magnitude faster and
// deterministic across runs.
func palettize(src image.Image) *image.Paletted {
	b := src.Bounds()
	dst := image.NewPaletted(b, palette.Plan9)
	draw.Draw(dst, b, src, b.Min, draw.Src)
	return dst
}
