//go:build linux

package screenshot

import (
	"errors"
	"fmt"
	"image"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	libX11 uintptr

	xOpenDisplay     func(displayName *byte) unsafe.Pointer
	xCloseDisplay    func(display unsafe.Pointer) int
	xDefaultScreen   func(display unsafe.Pointer) int
	xDisplayWidth    func(display unsafe.Pointer, screen int) int
	xDisplayHeight   func(display unsafe.Pointer, screen int) int
	xRootWindow      func(display unsafe.Pointer, screen int) uintptr
	xGetImage        func(display unsafe.Pointer, drawable uintptr, x, y int, width, height uint, planeMask uintptr, format int) unsafe.Pointer
	xDestroyImage    func(ximage unsafe.Pointer) int
	xGetPixel        func(ximage unsafe.Pointer, x, y int) uint32
	xImageByteOrder  func(display unsafe.Pointer) int
	xDefaultDepth    func(display unsafe.Pointer, screen int) int
	xDefaultVisual   func(display unsafe.Pointer, screen int) uintptr
	xDefaultColormap func(display unsafe.Pointer, screen int) uintptr
	xQueryColor      func(display unsafe.Pointer, colormap uintptr, color *xColor) int
	xFree            func(data unsafe.Pointer) int
)

const (
	allPlanes = ^uintptr(0)
	zPixmap   = 2
)

type xImage struct {
	width          int32
	height         int32
	xoffset        int32
	format         int32
	data           unsafe.Pointer
	byteOrder      int32
	bitmapUnit     int32
	bitmapBitOrder int32
	bitmapPad      int32
	depth          int32
	bytesPerLine   int32
	bitsPerPixel   int32
	redMask        uint64
	greenMask      uint64
	blueMask       uint64
}

type xColor struct {
	pixel uint64
	red   uint16
	green uint16
	blue  uint16
	flags byte
	pad   byte
}

func init() {
	var err error
	libX11, err = purego.Dlopen("libX11.so.6", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		// Try without version suffix
		libX11, err = purego.Dlopen("libX11.so", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			return // X11 not available
		}
	}

	purego.RegisterLibFunc(&xOpenDisplay, libX11, "XOpenDisplay")
	purego.RegisterLibFunc(&xCloseDisplay, libX11, "XCloseDisplay")
	purego.RegisterLibFunc(&xDefaultScreen, libX11, "XDefaultScreen")
	purego.RegisterLibFunc(&xDisplayWidth, libX11, "XDisplayWidth")
	purego.RegisterLibFunc(&xDisplayHeight, libX11, "XDisplayHeight")
	purego.RegisterLibFunc(&xRootWindow, libX11, "XRootWindow")
	purego.RegisterLibFunc(&xGetImage, libX11, "XGetImage")
	purego.RegisterLibFunc(&xDestroyImage, libX11, "XDestroyImage")
	purego.RegisterLibFunc(&xGetPixel, libX11, "XGetPixel")
	purego.RegisterLibFunc(&xImageByteOrder, libX11, "XImageByteOrder")
	purego.RegisterLibFunc(&xDefaultDepth, libX11, "XDefaultDepth")
	purego.RegisterLibFunc(&xDefaultVisual, libX11, "XDefaultVisual")
	purego.RegisterLibFunc(&xDefaultColormap, libX11, "XDefaultColormap")
	purego.RegisterLibFunc(&xQueryColor, libX11, "XQueryColor")
	purego.RegisterLibFunc(&xFree, libX11, "XFree")
}

// waylandDisplayCache memoizes the result of the Wayland display probe so a
// single screenshot/recording request — which can call getDisplays() several
// times (via CaptureAndScale → GetDisplays, CaptureDisplay → GetDisplays,
// recorder → GetDisplayBounds, …) — only runs the expensive captureWayland({})
// probe ONCE instead of re-running it (and re-forking grim/gnome-screenshot)
// on every call. The probe's output is just the desktop dimensions, which are
// stable across a request; a short TTL also covers monitor reconfiguration
// mid-session without forcing a process restart.
var (
	waylandDisplayMu    sync.Mutex
	waylandDisplayCache []Display
	waylandDisplayErr   error
	waylandDisplayExp   time.Time
)

// waylandDisplayTTL is how long a cached Wayland probe is considered fresh.
// 5s is long enough to dedup the handful of getDisplays() calls in one
// request yet short enough to pick up a monitor hotplug between requests.
const waylandDisplayTTL = 5 * time.Second

// probeWaylandDisplay returns the synthesized Wayland-only display list,
// memoized for waylandDisplayTTL. The probe itself takes one full screenshot
// just to read its dimensions — exactly the cost we want to avoid repeating.
func probeWaylandDisplay() ([]Display, error) {
	waylandDisplayMu.Lock()
	defer waylandDisplayMu.Unlock()
	if waylandDisplayCache != nil && time.Since(waylandDisplayExp) < waylandDisplayTTL {
		return waylandDisplayCache, waylandDisplayErr
	}

	img, err := captureWayland(image.Rectangle{})
	if err != nil {
		// Cache the failure too so a broken probe doesn't get retried on every
		// frame of a recording; surface it to the caller.
		waylandDisplayCache = nil
		waylandDisplayErr = fmt.Errorf("wayland display probe failed: %w", err)
		waylandDisplayExp = time.Now()
		return nil, waylandDisplayErr
	}
	waylandDisplayCache = []Display{{
		Index:  0,
		Bounds: image.Rect(0, 0, img.Bounds().Dx(), img.Bounds().Dy()),
	}}
	waylandDisplayErr = nil
	waylandDisplayExp = time.Now()
	return waylandDisplayCache, nil
}

