// +build linux

package safety

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindTerminalProcesses(t *testing.T) {
	// This test only works on Linux with /proc
	if _, err := os.Stat("/proc"); os.IsNotExist(err) {
		t.Skip("Skipping on non-Linux system")
	}

	terminals, err := FindTerminalProcesses()
	if err != nil {
		t.Fatalf("FindTerminalProcesses failed: %v", err)
	}

	// May or may not find terminals depending on environment
	t.Logf("Found %d terminal processes", len(terminals))
	for _, term := range terminals {
		t.Logf("  PID=%d Name=%s", term.PID, term.Name)
	}
}

func TestIsTerminalProcess(t *testing.T) {
	tests := []struct {
		name   string
		expect bool
	}{
		{"gnome-terminal", true},
		{"gnome-terminal-server", true},
		{"konsole", true},
		{"xterm", true},
		{"alacritty", true},
		{"kitty", true},
		{"bash", false},
		{"firefox", false},
		{"code", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := isTerminalProcess(tt.name)
			if result != tt.expect {
				t.Errorf("isTerminalProcess(%q) = %v, want %v", tt.name, result, tt.expect)
			}
		})
	}
}

func TestReadProcStat(t *testing.T) {
	if _, err := os.Stat("/proc"); os.IsNotExist(err) {
		t.Skip("Skipping on non-Linux system")
	}

	// Read our own process
	pid := os.Getpid()
	name, err := readProcStat(pid)
	if err != nil {
		t.Fatalf("readProcStat failed: %v", err)
	}

	t.Logf("Current process name: %s", name)

	// Should contain "test" or "go" (the test runner)
	if name == "" {
		t.Error("Expected non-empty process name")
	}
}

func TestScanForShellProcesses(t *testing.T) {
	if _, err := os.Stat("/proc"); os.IsNotExist(err) {
		t.Skip("Skipping on non-Linux system")
	}

	shells, err := ScanForShellProcesses()
	if err != nil {
		t.Fatalf("ScanForShellProcesses failed: %v", err)
	}

	t.Logf("Found %d shell processes", len(shells))

	// Verify we can read comm for each shell PID
	for _, pid := range shells {
		comm, err := os.ReadFile(filepath.Join("/proc", string(rune(pid)), "comm"))
		if err == nil {
			t.Logf("  PID=%d comm=%s", pid, comm)
		}
	}
}

func TestReadEnviron(t *testing.T) {
	if _, err := os.Stat("/proc"); os.IsNotExist(err) {
		t.Skip("Skipping on non-Linux system")
	}

	// Read our own process environment
	pid := os.Getpid()
	env, err := ReadEnviron(pid)
	if err != nil {
		t.Fatalf("ReadEnviron failed: %v", err)
	}

	// Should have at least PATH
	if _, ok := env["PATH"]; !ok {
		t.Error("Expected PATH in environment")
	}

	t.Logf("Found %d environment variables", len(env))
}

func TestEnhancedTerminalMask(t *testing.T) {
	width, height := 1920, 1080

	rects, err := EnhancedTerminalMask(width, height)
	if err != nil {
		t.Fatalf("EnhancedTerminalMask failed: %v", err)
	}

	if len(rects) == 0 {
		t.Error("Expected at least one rectangle")
	}

	// Should mask bottom third as fallback
	expectedY := (height * 2) / 3
	if rects[0].Y != expectedY {
		t.Errorf("Expected Y=%d, got Y=%d", expectedY, rects[0].Y)
	}

	t.Logf("Mask rectangles: %v", rects)
}

func TestGetForegroundTerminal(t *testing.T) {
	// This test requires X11 and may not work in headless CI
	isTerminal, processName, err := GetForegroundTerminal()
	if err != nil {
		t.Logf("GetForegroundTerminal returned error (expected in headless): %v", err)
		return
	}

	t.Logf("Foreground: isTerminal=%v, process=%s", isTerminal, processName)
}

func TestScanNull(t *testing.T) {
	input := "FOO=bar\x00BAZ=qux\x00HELLO=world\x00"

	var tokens []string
	for i := 0; i < len(input); {
		advance, token, _ := scanNull([]byte(input[i:]), false)
		if advance == 0 {
			break
		}
		if len(token) > 0 {
			tokens = append(tokens, string(token))
		}
		i += advance
	}

	expected := []string{"FOO=bar", "BAZ=qux", "HELLO=world"}
	if len(tokens) != len(expected) {
		t.Errorf("Expected %d tokens, got %d", len(expected), len(tokens))
	}

	for i, tok := range tokens {
		if tok != expected[i] {
			t.Errorf("Token %d: expected %q, got %q", i, expected[i], tok)
		}
	}
}
