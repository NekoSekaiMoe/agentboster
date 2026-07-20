package screenshot

import (
	"image"
	"testing"
)

func TestCaptureBasic(t *testing.T) {
	// This test requires a display server
	maxWidth := 800
	monitorIndex := 0
	quality := 80
	result, err := CaptureAndScale(&maxWidth, &monitorIndex, false, FormatJPEG, quality)

	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	if result == nil {
		t.Fatal("Result should not be nil")
	}

	if result.ImageBase64 == "" {
		t.Error("ImageBase64 should not be empty")
	}

	if result.ScaledSize[0] == 0 || result.ScaledSize[1] == 0 {
		t.Errorf("Invalid dimensions: %dx%d", result.ScaledSize[0], result.ScaledSize[1])
	}

	if result.ScaleFactor <= 0 {
		t.Errorf("Invalid scale factor: %f", result.ScaleFactor)
	}
}

func TestCaptureWithPNG(t *testing.T) {
	maxWidth := 1200
	result, err := CaptureAndScale(&maxWidth, nil, false, FormatPNG, 0)

	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	if result == nil {
		t.Fatal("Result should not be nil")
	}

	// PNG should be larger than JPEG for same content
	if result.ImageBase64 == "" {
		t.Error("ImageBase64 should not be empty")
	}
}

func TestMaskTerminalWindows(t *testing.T) {
	// Create a test image
	img := image.NewRGBA(image.Rect(0, 0, 100, 100))
	origin := [2]int{0, 0}

	// This should not panic
	result := maskTerminalWindows(img, origin)
	if result == nil {
		t.Error("maskTerminalWindows should not return nil")
	}
}

func TestCaptureInvalidMonitor(t *testing.T) {
	invalidMonitor := 999
	_, err := CaptureAndScale(nil, &invalidMonitor, false, FormatJPEG, 80)

	if err == nil {
		t.Error("Should error on invalid monitor index")
	}
}

func TestCaptureDefaultOptions(t *testing.T) {
	result, err := CaptureAndScale(nil, nil, false, FormatJPEG, 80)

	if err != nil {
		t.Skipf("Skipping test (no display?): %v", err)
	}

	if result == nil {
		t.Fatal("Result should not be nil with default options")
	}

	// Default should be JPEG
	if result.ScaledSize[0] == 0 {
		t.Error("Width should not be zero")
	}
}
