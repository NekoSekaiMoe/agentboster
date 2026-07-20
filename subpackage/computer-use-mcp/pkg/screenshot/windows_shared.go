//go:build windows

package screenshot

import "golang.org/x/sys/windows"

// Shared Windows DLL handles
var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")
)
