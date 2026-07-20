//go:build windows

package lock

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procLockFileEx     = kernel32.NewProc("LockFileEx")
	procUnlockFileEx   = kernel32.NewProc("UnlockFileEx")
)

const (
	lockfileExclusiveLock = 0x00000002
	lockfileFailImmediately = 0x00000001
)

// lockFile acquires an exclusive, non-blocking advisory lock on the file
// handle using Windows LockFileEx (byte-range lock over the entire file).
func lockFile(fd int) error {
	// OVERLAPPED struct: we use the file handle directly via fd.
	// LockFileEx wants an OVERLAPPED whose hEvent is zero; the Offset/OffsetHigh
	// select the byte range. We lock bytes [0, 0xFFFFFFFFFFFFFFFF).
	var overlapped [8]uintptr // OVERLAPPED is 32 bytes on 64-bit, 16 on 32-bit; uintptr array is enough
	overlapped[0] = 0
	overlapped[1] = 0
	overlapped[2] = 0
	overlapped[3] = 0

	handle := syscall.Handle(fd)
	ret, _, lastErr := procLockFileEx.Call(
		uintptr(handle),
		lockfileExclusiveLock|lockfileFailImmediately,
		0,
		0xFFFFFFFF,
		0xFFFFFFFF,
		uintptr(unsafe.Pointer(&overlapped[0])),
	)
	if ret == 0 {
		return fmt.Errorf("LockFileEx failed: %v", lastErr)
	}
	return nil
}

// unlockFile releases a previously acquired Windows byte-range lock.
func unlockFile(fd int) error {
	var overlapped [8]uintptr
	handle := syscall.Handle(fd)
	ret, _, lastErr := procUnlockFileEx.Call(
		uintptr(handle),
		0,
		0xFFFFFFFF,
		0xFFFFFFFF,
		uintptr(unsafe.Pointer(&overlapped[0])),
	)
	if ret == 0 {
		return fmt.Errorf("UnlockFileEx failed: %v", lastErr)
	}
	return nil
}
