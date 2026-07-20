package safety

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// SafetyLevel defines how strictly terminal protection is enforced
type SafetyLevel int

const (
	// SafetyLevelOff disables all terminal protection
	SafetyLevelOff SafetyLevel = iota
	// SafetyLevelPermissive allows common safe operations (read-only tools like grep, ls)
	SafetyLevelPermissive
	// SafetyLevelStrict blocks all terminal interactions (default)
	SafetyLevelStrict
)

// Config holds terminal safety configuration
type Config struct {
	// Safety level (off/permissive/strict)
	Level SafetyLevel

	// AllowTerminalEdit explicitly enables terminal input (overrides level)
	AllowTerminalEdit bool

	// WhitelistedProcesses - process names that are safe to interact with
	// (e.g., ["code", "sublime_text", "notepad++"])
	WhitelistedProcesses []string

	// LogRejections enables logging of blocked operations
	LogRejections bool
}

// DefaultConfig returns the default safety configuration
func DefaultConfig() *Config {
	return &Config{
		Level:                SafetyLevelStrict,
		AllowTerminalEdit:    false,
		WhitelistedProcesses: []string{},
		LogRejections:        true,
	}
}

// LoadFromEnv loads configuration from environment variables
func LoadFromEnv() *Config {
	cfg := DefaultConfig()

	// COMPUTER_USE_SAFETY_LEVEL: off, permissive, strict
	if level := os.Getenv("COMPUTER_USE_SAFETY_LEVEL"); level != "" {
		switch strings.ToLower(level) {
		case "off":
			cfg.Level = SafetyLevelOff
		case "permissive":
			cfg.Level = SafetyLevelPermissive
		case "strict":
			cfg.Level = SafetyLevelStrict
		}
	}

	// COMPUTER_USE_ALLOW_TERMINAL_EDIT: true/false
	if allow := os.Getenv("COMPUTER_USE_ALLOW_TERMINAL_EDIT"); allow != "" {
		if val, err := strconv.ParseBool(allow); err == nil {
			cfg.AllowTerminalEdit = val
		}
	}

	// COMPUTER_USE_WHITELIST: comma-separated process names
	if whitelist := os.Getenv("COMPUTER_USE_WHITELIST"); whitelist != "" {
		cfg.WhitelistedProcesses = strings.Split(whitelist, ",")
		for i := range cfg.WhitelistedProcesses {
			cfg.WhitelistedProcesses[i] = strings.TrimSpace(cfg.WhitelistedProcesses[i])
		}
	}

	// COMPUTER_USE_LOG_REJECTIONS: true/false
	if log := os.Getenv("COMPUTER_USE_LOG_REJECTIONS"); log != "" {
		if val, err := strconv.ParseBool(log); err == nil {
			cfg.LogRejections = val
		}
	}

	return cfg
}

// ShouldAllowInput checks if input is allowed based on configuration and foreground window
func (c *Config) ShouldAllowInput(foregroundProcess string, isTerminal bool) (bool, string) {
	// Explicit override via AllowTerminalEdit
	if c.AllowTerminalEdit {
		return true, ""
	}

	// Safety level OFF - allow everything
	if c.Level == SafetyLevelOff {
		return true, ""
	}

	// Not a terminal - always allow
	if !isTerminal {
		return true, ""
	}

	// Check whitelist
	for _, allowed := range c.WhitelistedProcesses {
		if strings.Contains(strings.ToLower(foregroundProcess), strings.ToLower(allowed)) {
			return true, ""
		}
	}

	// SafetyLevelPermissive - allow if we detect it's a safe operation
	// (this would require analyzing the input, not implemented yet)
	if c.Level == SafetyLevelPermissive {
		// For now, permissive = allow non-editing keys only
		// This would need to be checked at the input layer
		return false, fmt.Sprintf("terminal in foreground (process: %s), safety level: permissive", foregroundProcess)
	}

	// SafetyLevelStrict - block all terminal input
	return false, fmt.Sprintf("terminal in foreground (process: %s), terminal editing disabled", foregroundProcess)
}

// LogRejection logs a rejected input operation if logging is enabled
func (c *Config) LogRejection(operation, reason string) {
	if c.LogRejections {
		fmt.Fprintf(os.Stderr, "[SAFETY] Rejected %s: %s\n", operation, reason)
	}
}