// getDisplays enumerates monitors. Under a Wayland session, Xwayland (if
// present) still reports accurate screen geometry via the X11 calls below, so
// we reuse that path for enumeration even though pixel capture must go through
// a Wayland-native tool. When no X server is reachable at all but a Wayland
// capture helper exists, we synthesize a single full-desktop display by probing
// its dimensions — enough for the common single-monitor case. The probe result
// is memoized (probeWaylandDisplay) so one request never forks the Wayland
// capture tool more than once for enumeration.
func getDisplays() ([]Display, error) {
	if displays, err := getDisplaysX11(); err == nil && len(displays) > 0 {
		return displays, nil
	}

	// No usable X11 enumeration. If we're on Wayland WITH a capture tool, probe
	// the full-desktop size (cached). Distinguish this from the headless /
	// no-tool case in the error message so users can diagnose which piece is
	// missing (no X server vs. Wayland without grim/gnome-screenshot).
	if waylandActive() {
		if waylandCaptureAvailable() {
			return probeWaylandDisplay()
		}
		return nil, fmt.Errorf("no display server available: not running under X11 and Wayland session has no screenshot helper (install grim or gnome-screenshot)")
	}

	return nil, fmt.Errorf("X11 not available")
}

func getDisplaysX11() ([]Display, error) {
	if libX11 == 0 {
		return nil, fmt.Errorf("X11 not available")
	}

	display := xOpenDisplay(nil)
	if display == nil {
		return nil, fmt.Errorf("cannot open X display")
	}
	defer xCloseDisplay(display)

	screen := xDefaultScreen(display)
	width := xDisplayWidth(display, screen)
	height := xDisplayHeight(display, screen)

	if width == 0 || height == 0 {
		return nil, nil
	}

	return []Display{
		{
			Index:  0,
			Bounds: image.Rect(0, 0, width, height),
		},
	}, nil
}

// captureDisplay grabs pixels for one monitor. On a Wayland session, XGetImage
// returns black frames for native Wayland windows, so we route through a
// Wayland-native helper (grim/gnome-screenshot) first and only fall back to the
// X11/Xwayland path when no such helper is installed. On a pure X11 session the
// Wayland gate is skipped entirely.
func captureDisplay(display Display) (*image.RGBA, error) {
	if waylandActive() {
		img, err := captureWayland(display.Bounds)
		if err == nil {
			return img, nil
		}
		// Only fall through to X11/Xwayland when the failure is "no tool
		// installed" and an X server is actually reachable; otherwise surface
		// the real capture error.
		if !errors.Is(err, errNoWaylandCaptureTool) || !x11Available() {
			return nil, err
		}
	}
	return captureDisplayX11(display)
}

func captureDisplayX11(display Display) (*image.RGBA, error) {
	if libX11 == 0 {
		return nil, fmt.Errorf("X11 not available")
	}

	dpy := xOpenDisplay(nil)
	if dpy == nil {
		return nil, fmt.Errorf("cannot open X display")
	}
	defer xCloseDisplay(dpy)

	screen := xDefaultScreen(dpy)
	root := xRootWindow(dpy, screen)

	x := display.Bounds.Min.X
	y := display.Bounds.Min.Y
	width := uint(display.Bounds.Dx())
	height := uint(display.Bounds.Dy())

	// Capture the screen using XGetImage
	ximagePtr := xGetImage(dpy, root, x, y, width, height, allPlanes, zPixmap)
	if ximagePtr == nil {
		return nil, fmt.Errorf("XGetImage failed")
	}
	defer xDestroyImage(ximagePtr)

	// Cast to xImage struct - now safe with unsafe.Pointer
	ximg := (*xImage)(ximagePtr)
	w := int(ximg.width)
	h := int(ximg.height)
	rgba := image.NewRGBA(image.Rect(0, 0, w, h))

	// X11 typically uses 32-bit BGRA format
	bytesPerPixel := int(ximg.bitsPerPixel / 8)
	if bytesPerPixel == 0 {
		bytesPerPixel = 4 // fallback
	}
	// Direct access to data - now safe with unsafe.Pointer
	data := unsafe.Slice((*byte)(ximg.data), h*int(ximg.bytesPerLine))

	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			srcIdx := py*int(ximg.bytesPerLine) + px*bytesPerPixel
			dstIdx := py*rgba.Stride + px*4

			// BGRA -> RGBA (typical X11 format)
			if srcIdx+3 < len(data) {
				rgba.Pix[dstIdx+0] = data[srcIdx+2] // R
				rgba.Pix[dstIdx+1] = data[srcIdx+1] // G
				rgba.Pix[dstIdx+2] = data[srcIdx+0] // B
				rgba.Pix[dstIdx+3] = 255            // A (X11 doesn't provide alpha)
			}
		}
	}

	return rgba, nil
}
