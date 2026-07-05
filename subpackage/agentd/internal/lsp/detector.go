package lsp

import (
	"os"
	"path/filepath"
	"regexp"
)

// ProjectType represents the detected project language/type.
type ProjectType string

const (
	ProjectTypeRust       ProjectType = "rust"
	ProjectTypeGo         ProjectType = "go"
	ProjectTypeCpp        ProjectType = "cpp"
	ProjectTypeC          ProjectType = "c"
	ProjectTypePython     ProjectType = "python"
	ProjectTypeTypeScript ProjectType = "typescript"
	ProjectTypeJavaScript ProjectType = "javascript"
	ProjectTypeUnknown    ProjectType = "unknown"
)

// ServerConfig describes how to start and use an LSP server.
type ServerConfig struct {
	Command    string   // Executable name or path
	Args       []string // Command-line arguments
	LanguageID string   // LSP language identifier
	// InstallCommands are shell commands to install the LSP server if missing.
	// They are executed sequentially in the sandbox.
	InstallCommands []string
}

// projectIndicator describes files/patterns that indicate a project type.
type projectIndicator struct {
	files   []string      // Exact filenames to look for
	globs   []string      // Glob patterns for file extensions
	patterns []*regexp.Regexp // Pre-compiled regexps for globs
}

var projectIndicators = map[ProjectType]projectIndicator{
	ProjectTypeRust: {
		files: []string{"Cargo.toml", "Cargo.lock"},
		globs: []string{"*.rs"},
	},
	ProjectTypeGo: {
		files: []string{"go.mod", "go.work", "go.sum"},
		globs: []string{"*.go"},
	},
	ProjectTypeCpp: {
		files: []string{"CMakeLists.txt", "compile_commands.json", "compile_flags.txt", ".clangd", "meson.build"},
		globs: []string{"*.cpp", "*.cxx", "*.cc", "*.hpp", "*.hxx", "*.hh", "*.C", "*.H"},
	},
	ProjectTypeC: {
		files: []string{"Makefile", "configure", "configure.ac", "compile_commands.json", "compile_flags.txt"},
		globs: []string{"*.c", "*.h"},
	},
	ProjectTypePython: {
		files: []string{"pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock"},
		globs: []string{"*.py"},
	},
	ProjectTypeTypeScript: {
		files: []string{"tsconfig.json", "package.json"},
		globs: []string{"*.ts", "*.tsx"},
	},
	ProjectTypeJavaScript: {
		files: []string{"package.json", "jsconfig.json"},
		globs: []string{"*.js", "*.jsx", "*.mjs", "*.cjs"},
	},
}

var serverConfigs = map[ProjectType]ServerConfig{
	ProjectTypeRust: {
		Command:    "rust-analyzer",
		Args:       []string{},
		LanguageID: "rust",
		InstallCommands: []string{
			"curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
			"source $HOME/.cargo/env && rustup component add rust-analyzer",
		},
	},
	ProjectTypeGo: {
		Command:    "gopls",
		Args:       []string{},
		LanguageID: "go",
		InstallCommands: []string{
			"go install golang.org/x/tools/gopls@latest",
		},
	},
	ProjectTypeCpp: {
		Command:    "clangd",
		Args:       []string{"--background-index"},
		LanguageID: "cpp",
		InstallCommands: []string{
			"apt-get update && apt-get install -y clangd",
		},
	},
	ProjectTypeC: {
		Command:    "clangd",
		Args:       []string{"--background-index"},
		LanguageID: "c",
		InstallCommands: []string{
			"apt-get update && apt-get install -y clangd",
		},
	},
	ProjectTypePython: {
		Command:    "pyright-langserver",
		Args:       []string{"--stdio"},
		LanguageID: "python",
		InstallCommands: []string{
			"pip install pyright",
		},
	},
	ProjectTypeTypeScript: {
		Command:    "typescript-language-server",
		Args:       []string{"--stdio"},
		LanguageID: "typescript",
		InstallCommands: []string{
			"npm install -g typescript-language-server typescript",
		},
	},
	ProjectTypeJavaScript: {
		Command:    "typescript-language-server",
		Args:       []string{"--stdio"},
		LanguageID: "javascript",
		InstallCommands: []string{
			"npm install -g typescript-language-server typescript",
		},
	},
}

// DetectProjectType scans a directory to determine the project type.
// It returns the most confident match, or ProjectTypeUnknown if no match.
func DetectProjectType(dir string) ProjectType {
	// Priority order: check for project files first (high confidence),
	// then fall back to file extensions (lower confidence).

	// First pass: look for project-specific files
	for ptype, indicator := range projectIndicators {
		for _, filename := range indicator.files {
			path := filepath.Join(dir, filename)
			if fileExists(path) {
				return ptype
			}
		}
	}

	// Second pass: scan directory for file extensions
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ProjectTypeUnknown
	}

	extensionCounts := make(map[ProjectType]int)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		for ptype, indicator := range projectIndicators {
			for _, pattern := range indicator.globs {
				matched, _ := filepath.Match(pattern, name)
				if matched {
					extensionCounts[ptype]++
					break
				}
			}
		}
	}

	// Return the type with the most matching files
	var bestType ProjectType = ProjectTypeUnknown
	var bestCount int
	for ptype, count := range extensionCounts {
		if count > bestCount {
			bestType = ptype
			bestCount = count
		}
	}

	// Special case: if we found both .ts and .js, prefer TypeScript
	if extensionCounts[ProjectTypeTypeScript] > 0 && extensionCounts[ProjectTypeJavaScript] > 0 {
		return ProjectTypeTypeScript
	}

	// Special case: if we found both .cpp and .c, prefer C++
	if extensionCounts[ProjectTypeCpp] > 0 && extensionCounts[ProjectTypeC] > 0 {
		return ProjectTypeCpp
	}

	return bestType
}

// GetServerConfig returns the LSP server configuration for a project type.
func GetServerConfig(ptype ProjectType) (ServerConfig, bool) {
	config, ok := serverConfigs[ptype]
	return config, ok
}

// fileExists checks if a file exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
