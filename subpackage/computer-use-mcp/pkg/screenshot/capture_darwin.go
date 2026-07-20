//go:build darwin

package screenshot

import (
	"fmt"
	"image"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	cgMainDisplayID          func() uint32
	cgGetActiveDisplayList   func(maxDisplays uint32, activeDisplays *uint32, displayCount *uint32) int32
	cgDisplayBounds          func(display uint32) cgRect
	cgDisplayPixelsWide      func(display uint32) uint64
	cgDisplayPixelsHigh      func(display uint32) uint64
	cgWindowListCreateImage  func(screenBounds cgRect, listOption uint32, windowID uint32, imageOption uint32) uintptr
	cgImageGetWidth          func(image uintptr) uint64
	cgImageGetHeight         func(image uintptr) uint64
	cgImageGetBytesPerRow    func(image uintptr) uint64
	cgImageGetDataProvider   func(image uintptr) uintptr
	cgDataProviderCopyData   func(provider uintptr) uintptr
	cfDataGetLength          func(theData uintptr) int64
	cfDataGetBytePtr         func(theData uintptr) uintptr
)

const (
	kCGWindowImageDefault           uint32 = 0
	kCGWindowListOptionOnScreenOnly uint32 = 0x01
	kCGErrorSuccess                 int32  = 0
)

func init() {
	defer func() { _ = recover() }()

	cg, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}

	cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return
	}

	purego.RegisterLibFunc(&cgMainDisplayID, cg, "CGMainDisplayID")
	purego.RegisterLibFunc(&cgGetActiveDisplayList, cg, "CGGetActiveDisplayList")
	purego.RegisterLibFunc(&cgDisplayBounds, cg, "CGDisplayBounds")
	purego.RegisterLibFunc(&cgDisplayPixelsWide, cg, "CGDisplayPixelsWide")
	purego.RegisterLibFunc(&cgDisplayPixelsHigh, cg, "CGDisplayPixelsHigh")
	purego.RegisterLibFunc(&cgWindowListCreateImage, cg, "CGWindowListCreateImage")
	purego.RegisterLibFunc(&cgImageGetWidth, cg, "CGImageGetWidth")
	purego.RegisterLibFunc(&cgImageGetHeight, cg, "CGImageGetHeight")
	purego.RegisterLibFunc(&cgImageGetBytesPerRow, cg, "CGImageGetBytesPerRow")
	purego.RegisterLibFunc(&cgImageGetDataProvider, cg, "CGImageGetDataProvider")
	purego.RegisterLibFunc(&cgDataProviderCopyData, cg, "CGDataProviderCopyData")
	purego.RegisterLibFunc(&cfDataGetLength, cf, "CFDataGetLength")
	purego.RegisterLibFunc(&cfDataGetBytePtr, cf, "CFDataGetBytePtr")
}

func getDisplays() ([]Display, error) {
	if cgGetActiveDisplayList == nil || cgDisplayBounds == nil {
		return nil, fmt.Errorf("CoreGraphics API not available")
	}

	var displayCount uint32
	var displays [32]uint32

	result := cgGetActiveDisplayList(32, &displays[0], &displayCount)
	if result != kCGErrorSuccess {
		return nil, fmt.Errorf("CGGetActiveDisplayList failed: %d", result)
	}

	if displayCount == 0 {
		return nil, nil
	}

	out := make([]Display, displayCount)
	for i := uint32(0); i < displayCount; i++ {
		bounds := cgDisplayBounds(displays[i])
		out[i] = Display{
			Index: int(i),
			Bounds: image.Rect(
				int(bounds.x),
				int(bounds.y),
				int(bounds.x+bounds.width),
				int(bounds.y+bounds.height),
			),
		}
	}

	return out, nil
}

func captureDisplay(display Display) (*image.RGBA, error) {
	if cgWindowListCreateImage == nil {
		return nil, fmt.Errorf("CGWindowListCreateImage not available")
	}

	// Convert image.Rectangle to cgRect
	bounds := cgRect{
		x:      float64(display.Bounds.Min.X),
		y:      float64(display.Bounds.Min.Y),
		width:  float64(display.Bounds.Dx()),
		height: float64(display.Bounds.Dy()),
	}

	// Capture the screen region
	cgImage := cgWindowListCreateImage(bounds, kCGWindowListOptionOnScreenOnly, kCGNullWindowID, kCGWindowImageDefault)
	if cgImage == 0 {
		return nil, fmt.Errorf("CGWindowListCreateImage returned null")
	}
	defer cfRelease(cgImage)

	width := int(cgImageGetWidth(cgImage))
	height := int(cgImageGetHeight(cgImage))
	bytesPerRow := int(cgImageGetBytesPerRow(cgImage))

	provider := cgImageGetDataProvider(cgImage)
	if provider == 0 {
		return nil, fmt.Errorf("CGImageGetDataProvider returned null")
	}

	data := cgDataProviderCopyData(provider)
	if data == 0 {
		return nil, fmt.Errorf("CGDataProviderCopyData returned null")
	}
	defer cfRelease(data)

	dataLen := cfDataGetLength(data)
	dataPtr := cfDataGetBytePtr(data)
	if dataPtr == 0 {
		return nil, fmt.Errorf("CFDataGetBytePtr returned null")
	}

	// Copy raw bytes to Go slice
	rawBytes := unsafe.Slice((*byte)(unsafe.Pointer(dataPtr)), dataLen)

	// Create RGBA image
	rgba := image.NewRGBA(image.Rect(0, 0, width, height))

	// CGImage format is BGRA on macOS
	for y := 0; y < height; y++ {
		srcOffset := y * bytesPerRow
		dstOffset := y * rgba.Stride
		for x := 0; x < width; x++ {
			srcIdx := srcOffset + x*4
			dstIdx := dstOffset + x*4

			// BGRA -> RGBA
			rgba.Pix[dstIdx+0] = rawBytes[srcIdx+2] // R
			rgba.Pix[dstIdx+1] = rawBytes[srcIdx+1] // G
			rgba.Pix[dstIdx+2] = rawBytes[srcIdx+0] // B
			rgba.Pix[dstIdx+3] = rawBytes[srcIdx+3] // A
		}
	}

	return rgba, nil
}
