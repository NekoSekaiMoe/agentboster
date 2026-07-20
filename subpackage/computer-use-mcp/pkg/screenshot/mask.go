package screenshot

import (
	"image"
	"image/color"
)

// maskTerminalWindows blacks out terminal windows in the screenshot.
func maskTerminalWindows(img image.Image, monitorOrigin [2]int) image.Image {
	terminalIDs := getTerminalWindowIDs()
	if len(terminalIDs) == 0 {
		return img
	}

	// Convert to RGBA so we can modify pixels
	bounds := img.Bounds()
	rgba := image.NewRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			rgba.Set(x, y, img.At(x, y))
		}
	}

	black := color.RGBA{0, 0, 0, 255}

	// Get terminal window rects and mask them
	rects := getTerminalWindowRects(terminalIDs, monitorOrigin, bounds.Dx(), bounds.Dy())
	for _, rect := range rects {
		drawBlackRect(rgba, rect, black)
	}

	return rgba
}

func drawBlackRect(img *image.RGBA, rect image.Rectangle, c color.RGBA) {
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			img.Set(x, y, c)
		}
	}
}
