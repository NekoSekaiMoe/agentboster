package lock

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLockAcquireRelease(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "test.lock")

	// Acquire lock
	lock1, err := New(lockPath)
	if err != nil {
		t.Fatalf("Failed to acquire lock: %v", err)
	}

	// Verify lock file exists
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		t.Fatal("Lock file was not created")
	}

	// Release lock
	if err := lock1.Release(); err != nil {
		t.Fatalf("Failed to release lock: %v", err)
	}

	// Verify lock file was removed
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatal("Lock file was not removed after release")
	}
}

func TestLockDoubleAcquire(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "test.lock")

	// Acquire first lock
	lock1, err := New(lockPath)
	if err != nil {
		t.Fatalf("Failed to acquire first lock: %v", err)
	}
	defer lock1.Release()

	// Try to acquire second lock (should fail)
	lock2, err := New(lockPath)
	if err == nil {
		lock2.Release()
		t.Fatal("Second lock acquisition should have failed")
	}

	if lock2 != nil {
		t.Fatal("Second lock should be nil on failure")
	}
}

func TestLockStaleLockReclamation(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "test.lock")

	// Create a stale lock file with a non-existent PID
	staleContent := fmt.Sprintf("999999\nagentboster-cli\n%d", time.Now().Unix())
	if err := os.WriteFile(lockPath, []byte(staleContent), 0644); err != nil {
		t.Fatalf("Failed to create stale lock file: %v", err)
	}

	// Try to acquire lock (should reclaim stale lock)
	lock, err := New(lockPath)
	if err != nil {
		t.Fatalf("Failed to reclaim stale lock: %v", err)
	}
	defer lock.Release()

	// Verify lock was acquired
	if lock == nil {
		t.Fatal("Lock should have been acquired after reclaiming stale lock")
	}
}

func TestLockReadLockFile(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "test.lock")

	// Create a lock file
	testPID := 12345
	testApp := "test-app"
	content := "12345\ntest-app\n1234567890"
	if err := os.WriteFile(lockPath, []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write test lock file: %v", err)
	}

	// Read lock file
	pid, appName := readLockFile(lockPath)

	if pid != testPID {
		t.Errorf("Expected PID %d, got %d", testPID, pid)
	}

	if appName != testApp {
		t.Errorf("Expected app name %s, got %s", testApp, appName)
	}
}

func TestLockMultipleRelease(t *testing.T) {
	tmpDir := t.TempDir()
	lockPath := filepath.Join(tmpDir, "test.lock")

	lock, err := New(lockPath)
	if err != nil {
		t.Fatalf("Failed to acquire lock: %v", err)
	}

	// First release
	if err := lock.Release(); err != nil {
		t.Fatalf("First release failed: %v", err)
	}

	// Second release (should not error)
	if err := lock.Release(); err != nil {
		t.Fatalf("Second release should not error: %v", err)
	}
}
