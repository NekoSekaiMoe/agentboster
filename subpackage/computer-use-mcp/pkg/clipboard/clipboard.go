// Package clipboard provides cross-platform clipboard read/write access for
// the computer-use MCP server.
//
// It is a thin adapter over golang.design/x/clipboard (v0.8+), which itself
// speaks the native Wayland wire protocol, the X11 wire protocol, macOS
// Pasteboard, and Win32 user32 — all CGo-free on desktop. This wrapper exposes
// only what the MCP tools need (text + PNG image) plus a one-time Init and
// surfaces errors instead of panicking.
package clipboard

import (
	"fmt"
	"sync"

	xclip "golang.design/x/clipboard"
)

const (
	// MIMEText is the MIME type for UTF-8 plain text.
	MIMEText = "text/plain; charset=utf-8"
	// MIMEImage is the MIME type the clipboard uses for images (always PNG).
	MIMEImage = "image/png"
)

var (
	once    sync.Once
	initErr error
)

// Init initializes the platform clipboard backend. It must be called once
// before any Read/Write. Repeated calls are no-ops and return the first
// error (or nil). On a headless box with no display server, or on a platform
// the upstream library does not support, Init returns a non-nil error and the
// MCP tool reports it verbatim instead of panicking.
func Init() error {
	once.Do(func() {
		initErr = xclip.Init()
	})
	return initErr
}

// ReadText reads the clipboard as UTF-8 text. Returns "" with a nil error if
// the clipboard holds no text (callers should treat empty+nil as "empty
// clipboard"). Returns a non-nil error only if the clipboard backend itself
// is unavailable.
func ReadText() (string, error) {
	if err := Init(); err != nil {
		return "", fmt.Errorf("clipboard unavailable: %w", err)
	}
	if b := xclip.Read(xclip.FmtText); b != nil {
		return string(b), nil
	}
	return "", nil
}

// WriteText writes UTF-8 text to the clipboard. The data is on the clipboard
// as soon as WriteText returns.
func WriteText(s string) error {
	if err := Init(); err != nil {
		return fmt.Errorf("clipboard unavailable: %w", err)
	}
	xclip.Write(xclip.FmtText, []byte(s))
	return nil
}

// ReadImage reads the clipboard as a PNG-encoded image. Returns nil if the
// clipboard holds no image. The upstream library normalizes every native
// image type to PNG, so callers can always decode the result as PNG.
func ReadImage() ([]byte, error) {
	if err := Init(); err != nil {
		return nil, fmt.Errorf("clipboard unavailable: %w", err)
	}
	return xclip.Read(xclip.FmtImage), nil
}

// WriteImage writes a PNG-encoded image to the clipboard. PNG bytes are
// stored verbatim; the upstream library also accepts JPEG/GIF/WebP input and
// re-encodes it to PNG, provided the importing program has blank-imported
// the matching image decoder (this server does, for JPEG).
func WriteImage(png []byte) error {
	if err := Init(); err != nil {
		return fmt.Errorf("clipboard unavailable: %w", err)
	}
	xclip.Write(xclip.FmtImage, png)
	return nil
}
