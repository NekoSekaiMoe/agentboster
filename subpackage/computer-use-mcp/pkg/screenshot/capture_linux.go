//go:build linux

//nolint:govet
package screenshot

import (
	"fmt"
	"image"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	libX11 uintptr

	xOpenDisplay      func(displayName *byte) uintptr
	xCloseDisplay     func(display uintptr) int
	xDefaultScreen    func(display uintptr) int
	xDisplayWidth     func(display uintptr, screen int) int
	xDisplayHeight    func(display uintptr, screen int) int
	xRootWindow       func(display uintptr, screen int) uintptr
	xGetImage         func(display uintptr, drawable uintptr, x, y int, width, height uint, planeMask uintptr, format int) uintptr
	xDestroyImage     func(ximage uintptr) int
	xGetPixel         func(ximage uintptr, x, y int) uint32
	xImageByteOrder   func(display uintptr) int
	xDefaultDepth     func(display uintptr, screen int) int
	xDefaultVisual    func(display uintptr, screen int) uintptr
	xDefaultColormap  func(display uintptr, screen int) uintptr
	xQueryColor       func(display uintptr, colormap uintptr, color *xColor) int
	xFree             func(data uintptr) int
)

const (
	allPlanes = ^uintptr(0)
	zPixmap   = 2
)

type xImage struct {
	width         int32
	height        int32
	xoffset       int32
	format        int32
	data          uintptr
	byteOrder     int32
	bitmapUnit    int32
	bitmapBitOrder int32
	bitmapPad     int32
	depth         int32
	bytesPerLine  int32
	bitsPerPixel  int32
	redMask       uint64
	greenMask     uint64
	blueMask      uint64
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

func getDisplays() ([]Display, error) {
	if libX11 == 0 {
		return nil, fmt.Errorf("X11 not available")
	}

	display := xOpenDisplay(nil)
	if display == 0 {
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

func captureDisplay(display Display) (*image.RGBA, error) {
	if libX11 == 0 {
		return nil, fmt.Errorf("X11 not available")
	}

	dpy := xOpenDisplay(nil)
	if dpy == 0 {
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
	if ximagePtr == 0 {
		return nil, fmt.Errorf("XGetImage failed")
	}
	defer xDestroyImage(ximagePtr)

	// Cast to xImage struct
	// Safe: ximagePtr is kept alive through defer xDestroyImage(ximagePtr)
	//lint:ignore SA4006 ximagePtr kept alive through defer
	ximg := (*xImage)(unsafe.Pointer(ximagePtr))
	w := int(ximg.width)
	h := int(ximg.height)
	rgba := image.NewRGBA(image.Rect(0, 0, w, h))

	// X11 typically uses 32-bit BGRA format
	bytesPerPixel := int(ximg.bitsPerPixel / 8)
	if bytesPerPixel == 0 {
		bytesPerPixel = 4 // fallback
	}
	// Safe: ximg.data is kept alive through ximg which is kept alive through ximagePtr
	//lint:ignore SA4006 ximg.data kept alive through ximagePtr defer
	data := unsafe.Slice((*byte)(unsafe.Pointer(ximg.data)), h*int(ximg.bytesPerLine))

	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			srcIdx := py*int(ximg.bytesPerLine) + px*bytesPerPixel
			dstIdx := py*rgba.Stride + px*4

			// BGRA -> RGBA (typical X11 format)
			if srcIdx+3 < len(data) {
				rgba.Pix[dstIdx+0] = data[srcIdx+2] // R
				rgba.Pix[dstIdx+1] = data[srcIdx+1] // G
				rgba.Pix[dstIdx+2] = data[srcIdx+0] // B
				rgba.Pix[dstIdx+3] = 255             // A (X11 doesn't provide alpha)
			}
		}
	}

	return rgba, nil
}
