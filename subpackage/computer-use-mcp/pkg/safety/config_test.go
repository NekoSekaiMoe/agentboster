package safety

import (
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.Level != SafetyLevelStrict {
		t.Errorf("Expected SafetyLevelStrict, got %v", cfg.Level)
	}

	if cfg.AllowTerminalEdit {
		t.Error("Expected AllowTerminalEdit to be false")
	}

	if !cfg.LogRejections {
		t.Error("Expected LogRejections to be true")
	}
}

func TestLoadFromEnv(t *testing.T) {
	tests := []struct {
		name     string
		env      map[string]string
		expected *Config
	}{
		{
			name: "off level",
			env: map[string]string{
				"COMPUTER_USE_SAFETY_LEVEL": "off",
			},
			expected: &Config{
				Level:                SafetyLevelOff,
				AllowTerminalEdit:    false,
				WhitelistedProcesses: []string{},
				LogRejections:        true,
			},
		},
		{
			name: "permissive level",
			env: map[string]string{
				"COMPUTER_USE_SAFETY_LEVEL": "permissive",
			},
			expected: &Config{
				Level:                SafetyLevelPermissive,
				AllowTerminalEdit:    false,
				WhitelistedProcesses: []string{},
				LogRejections:        true,
			},
		},
		{
			name: "allow terminal edit",
			env: map[string]string{
				"COMPUTER_USE_ALLOW_TERMINAL_EDIT": "true",
			},
			expected: &Config{
				Level:                SafetyLevelStrict,
				AllowTerminalEdit:    true,
				WhitelistedProcesses: []string{},
				LogRejections:        true,
			},
		},
		{
			name: "whitelist",
			env: map[string]string{
				"COMPUTER_USE_WHITELIST": "code, sublime_text, notepad++",
			},
			expected: &Config{
				Level:                SafetyLevelStrict,
				AllowTerminalEdit:    false,
				WhitelistedProcesses: []string{"code", "sublime_text", "notepad++"},
				LogRejections:        true,
			},
		},
		{
			name: "disable logging",
			env: map[string]string{
				"COMPUTER_USE_LOG_REJECTIONS": "false",
			},
			expected: &Config{
				Level:                SafetyLevelStrict,
				AllowTerminalEdit:    false,
				WhitelistedProcesses: []string{},
				LogRejections:        false,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set env vars
			for k, v := range tt.env {
				t.Setenv(k, v)
			}

			cfg := LoadFromEnv()

			if cfg.Level != tt.expected.Level {
				t.Errorf("Expected Level %v, got %v", tt.expected.Level, cfg.Level)
			}

			if cfg.AllowTerminalEdit != tt.expected.AllowTerminalEdit {
				t.Errorf("Expected AllowTerminalEdit %v, got %v", tt.expected.AllowTerminalEdit, cfg.AllowTerminalEdit)
			}

			if len(cfg.WhitelistedProcesses) != len(tt.expected.WhitelistedProcesses) {
				t.Errorf("Expected %d whitelisted processes, got %d", len(tt.expected.WhitelistedProcesses), len(cfg.WhitelistedProcesses))
			}

			if cfg.LogRejections != tt.expected.LogRejections {
				t.Errorf("Expected LogRejections %v, got %v", tt.expected.LogRejections, cfg.LogRejections)
			}
		})
	}
}

func TestShouldAllowInput(t *testing.T) {
	tests := []struct {
		name              string
		config            *Config
		foregroundProcess string
		isTerminal        bool
		expectAllow       bool
		expectReason      string
	}{
		{
			name:              "explicit allow override",
			config:            &Config{Level: SafetyLevelStrict, AllowTerminalEdit: true},
			foregroundProcess: "bash",
			isTerminal:        true,
			expectAllow:       true,
		},
		{
			name:              "safety off",
			config:            &Config{Level: SafetyLevelOff},
			foregroundProcess: "bash",
			isTerminal:        true,
			expectAllow:       true,
		},
		{
			name:              "not a terminal",
			config:            &Config{Level: SafetyLevelStrict},
			foregroundProcess: "firefox",
			isTerminal:        false,
			expectAllow:       true,
		},
		{
			name:              "whitelisted process",
			config:            &Config{Level: SafetyLevelStrict, WhitelistedProcesses: []string{"code", "sublime"}},
			foregroundProcess: "code",
			isTerminal:        true,
			expectAllow:       true,
		},
		{
			name:              "strict blocks terminal",
			config:            &Config{Level: SafetyLevelStrict},
			foregroundProcess: "bash",
			isTerminal:        true,
			expectAllow:       false,
			expectReason:      "terminal editing disabled",
		},
		{
			name:              "permissive blocks terminal (for now)",
			config:            &Config{Level: SafetyLevelPermissive},
			foregroundProcess: "zsh",
			isTerminal:        true,
			expectAllow:       false,
			expectReason:      "safety level: permissive",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			allow, reason := tt.config.ShouldAllowInput(tt.foregroundProcess, tt.isTerminal)

			if allow != tt.expectAllow {
				t.Errorf("Expected allow=%v, got allow=%v (reason: %s)", tt.expectAllow, allow, reason)
			}

			if !tt.expectAllow && tt.expectReason != "" {
				if reason == "" {
					t.Error("Expected a reason for rejection, got empty string")
				}
			}
		})
	}
}

func TestWhitelistMatching(t *testing.T) {
	cfg := &Config{
		Level:                SafetyLevelStrict,
		WhitelistedProcesses: []string{"visual studio code", "notepad++"},
	}

	tests := []struct {
		process string
		expect  bool
	}{
		{"Visual Studio Code", true},     // Exact match (case insensitive)
		{"code", false},                   // Substring of whitelist, but whitelist entry not in process
		{"NOTEPAD++", true},               // Case insensitive
		{"notepad", false},                // Substring of whitelist, but whitelist entry not in process
		{"bash", false},                   // Not whitelisted
		{"terminal", false},               // Not whitelisted
		{"/usr/bin/visual studio code", true}, // Contains whitelist entry
		{"notepad++.exe", true},           // Contains whitelist entry
	}

	for _, tt := range tests {
		t.Run(tt.process, func(t *testing.T) {
			allow, _ := cfg.ShouldAllowInput(tt.process, true)
			if allow != tt.expect {
				t.Errorf("Expected allow=%v for process %s, got %v", tt.expect, tt.process, allow)
			}
		})
	}
}
