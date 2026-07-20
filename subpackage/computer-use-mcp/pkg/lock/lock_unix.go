//go:build darwin || linux

package lock

import "syscall"

// lockFile acquires an exclusive, non-blocking advisory lock on the file
// descriptor using POSIX flock(2).
func lockFile(fd int) error {
	return syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
}

// unlockFile releases a previously acquired advisory lock.
func unlockFile(fd int) error {
	return syscall.Flock(fd, syscall.LOCK_UN)
}
