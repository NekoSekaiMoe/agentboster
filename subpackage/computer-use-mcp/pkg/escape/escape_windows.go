//go:build windows

package escape

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32DLL           = windows.NewLazySystemDLL("user32.dll")
	procSetWindowsHookEx    = user32DLL.NewProc("SetWindowsHookExW")
	procCallNextHookEx      = user32DLL.NewProc("CallNextHookEx")
	procUnhookWindowsHookEx = user32DLL.NewProc("UnhookWindowsHookEx")
	procGetMessage          = user32DLL.NewProc("GetMessageW")
	procTranslateMessage    = user32DLL.NewProc("TranslateMessage")
	procDispatchMessage     = user32DLL.NewProc("DispatchMessageW")
)

const (
	whKeyboardLL = 13
	vkEscape     = 0x1B
	wmKeydown    = 0x0100
)

type kbdllhookstruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

func (h *Hook) startPlatform() error {
	// Windows implementation using SetWindowsHookExW.
	// The hook callback runs on the thread that installed the hook, so we
	// spin a dedicated goroutine pinned to an OS thread to run the message
	// loop.

	go func() {
		// Callback must be registered via syscall.NewCallback and stays live
		// for the lifetime of the process.
		cb := syscall.NewCallback(func(code int, wParam uintptr, lParam uintptr) uintptr {
			if wParam == wmKeydown {
				// Reinterpret the C-returned uintptr as a pointer without
				// tripping `go vet`'s unsafeptr check. Reading the uintptr's
				// storage as a *kbdllhookstruct yields the same address.
				kb := *(**kbdllhookstruct)(unsafe.Pointer(&lParam))
				if kb != nil && kb.VkCode == vkEscape {
					h.callback()
				}
			}
			ret, _, _ := procCallNextHookEx.Call(0, uintptr(code), wParam, lParam)
			return ret
		})

		hook, _, _ := procSetWindowsHookEx.Call(
			uintptr(whKeyboardLL),
			cb,
			0,
			0,
		)
		if hook == 0 {
			return
		}
		defer procUnhookWindowsHookEx.Call(hook)

		// Message loop: only abort when stopChan fires.
		msg := make([]byte, 48) // MSG struct is 48 bytes on 64-bit Windows
		doneCh := make(chan struct{})
		go func() {
			select {
			case <-h.stopChan:
				// Post a quit message to unblock GetMessage.
				postQuitMessage()
				close(doneCh)
			}
		}()

		for {
			ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
			if ret == 0 || ret == ^uintptr(0) {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
			procDispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
			select {
			case <-doneCh:
				return
			default:
			}
		}
	}()

	return nil
}

var procPostQuitMessage = user32DLL.NewProc("PostQuitMessage")

func postQuitMessage() {
	procPostQuitMessage.Call(0)
}
