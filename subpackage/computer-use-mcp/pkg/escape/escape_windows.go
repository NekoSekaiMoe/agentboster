//go:build windows

package escape

import (
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                   = windows.NewLazySystemDLL("user32.dll")
	procSetWindowsHookEx     = user32.NewProc("SetWindowsHookExW")
	procCallNextHookEx       = user32.NewProc("CallNextHookEx")
	procUnhookWindowsHookEx  = user32.NewProc("UnhookWindowsHookEx")
	procGetMessage           = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessage      = user32.NewProc("DispatchMessageW")
	procPostThreadMessage    = user32.NewProc("PostThreadMessageW")
)

const (
	whKeyboardLL = 13
	vkEscape     = 0x1B
	wmKeydown    = 0x0100
	wmQuit       = 0x0012
)

type kbdllhookstruct struct {
	VkCode      uint32
	ScanCode    uint32
	Flags       uint32
	Time        uint32
	DwExtraInfo uintptr
}

// startPlatform spawns a goroutine pinned to a dedicated OS thread that
// installs a low-level keyboard hook (WH_KEYBOARD_LL) and runs a GetMessage
// loop. Windows requires both the hook installation and the message loop to
// execute on the same thread, so we LockOSThread for the lifetime of the
// goroutine.
//
// Stop() wakes the loop from another goroutine by calling PostThreadMessageW
// with WM_QUIT — this targets the exact thread that owns the message queue
// and unblocks GetMessage immediately. (PostQuitMessage only works reliably
// when called from the same thread that owns the queue.)
func (h *Hook) startPlatform() error {
	go func() {
		// Pin this goroutine to its OS thread for the lifetime of the hook.
		// The runtime guarantees the goroutine will not be rescheduled to
		// another thread, which is required for SetWindowsHookEx + GetMessage.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		threadID := windows.GetCurrentThreadId()

		// Publish the thread id so Stop() can wake us, and register the
		// wake callback used by Hook.Stop(). Both are guarded by h.mu.
		h.mu.Lock()
		h.wakeThreadID = threadID
		h.wakeLoop = h.wakeLoopWindows
		h.mu.Unlock()
		defer func() {
			h.mu.Lock()
			h.wakeThreadID = 0
			h.wakeLoop = nil
			h.mu.Unlock()
		}()

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

		// Message loop. GetMessage blocks until a message arrives for this
		// thread; it returns 0 on WM_QUIT and -1 on error.
		msg := make([]byte, 48) // MSG struct is 48 bytes on 64-bit Windows
		for {
			ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0)
			if ret == 0 || ret == ^uintptr(0) {
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
			procDispatchMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
		}
	}()

	return nil
}

// wakeLoopWindows is called by Hook.Stop() on a different goroutine to
// unblock the GetMessage loop on the hook's dedicated thread. Falling back
// to PostQuitMessage is unsafe across threads; PostThreadMessageW targets
// the specific thread id and is the documented way to break another
// thread's GetMessage loop.
func (h *Hook) wakeLoopWindows() {
	h.mu.Lock()
	tid := h.wakeThreadID
	h.mu.Unlock()
	if tid == 0 {
		return
	}
	procPostThreadMessage.Call(uintptr(tid), uintptr(wmQuit), 0, 0)
}
