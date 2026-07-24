//go:build linux

package screenshot

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"os"
	"os/exec"
	"strconv"
)

// errNoWaylandCaptureTool signals that a Wayland session is active but none of
// the supported capture helpers (grim, gnome-screenshot) are installed. The
// caller uses errors.Is against it to decide whether to fall through to the
// X11/Xwayland path (which can at least read Xwayland-backed windows) rather
// than surfacing a hard failure.
var errNoWaylandCaptureTool = errors.New("no wayland screenshot tool available")

// waylandActive reports whether the process is running inside a Wayland session.
// Pure X11 sessions (or headless) leave WAYLAND_DISPLAY unset, so this is the
// gate for preferring the Wayland capture path over XGetImage — which returns
// black frames for native Wayland windows.
func waylandActive() bool {
	return os.Getenv("WAYLAND_DISPLAY") != ""
}

// x11Available reports whether an X (or Xwayland) server is reachable. Used to
// decide whether falling through to the X11 capture path is even possible when
// no Wayland-native tool is installed.
func x11Available() bool {
	if libX11 == 0 {
		return false
	}
	d := xOpenDisplay(nil)
	if d == nil {
		return false
	}
	xCloseDisplay(d)
	return true
}

// waylandCaptureAvailable reports whether at least one supported Wayland capture
// helper is on PATH. getDisplays uses this to decide whether it can synthesize a
// single full-desktop display when X11 enumeration is unavailable.
func waylandCaptureAvailable() bool {
	return hasCmd("grim") || hasCmd("gnome-screenshot")
}

func hasCmd(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// captureWayland grabs pixels through a Wayland-native helper. It prefers grim
// (wlr-screencopy protocol — sway/Hyprland/wlroots), then gnome-screenshot
// (GNOME's Mutter portal). bounds, when non-empty, restricts the capture to a
// single monitor's layout rectangle; an empty rectangle means "the whole
// compositor output" (used when output enumeration was unavailable).
//
// It returns errNoWaylandCaptureTool when neither helper is installed so the
// caller can fall through to X11/Xwayland instead of hard-failing. When grim
// is installed but FAILS at runtime (typical on GNOME/Mutter, which doesn't
// implement the wlr-screencopy protocol grim needs), we transparently retry
// with gnome-screenshot if it is available, rather than surfacing a grim error
// to a user whose system actually can capture.
func captureWayland(bounds image.Rectangle) (*image.RGBA, error) {
	if hasCmd("grim") {
		img, err := captureGrim(bounds)
		if err == nil {
			return img, nil
		}
		// grim is present but failed (e.g. compositor lacks wlr-screencopy). If
		// gnome-screenshot is available, try it before giving up; only surface
		// the grim error when no fallback exists.
		if hasCmd("gnome-screenshot") {
			if img, gErr := captureGnome(bounds); gErr == nil {
				return img, nil
			} else {
				// Both tools present, both failed — combine the errors so the
				// caller/user can diagnose which stage broke.
				return nil, fmt.Errorf("grim failed: %v; gnome-screenshot also failed: %w", err, gErr)
			}
		}
		return nil, err
	}
	if hasCmd("gnome-screenshot") {
		return captureGnome(bounds)
	}
	return nil, errNoWaylandCaptureTool
}

// captureGrim runs grim, asking for raw PPM on stdout. PPM (P6) is uncompressed,
// so decoding is a header parse plus a single copy — cheaper than PNG for the
// per-screenshot hot path, and it avoids pulling grim's PNG encoder through zlib.
func captureGrim(bounds image.Rectangle) (*image.RGBA, error) {
	args := []string{"-t", "ppm"}
	if !bounds.Empty() {
		// grim geometry is "x,y WxH" in layout coordinates.
		args = append(args, "-g",
			fmt.Sprintf("%d,%d %dx%d", bounds.Min.X, bounds.Min.Y, bounds.Dx(), bounds.Dy()))
	}
	args = append(args, "-") // write image to stdout

	var stdout, stderr bytes.Buffer
	cmd := exec.Command("grim", args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("grim failed: %w: %s", err, stderr.String())
	}
	return decodePPM(stdout.Bytes())
}

// captureGnome shells out to gnome-screenshot, which can only write a full-desktop
// PNG to a file, then crops to the requested monitor rectangle. This is the GNOME
// (Mutter) Wayland path where grim's wlr-screencopy protocol is unavailable.
func captureGnome(bounds image.Rectangle) (*image.RGBA, error) {
	tmp, err := os.CreateTemp("", "cu-shot-*.png")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpPath)

	var stderr bytes.Buffer
	cmd := exec.Command("gnome-screenshot", "-f", tmpPath)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("gnome-screenshot failed: %w: %s", err, stderr.String())
	}

	f, err := os.Open(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("open screenshot: %w", err)
	}
	defer f.Close()

	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode screenshot: %w", err)
	}

	full := toRGBA(img)
	if bounds.Empty() {
		return full, nil
	}
	return cropRGBA(full, bounds), nil
}

