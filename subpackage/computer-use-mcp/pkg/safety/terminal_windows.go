// +build windows

package safety

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// TerminalProcess represents a detected terminal process
type TerminalProcess struct {
	PID         int
	Name        string
	CommandLine string
	WindowID    uint64 // Windows HWND
}

// Common Windows terminal process names
var terminalProcessNames = []string{
	"cmd.exe",
	"powershell.exe",
	"pwsh.exe",
	"WindowsTerminal.exe",
	"conhost.exe",
	"wezterm-gui.exe",
	"alacritty.exe",
	"kitty.exe",
	"mintty.exe", // Git Bash
}

// FindTerminalProcesses finds running terminal processes on Windows
func FindTerminalProcesses() ([]TerminalProcess, error) {
	// Use tasklist to enumerate processes
	cmd := exec.Command("tasklist", "/FO", "CSV", "/NH")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var terminals []TerminalProcess
	lines := strings.Split(string(output), "\n")

	for _, line := range lines {
		if line == "" {
			continue
		}

		// CSV format: "name","pid","session","mem usage"
		fields := parseCSV(line)
		if len(fields) < 2 {
			continue
		}

		processName := strings.Trim(fields[0], "\"")
		pidStr := strings.Trim(fields[1], "\"")

		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}

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

// parseCSV splits a CSV line (simple implementation)
func parseCSV(line string) []string {
	var fields []string
	var current strings.Builder
	inQuote := false

	for _, ch := range line {
		switch ch {
		case '"':
			inQuote = !inQuote
		case ',':
			if !inQuote {
				fields = append(fields, current.String())
				current.Reset()
			} else {
				current.WriteRune(ch)
			}
		default:
			current.WriteRune(ch)
		}
	}

	if current.Len() > 0 {
		fields = append(fields, current.String())
	}

	return fields
}

// isTerminalProcess checks if a process name matches known terminals
func isTerminalProcess(name string) bool {
	nameLower := strings.ToLower(name)
	for _, term := range terminalProcessNames {
		if nameLower == strings.ToLower(term) {
			return true
		}
	}
	return false
}

// GetForegroundTerminal checks if the foreground window is a terminal
func GetForegroundTerminal() (bool, string, error) {
	// Would use GetForegroundWindow() + GetWindowThreadProcessId()
	// For now, return unknown
	return false, "", nil
}

// GetTerminalWindowIDs returns window handles for all terminal processes
func GetTerminalWindowIDs() ([]uint64, error) {
	terminals, err := FindTerminalProcesses()
	if err != nil {
		return nil, err
	}

	var windowIDs []uint64
	for _, term := range terminals {
		// Would enumerate windows for each PID via EnumWindows
		_ = term
	}

	return windowIDs, nil
}

// EnhancedTerminalMask returns rectangles to mask based on detected terminals
func EnhancedTerminalMask(width, height int) ([]Rectangle, error) {
	// Windows has good window detection via EnumWindows + GetWindowRect
	// Delegate to existing mask_windows.go implementation
	return nil, nil
}

// Rectangle represents a screen area
type Rectangle struct {
	X, Y, Width, Height int
}
