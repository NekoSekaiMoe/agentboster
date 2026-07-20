// +build linux

package safety

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// TerminalProcess represents a detected terminal process
type TerminalProcess struct {
	PID         int
	Name        string
	CommandLine string
	WindowID    uint64 // X11 window ID, if available
}

// Common terminal emulator process names
var terminalProcessNames = []string{
	"gnome-terminal",
	"konsole",
	"xterm",
	"terminator",
	"tilix",
	"alacritty",
	"kitty",
	"wezterm",
	"urxvt",
	"rxvt",
	"st",
	"xfce4-terminal",
	"mate-terminal",
	"lxterminal",
	"sakura",
	"terminology",
	"guake",
	"yakuake",
	"tilda",
}

// FindTerminalProcesses scans /proc to find running terminal emulators
func FindTerminalProcesses() ([]TerminalProcess, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}

	var terminals []TerminalProcess

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		// Check if directory name is a PID
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}

		// Read /proc/[pid]/comm for process name
		comm, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "comm"))
		if err != nil {
			continue
		}
		processName := strings.TrimSpace(string(comm))

		// Check if it's a known terminal
		if !isTerminalProcess(processName) {
			continue
		}

		// Read /proc/[pid]/cmdline for full command
		cmdline, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil {
			continue
		}
		// cmdline is null-separated, convert to space-separated
		commandLine := strings.ReplaceAll(string(cmdline), "\x00", " ")
		commandLine = strings.TrimSpace(commandLine)

		terminals = append(terminals, TerminalProcess{
			PID:         pid,
			Name:        processName,
			CommandLine: commandLine,
		})
	}

	return terminals, nil
}

// isTerminalProcess checks if a process name matches known terminals
func isTerminalProcess(name string) bool {
	nameLower := strings.ToLower(name)
	for _, term := range terminalProcessNames {
		if nameLower == term || strings.Contains(nameLower, term) {
			return true
		}
	}
	return false
}

// GetForegroundTerminal checks if the foreground window is a terminal
// Returns (isTerminal, processName)
func GetForegroundTerminal() (bool, string, error) {
	// Get foreground window PID via X11
	pid, err := getForegroundWindowPID()
	if err != nil {
		return false, "", err
	}

	if pid == 0 {
		return false, "", nil
	}

	// Read process name
	comm, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "comm"))
	if err != nil {
		return false, "", err
	}
	processName := strings.TrimSpace(string(comm))

	return isTerminalProcess(processName), processName, nil
}

// getForegroundWindowPID uses xdotool to get the foreground window's PID
// Falls back to parsing _NET_ACTIVE_WINDOW if xdotool is not available
func getForegroundWindowPID() (int, error) {
	// Try xdotool first (most reliable)
	if pid := tryXdotool(); pid > 0 {
		return pid, nil
	}

	// Fallback: parse X11 properties directly
	// This requires parsing _NET_ACTIVE_WINDOW and _NET_WM_PID
	// For now, return 0 to indicate "unknown"
	return 0, nil
}

// tryXdotool attempts to get foreground PID via xdotool
func tryXdotool() int {
	// Check if xdotool exists
	if _, err := os.Stat("/usr/bin/xdotool"); os.IsNotExist(err) {
		return 0
	}

	// Read xdotool output
	// In production, this would exec xdotool and parse output
	// Simplified for now to avoid subprocess dependency
	return 0
}

// GetTerminalWindowIDs returns X11 window IDs for all terminal processes
func GetTerminalWindowIDs() ([]uint64, error) {
	terminals, err := FindTerminalProcesses()
	if err != nil {
		return nil, err
	}

	var windowIDs []uint64
	for _, term := range terminals {
		// Map PID to window ID via _NET_WM_PID property
		// This requires parsing X11 window properties
		// For now, just collect PIDs as placeholder
		_ = term
	}

	return windowIDs, nil
}

// IsTerminalInBounds checks if coordinates fall within known terminal window bounds
func IsTerminalInBounds(x, y int, terminals []TerminalProcess) bool {
	// This would query X11 window geometry for each terminal PID
	// and check if (x, y) intersects any terminal window
	// Placeholder implementation
	return false
}

// EnhancedTerminalMask returns rectangles to mask, based on detected terminals
func EnhancedTerminalMask(width, height int) ([]Rectangle, error) {
	terminals, err := FindTerminalProcesses()
	if err != nil || len(terminals) == 0 {
		// Fallback to conservative bottom-third masking
		maskY := (height * 2) / 3
		return []Rectangle{{X: 0, Y: maskY, Width: width, Height: height - maskY}}, nil
	}

	// In a full implementation, we'd query X11 for each terminal's window geometry
	// For now, use conservative fallback
	maskY := (height * 2) / 3
	return []Rectangle{{X: 0, Y: maskY, Width: width, Height: height - maskY}}, nil
}

// Rectangle represents a screen area
type Rectangle struct {
	X, Y, Width, Height int
}

// readProcStat reads /proc/[pid]/stat and returns the process name
func readProcStat(pid int) (string, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}

	// stat format: pid (comm) state ...
	// Extract comm between parentheses
	start := strings.IndexByte(string(data), '(')
	end := strings.LastIndexByte(string(data), ')')
	if start < 0 || end < 0 || end <= start {
		return "", nil
	}

	return string(data[start+1 : end]), nil
}

// ScanForShellProcesses finds shell processes (bash, zsh, fish, sh)
// These are usually children of terminal emulators
func ScanForShellProcesses() ([]int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}

	shellNames := []string{"bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"}
	var shellPIDs []int

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}

		comm, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "comm"))
		if err != nil {
			continue
		}
		processName := strings.TrimSpace(string(comm))

		for _, shell := range shellNames {
			if processName == shell {
				shellPIDs = append(shellPIDs, pid)
				break
			}
		}
	}

	return shellPIDs, nil
}

// ReadEnviron reads /proc/[pid]/environ and returns key-value pairs
func ReadEnviron(pid int) (map[string]string, error) {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return nil, err
	}

	env := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Split(scanNull)

	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.IndexByte(line, '='); idx > 0 {
			key := line[:idx]
			val := line[idx+1:]
			env[key] = val
		}
	}

	return env, scanner.Err()
}

// scanNull is a split function for Scanner that splits on null bytes
func scanNull(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := strings.IndexByte(string(data), 0); i >= 0 {
		return i + 1, data[0:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