// decodePPM parses a binary PPM (P6, maxval < 256) into an RGBA image. The header
// is "P6", width, height, maxval — whitespace-separated, with '#' comments legal
// between tokens — followed by exactly one whitespace byte and then raw RGB
// triples. grim emits maxval 255; anything else (16-bit samples) is rejected
// since we only handle 8-bit channels.
func decodePPM(data []byte) (*image.RGBA, error) {
	r := bufio.NewReader(bytes.NewReader(data))

	magic, err := readPPMToken(r)
	if err != nil {
		return nil, fmt.Errorf("read ppm magic: %w", err)
	}
	if magic != "P6" {
		return nil, fmt.Errorf("unsupported ppm magic %q (want P6)", magic)
	}

	w, err := readPPMInt(r)
	if err != nil {
		return nil, fmt.Errorf("read ppm width: %w", err)
	}
	h, err := readPPMInt(r)
	if err != nil {
		return nil, fmt.Errorf("read ppm height: %w", err)
	}
	maxv, err := readPPMInt(r)
	if err != nil {
		return nil, fmt.Errorf("read ppm maxval: %w", err)
	}
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("invalid ppm dimensions %dx%d", w, h)
	}
	if maxv != 255 {
		return nil, fmt.Errorf("unsupported ppm maxval %d (want 255)", maxv)
	}

	pix := make([]byte, w*h*3)
	if _, err := io.ReadFull(r, pix); err != nil {
		return nil, fmt.Errorf("read ppm pixels: %w", err)
	}

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		srcRow := y * w * 3
		dstRow := y * img.Stride
		for x := 0; x < w; x++ {
			s := srcRow + x*3
			d := dstRow + x*4
			img.Pix[d+0] = pix[s+0] // R
			img.Pix[d+1] = pix[s+1] // G
			img.Pix[d+2] = pix[s+2] // B
			img.Pix[d+3] = 255      // A
		}
	}
	return img, nil
}

// readPPMToken returns the next whitespace-delimited token, skipping leading
// whitespace and '#'-to-end-of-line comments. It consumes the single whitespace
// byte that terminates the token, so after the maxval token the reader sits
// exactly at the first pixel byte.
func readPPMToken(r *bufio.Reader) (string, error) {
	// Skip leading whitespace and comments.
	for {
		b, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		if b == '#' {
			// Comment: discard to end of line.
			for {
				c, err := r.ReadByte()
				if err != nil {
					return "", err
				}
				if c == '\n' {
					break
				}
			}
			continue
		}
		if !isPPMSpace(b) {
			if err := r.UnreadByte(); err != nil {
				return "", err
			}
			break
		}
	}

	var tok []byte
	for {
		b, err := r.ReadByte()
		if err != nil {
			if err == io.EOF && len(tok) > 0 {
				return string(tok), nil
			}
			return "", err
		}
		if isPPMSpace(b) {
			// Terminating whitespace consumed; token complete.
			return string(tok), nil
		}
		tok = append(tok, b)
	}
}

func readPPMInt(r *bufio.Reader) (int, error) {
	tok, err := readPPMToken(r)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(tok)
}

func isPPMSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}

// toRGBA returns img as an *image.RGBA, copying only when it isn't already one.
func toRGBA(img image.Image) *image.RGBA {
	if rgba, ok := img.(*image.RGBA); ok {
		return rgba
	}
	b := img.Bounds()
	out := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			out.Set(x-b.Min.X, y-b.Min.Y, img.At(x, y))
		}
	}
	return out
}

// cropRGBA returns the sub-rectangle of src intersected with bounds, re-based to
// origin (0,0). Out-of-range rectangles are clamped; a fully disjoint rectangle
// yields src unchanged (defensive — callers pass monitor bounds that overlap).
func cropRGBA(src *image.RGBA, bounds image.Rectangle) *image.RGBA {
	r := bounds.Intersect(src.Bounds())
	if r.Empty() {
		return src
	}
	out := image.NewRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		for x := 0; x < r.Dx(); x++ {
			out.Set(x, y, src.At(r.Min.X+x, r.Min.Y+y))
		}
	}
	return out
}
