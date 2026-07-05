package lsp

import (
	"testing"
)

func TestDetectProjectType(t *testing.T) {
	tests := []struct {
		name     string
		setup    func(dir string)
		expected ProjectType
	}{
		{
			name: "Rust project with Cargo.toml",
			setup: func(dir string) {
				// Create a temporary Cargo.toml
			},
			expected: ProjectTypeRust,
		},
		{
			name: "Go project with go.mod",
			setup: func(dir string) {
				// Create a temporary go.mod
			},
			expected: ProjectTypeGo,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// This is a placeholder - full implementation would need temp directories
			t.Skip("TODO: implement with temp directories")
		})
	}
}

func TestGetServerConfig(t *testing.T) {
	tests := []struct {
		ptype      ProjectType
		shouldExist bool
	}{
		{ProjectTypeRust, true},
		{ProjectTypeGo, true},
		{ProjectTypeCpp, true},
		{ProjectTypeC, true},
		{ProjectTypePython, true},
		{ProjectTypeTypeScript, true},
		{ProjectTypeJavaScript, true},
		{ProjectTypeUnknown, false},
	}

	for _, tt := range tests {
		t.Run(string(tt.ptype), func(t *testing.T) {
			cfg, ok := GetServerConfig(tt.ptype)
			if ok != tt.shouldExist {
				t.Errorf("GetServerConfig(%s) existence = %v, want %v", tt.ptype, ok, tt.shouldExist)
			}
			if ok {
				if cfg.Command == "" {
					t.Errorf("GetServerConfig(%s) has empty Command", tt.ptype)
				}
				if cfg.LanguageID == "" {
					t.Errorf("GetServerConfig(%s) has empty LanguageID", tt.ptype)
				}
			}
		})
	}
}
