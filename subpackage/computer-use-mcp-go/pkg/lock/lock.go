package lock

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Lock represents a session lock file to prevent concurrent computer-use sessions.
type Lock struct {
	path string
	file *os.File
}

// New creates a new lock at the given path.
// It checks both CLI and desktop config directories for existing locks.
func New(path string) (*Lock, error) {
	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return nil, fmt.Errorf("failed to create lock directory: %w", err)
	}

	// Check for stale locks in both CLI and desktop paths
	homeDir, _ := os.UserHomeDir()
	checkPaths := []string{
		path,
		filepath.Join(homeDir, ".config", "agentboster-cli", "computer-use.lock"),
		filepath.Join(homeDir, ".config", "agentboster-desktop", "computer-use.lock"),
	}

	for _, checkPath := range checkPaths {
		if err := reclaimStaleLock(checkPath); err != nil {
			return nil, fmt.Errorf("failed to reclaim stale lock at %s: %w", checkPath, err)
		}
	}

	// Try to acquire the lock
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open lock file: %w", err)
	}

	// Try to acquire exclusive lock (non-blocking)
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		// Check if another process holds the lock
		if existingPID, appName := readLockFile(path); existingPID != 0 {
			return nil, fmt.Errorf("computer-use session already active (PID %d, app: %s)", existingPID, appName)
		}
		return nil, fmt.Errorf("failed to acquire lock: %w", err)
	}

	// Write our PID and app name
	appName := "agentboster-cli"
	if strings.Contains(os.Args[0], "desktop") {
		appName = "agentboster-desktop"
	}
	content := fmt.Sprintf("%d\n%s\n%d", os.Getpid(), appName, time.Now().Unix())
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to truncate lock file: %w", err)
	}
	if _, err := file.Seek(0, 0); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to seek lock file: %w", err)
	}
	if _, err := file.WriteString(content); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to write lock file: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return nil, fmt.Errorf("failed to sync lock file: %w", err)
	}

	return &Lock{path: path, file: file}, nil
}

// Release releases the lock.
func (l *Lock) Release() error {
	if l.file == nil {
		return nil
	}

	// Release flock
	if err := syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN); err != nil {
		return fmt.Errorf("failed to release lock: %w", err)
	}

	// Close file
	if err := l.file.Close(); err != nil {
		return fmt.Errorf("failed to close lock file: %w", err)
	}
	l.file = nil

	// Remove lock file
	if err := os.Remove(l.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove lock file: %w", err)
	}

	return nil
}

// reclaimStaleLock removes a lock file if the owning process is dead.
func reclaimStaleLock(path string) error {
	pid, _ := readLockFile(path)
	if pid == 0 {
		return nil // No lock file or empty
	}

	// Check if process is alive
	process, err := os.FindProcess(pid)
	if err != nil {
		// Process doesn't exist, remove stale lock
		return os.Remove(path)
	}

	// Try to signal the process (signal 0 = check existence without sending signal)
	if err := process.Signal(syscall.Signal(0)); err != nil {
		// Process is dead, remove stale lock
		return os.Remove(path)
	}

	// Process is alive, cannot reclaim
	return nil
}

// readLockFile reads PID and app name from a lock file.
func readLockFile(path string) (int, string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, ""
	}

	lines := strings.Split(string(data), "\n")
	if len(lines) < 2 {
		return 0, ""
	}

	pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return 0, ""
	}

	appName := strings.TrimSpace(lines[1])
	return pid, appName
}
