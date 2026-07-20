package screenshot

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"

	"github.com/disintegration/imaging"
)

const DefaultMaxWidth = 1400

// Format specifies the output image format.
type Format int

const (
	FormatPNG Format = iota
	FormatJPEG
)

// ParseFormat converts a string to Format.
func ParseFormat(s string) Format {
	if s == "png" {
		return FormatPNG
	}
	return FormatJPEG // default
}

func (f Format) MIME() string {
	if f == FormatPNG {
		return "image/png"
	}
	return "image/jpeg"
}

// ClampQuality ensures JPEG quality is in range 1-100.
func ClampQuality(q int) int {
	if q < 1 {
		return 80
	}
	if q > 100 {
		return 100
	}
	return q
}

// Result holds the screenshot capture result.
type Result struct {
	ImageBase64   string
	Format        Format
	NativeSize    [2]int
	ScaledSize    [2]int
	ScaleFactor   float64
	MonitorOrigin [2]int
	MonitorIndex  int
}

// CaptureAndScale captures a monitor, optionally scales it, and returns base64-encoded image.
func CaptureAndScale(maxWidth *int, monitorIndex *int, excludeTerminals bool, format Format, quality int) (*Result, error) {
	maxW := DefaultMaxWidth
	if maxWidth != nil {
		maxW = *maxWidth
	}

	displays, err := GetDisplays()
	if err != nil {
		return nil, fmt.Errorf("failed to enumerate displays: %w", err)
	}

	if len(displays) == 0 {
		return nil, fmt.Errorf("no monitors found")
	}

	selectedIndex := 0
	if monitorIndex != nil {
		if *monitorIndex >= len(displays) {
			return nil, fmt.Errorf("monitor_index %d out of range (available: 0..%d)", *monitorIndex, len(displays)-1)
		}
		selectedIndex = *monitorIndex
	}

	bounds := displays[selectedIndex].Bounds
	origin := [2]int{bounds.Min.X, bounds.Min.Y}

	img, err := CaptureDisplay(selectedIndex)
	if err != nil {
		return nil, fmt.Errorf("screenshot capture failed: %w", err)
	}

	w := img.Bounds().Dx()
	h := img.Bounds().Dy()
	nativeSize := [2]int{w, h}

	// Terminal masking
	if excludeTerminals {
		masked := maskTerminalWindows(img, origin)
		// Convert back to concrete type
		bounds := masked.Bounds()
		rgba := image.NewRGBA(bounds)
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				rgba.Set(x, y, masked.At(x, y))
			}
		}
		img = rgba
	}

	// Scale if needed
	var scaled image.Image = img
	scaledSize := nativeSize
	if w > maxW {
		ratio := float64(maxW) / float64(w)
		newH := int(float64(h)*ratio + 0.5)
		if newH < 1 {
			newH = 1
		}
		scaled = imaging.Resize(img, maxW, newH, imaging.Lanczos)
		scaledSize = [2]int{maxW, newH}
	}

	// Encode to base64
	var buf bytes.Buffer
	if format == FormatPNG {
		if err := png.Encode(&buf, scaled); err != nil {
			return nil, fmt.Errorf("PNG encode failed: %w", err)
		}
	} else {
		// JPEG requires RGB, not RGBA
		rgbImg := imaging.Clone(scaled)
		opts := &jpeg.Options{Quality: ClampQuality(quality)}
		if err := jpeg.Encode(&buf, rgbImg, opts); err != nil {
			return nil, fmt.Errorf("JPEG encode failed: %w", err)
		}
	}

	imageBase64 := base64.StdEncoding.EncodeToString(buf.Bytes())
	scaleFactor := float64(w) / float64(scaledSize[0])

	return &Result{
		ImageBase64:   imageBase64,
		Format:        format,
		NativeSize:    nativeSize,
		ScaledSize:    scaledSize,
		ScaleFactor:   scaleFactor,
		MonitorOrigin: origin,
		MonitorIndex:  selectedIndex,
	}, nil
}
