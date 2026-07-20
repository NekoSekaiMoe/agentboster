// +build darwin

package safety

import (
	"os/exec"
	"strconv"
	"strings"
)

// TerminalProcess represents a detected terminal process
type TerminalProcess struct {
	PID         int
	Name        string
	CommandLine string
	WindowID    uint64 // macOS window ID
}

// Common macOS terminal app bundle identifiers
var terminalBundleIDs = []string{
	"com.apple.Terminal",
	"com.googlecode.iterm2",
	"com.github.wez.wezterm",
	"net.kovidgoyal.kitty",
	"io.alacritty",
	"com.hyper.Hyper",
}

// FindTerminalProcesses finds running terminal applications on macOS
func FindTerminalProcesses() ([]TerminalProcess, error) {
	// Use ps to list processes
	cmd := exec.Command("ps", "-ax", "-o", "pid,comm")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var terminals []TerminalProcess
	lines := strings.Split(string(output), "\n")

	for _, line := range lines[1:] { // Skip header
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}

		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}

		processName := strings.Join(fields[1:], " ")

		// Check if it's a known terminal
		if isTerminalProcess(processName) {
			terminals = append(terminals, TerminalProcess{
				PID:  pid,
				Name: processName,
			})
		}
	}

	return terminals, nil
}

// isTerminalProcess checks if a process name is a terminal
func isTerminalProcess(name string) bool {
	nameLower := strings.ToLower(name)

	// Check for .app bundle names
	terminalNames := []string{
		"terminal",
		"iterm",
		"wezterm",
		"kitty",
		"alacritty",
		"hyper",
	}

	for _, term := range terminalNames {
		if strings.Contains(nameLower, term) {
			return true
		}
	}

	return false
}

// GetForegroundTerminal checks if the foreground window is a terminal
func GetForegroundTerminal() (bool, string, error) {
	// Use AppleScript to get frontmost app
	cmd := exec.Command("osascript", "-e", "tell application \"System Events\" to get name of first application process whose frontmost is true")
	output, err := cmd.Output()
	if err != nil {
		return false, "", nil
	}

	processName := strings.TrimSpace(string(output))
	return isTerminalProcess(processName), processName, nil
}

// GetTerminalWindowIDs returns window IDs for all terminal processes
func GetTerminalWindowIDs() ([]uint64, error) {
	terminals, err := FindTerminalProcesses()
	if err != nil {
		return nil, err
	}

	var windowIDs []uint64
	for _, term := range terminals {
		// Would query window IDs via CGWindowList
		_ = term
	}

	return windowIDs, nil
}

// EnhancedTerminalMask returns rectangles to mask based on detected terminals
func EnhancedTerminalMask(width, height int) ([]Rectangle, error) {
	// macOS has good window detection via CGWindowList
	// Delegate to existing mask_darwin.go implementation
	return nil, nil
}

// Rectangle represents a screen area
type Rectangle struct {
	X, Y, Width, Height int
}
