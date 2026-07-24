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
	"hash/crc32"
	"image"
	"image/color/palette"
	"image/draw"
	"image/gif"
	"runtime"
	"sync"
	"time"

	"github.com/boxes-ltd/imaging"
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

// Capture function hooks. Defaulting to the screenshot package's real
// functions keeps production behavior unchanged; tests override them to feed
// in-memory frames so captureFrame's change-detection / delay aggregation can
// be exercised headlessly (no display server required).
var (
	captureFrameFn = func(monitorIndex int) (*image.RGBA, error) {
		return screenshot.CaptureDisplay(monitorIndex)
	}
	captureBoundsFn = func(monitorIndex int) image.Rectangle {
		return screenshot.GetDisplayBounds(monitorIndex)
	}
)

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
	cancel  context.CancelFunc // stops the capture goroutine on Stop

	// lastHash is the CRC32 of the previous captured RGBA frame's raw pixel
	// buffer (raw.Pix) as returned by screenshot.CaptureDisplay — i.e. BEFORE
	// scale, terminal-masking, and palettize. When a newly captured frame's
	// raw.Pix hashes identically we skip the expensive scale/mask/palettize
	// pipeline entirely and instead extend the previous encoded frame's on-screen
	// delay — a static screen collapses to a single encoded frame. hasFrame gates
	// the first-frame case. See captureFrame for the exact ordering.
	lastHash uint32
	hasFrame bool
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
	if cfg.MonitorIndex < 0 || cfg.MonitorIndex >= screenshot.NumActiveDisplays() {
		return nil, fmt.Errorf("monitor_index %d out of range (available: 0..%d)", cfg.MonitorIndex, screenshot.NumActiveDisplays()-1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Duration)
	s := &Session{
		cfg:     cfg,
		done:    make(chan struct{}),
		startAt: time.Now(),
		cancel:  cancel,
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
				// Either the Duration elapsed (timeout) or Stop() called cancel.
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

	raw, err := captureFrameFn(s.cfg.MonitorIndex)
	if err != nil {
		// Skip a bad frame rather than aborting the whole recording; transient
		// capture hiccups (e.g. a monitor waking) shouldn't kill the session.
		return
	}

	// Per-frame centisecond delay, derived from configured FPS. image/gif uses
	// centiseconds; round to at least 1.
	cs := int(float64(100) / float64(s.cfg.FPS))
	if cs < 1 {
		cs = 1
	}

	// Change detection: hash the raw captured pixels. If this frame is
	// byte-identical to the previous one, skip the expensive scale/mask/
	// palettize pipeline and just extend the previous encoded frame's delay.
	// A fully static screen collapses to a single palettized frame regardless
	// of duration, which is where the bulk of the CPU (and GIF size) savings
	// come from. crc32 over the pixel buffer is far cheaper than Lanczos +
	// palette mapping, so the hash is worth it even when frames do change.
	hash := crc32.ChecksumIEEE(raw.Pix)
	if s.hasFrame && hash == s.lastHash && len(s.delays) > 0 {
		s.delays[len(s.delays)-1] += cs
		return
	}
	s.lastHash = hash
	s.hasFrame = true

	// Display origin is needed for correct terminal-window coordinate
	// alignment on non-primary monitors: the macOS/Windows maskers subtract
	// monitorOrigin from absolute window bounds. Use the configured monitor's
	// Bounds.Min rather than [2]int{} (which only works for the primary).
	origin := [2]int{}
	if db := captureBoundsFn(s.cfg.MonitorIndex); !db.Empty() {
		origin = [2]int{db.Min.X, db.Min.Y}
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
	// expects the monitor origin so window coordinates align on multi-monitor
	// setups (see origin resolution above).
	if s.cfg.ExcludeTerminals {
		img = screenshot.MaskTerminals(img, origin)
	}

	p := palettize(img)
	s.frames = append(s.frames, p)
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
	cancel := s.cancel
	s.mu.Unlock()

	// Cancel the capture context so the goroutine unblocks immediately on
	// ctx.Done() rather than waiting up to one tick (250ms at the default 4
	// fps) before noticing s.stopped.
	if cancel != nil {
		cancel()
	}

	activeMu.Lock()
	if active == s {
		active = nil
	}
	activeMu.Unlock()

	// Wait for the goroutine to finish so GIF() sees a fully-populated frame
	// slice.
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
//
// The palette mapping (nearest-color search per pixel via draw.Draw into a
// Paletted dst) is the single most expensive step per frame, and it is
// embarrassingly parallel: each output pixel is independent. We split the
// image into GOMAXPROCS horizontal bands and draw each concurrently. The bands
// are disjoint row ranges writing to distinct byte offsets of the same
// dst.Pix, so no locking is needed. For small images (or GOMAXPROCS==1) this
// degrades to the original single draw.Draw call.
func palettize(src image.Image) *image.Paletted {
	b := src.Bounds()
	dst := image.NewPaletted(b, palette.Plan9)

	workers := runtime.GOMAXPROCS(0)
	h := b.Dy()
	// Only bother splitting when there is enough work to amortize goroutine
	// setup; one row per worker minimum, and skip parallelism for tiny frames.
	if workers <= 1 || h < workers*8 {
		draw.Draw(dst, b, src, b.Min, draw.Src)
		return dst
	}

	rowsPerBand := (h + workers - 1) / workers
	var wg sync.WaitGroup
	for start := b.Min.Y; start < b.Max.Y; start += rowsPerBand {
		end := start + rowsPerBand
		if end > b.Max.Y {
			end = b.Max.Y
		}
		band := image.Rect(b.Min.X, start, b.Max.X, end)
		wg.Add(1)
		go func(r image.Rectangle) {
			defer wg.Done()
			// draw.Draw copies from src[r] into the matching region of dst,
			// performing the palette lookup. Disjoint r across goroutines means
			// disjoint dst.Pix writes.
			draw.Draw(dst, r, src, r.Min, draw.Src)
		}(band)
	}
	wg.Wait()
	return dst
}
