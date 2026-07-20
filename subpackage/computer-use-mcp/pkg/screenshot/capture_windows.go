//go:build windows

package screenshot

import (
	"fmt"
	"image"
	"syscall"
	"unsafe"
)

var (
	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procCreateCompatibleDC  = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject        = gdi32.NewProc("SelectObject")
	procBitBlt              = gdi32.NewProc("BitBlt")
	procGetDIBits           = gdi32.NewProc("GetDIBits")
	procDeleteObject        = gdi32.NewProc("DeleteObject")
	procDeleteDC            = gdi32.NewProc("DeleteDC")
)

const (
	SRCCOPY     = 0x00CC0020
	BI_RGB      = 0
	DIB_RGB_COLORS = 0
)

type RECT struct {
	Left, Top, Right, Bottom int32
}

type MONITORINFO struct {
	cbSize    uint32
	rcMonitor RECT
	rcWork    RECT
	dwFlags   uint32
}

type BITMAPINFOHEADER struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

type BITMAPINFO struct {
	bmiHeader BITMAPINFOHEADER
	bmiColors [1]uint32
}

func getDisplays() ([]Display, error) {
	var displays []Display

	callback := syscall.NewCallback(func(hMonitor, hdcMonitor, lprcMonitor, dwData uintptr) uintptr {
		var mi MONITORINFO
		mi.cbSize = uint32(unsafe.Sizeof(mi))

		ret, _, _ := procGetMonitorInfoW.Call(hMonitor, uintptr(unsafe.Pointer(&mi)))
		if ret == 0 {
			return 1 // Continue enumeration
		}

		bounds := image.Rect(
			int(mi.rcMonitor.Left),
			int(mi.rcMonitor.Top),
			int(mi.rcMonitor.Right),
			int(mi.rcMonitor.Bottom),
		)

		displays = append(displays, Display{
			Index:  len(displays),
			Bounds: bounds,
		})

		return 1 // Continue enumeration
	})

	ret, _, _ := procEnumDisplayMonitors.Call(0, 0, callback, 0)
	if ret == 0 {
		return nil, fmt.Errorf("EnumDisplayMonitors failed")
	}

	return displays, nil
}

func captureDisplay(display Display) (*image.RGBA, error) {
	x := display.Bounds.Min.X
	y := display.Bounds.Min.Y
	width := display.Bounds.Dx()
	height := display.Bounds.Dy()

	// Get screen DC
	hDC, _, _ := procGetDC.Call(0)
	if hDC == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, hDC)

	// Create compatible DC
	hMemDC, _, _ := procCreateCompatibleDC.Call(hDC)
	if hMemDC == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(hMemDC)

	// Create compatible bitmap
	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hDC, uintptr(width), uintptr(height))
	if hBitmap == 0 {
		return nil, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(hBitmap)

	// Select bitmap into DC
	procSelectObject.Call(hMemDC, hBitmap)

	// Copy screen to bitmap
	ret, _, _ := procBitBlt.Call(
		hMemDC,
		0, 0,
		uintptr(width), uintptr(height),
		hDC,
		uintptr(x), uintptr(y),
		SRCCOPY,
	)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt failed")
	}

	// Get bitmap bits
	var bi BITMAPINFO
	bi.bmiHeader.biSize = uint32(unsafe.Sizeof(bi.bmiHeader))
	bi.bmiHeader.biWidth = int32(width)
	bi.bmiHeader.biHeight = -int32(height) // Negative for top-down
	bi.bmiHeader.biPlanes = 1
	bi.bmiHeader.biBitCount = 32
	bi.bmiHeader.biCompression = BI_RGB

	bufSize := width * height * 4
	buf := make([]byte, bufSize)

	ret, _, _ = procGetDIBits.Call(
		hDC,
		hBitmap,
		0,
		uintptr(height),
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&bi)),
		DIB_RGB_COLORS,
	)
	if ret == 0 {
		return nil, fmt.Errorf("GetDIBits failed")
	}

	// Convert BGRA to RGBA
	rgba := image.NewRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < len(buf); i += 4 {
		rgba.Pix[i+0] = buf[i+2] // R
		rgba.Pix[i+1] = buf[i+1] // G
		rgba.Pix[i+2] = buf[i+0] // B
		rgba.Pix[i+3] = 255      // A
	}

	return rgba, nil
}
