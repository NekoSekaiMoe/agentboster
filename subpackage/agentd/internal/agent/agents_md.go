package agent

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// agentsMdRecommendedMaxBytes is the soft budget for combined AGENTS.md content
// injected into the system prompt. Mirrors kimi-code's budget: large enough to
// leave the bulk of the context window to the conversation while still catching
// accidental oversized instruction files. Exceeding it does not truncate; it
// only surfaces a user-visible warning so the user can trim.
const agentsMdRecommendedMaxBytes = 32 * 1024

// LoadAgentsMdResult is the output of LoadAgentsMd.
type LoadAgentsMdResult struct {
	// Content is the merged AGENTS.md content, ready for prompt injection.
	// Empty when no candidates were found.
	Content string
	// Warning is a non-empty user-facing message when Content exceeds the
	// recommended budget. Empty otherwise.
	Warning string
}

// LoadAgentsMd discovers and merges AGENTS.md files for an agent session.
// Discovery order (first seen wins; user-level files are collected before
// project-level so a deeper project file does not shadow a global user file
// — both are kept):
//
//  1. User-level branded: <brandHome>/AGENTS.md (brandHome is typically the
//     agentboster config dir, e.g. ~/.agentboster). Skipped when brandHome is
//     empty.
//  2. User-level generic: <realHome>/.agents/AGENTS.md
//  3. Project-level: for each directory from sandboxPath up to the project
//     root (the nearest ancestor containing .git, defaulting to sandboxPath
//     itself when no .git is found), collect AGENTS.md. Order is root→leaf
//     so the more specific (deeper) file comes last in the merged output.
//
// Only the exact filename "AGENTS.md" is recognized; lowercase or CLAUDE.md
// variants are intentionally ignored to keep the contract uniform with the
// web/CLI side.
//
// sandboxPath is the absolute path inside the sandbox that the agent treats as
// its cwd. When empty, no project-level files are scanned and only user-level
// files are considered. brandHome and realHome may be empty; empty values skip
// the corresponding tier.
func LoadAgentsMd(sandboxPath, brandHome, realHome string) LoadAgentsMdResult {
	var discovered []agentFile
	seen := make(map[string]struct{})

	collect := func(path string) {
		if path == "" {
			return
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return
		}
		norm := filepath.Clean(abs)
		if _, ok := seen[norm]; ok {
			return
		}
		file, ok := readAgentFile(norm)
		if !ok {
			return
		}
		seen[norm] = struct{}{}
		discovered = append(discovered, file)
	}

	// 1. User-level branded.
	collect(filepath.Join(brandHome, "AGENTS.md"))

	// 2. User-level generic (.agents).
	if realHome != "" {
		collect(filepath.Join(realHome, ".agents", "AGENTS.md"))
	}

	// 3. Project-level (sandboxPath up to project root).
	if sandboxPath != "" {
		absSandbox, err := filepath.Abs(sandboxPath)
		if err == nil {
			projectRoot := findProjectRoot(absSandbox)
			for _, dir := range dirsRootToLeaf(absSandbox, projectRoot) {
				collect(filepath.Join(dir, "AGENTS.md"))
			}
		}
	}

	content := renderAgentFiles(discovered)
	warning := ""
	if len(content) > agentsMdRecommendedMaxBytes {
		warning = "AGENTS.md total " + formatKB(len(content)) + " KB exceeds the recommended " +
			formatKB(agentsMdRecommendedMaxBytes) + " KB. Large instruction files increase cost " +
			"and may impact performance; consider trimming."
	}
	return LoadAgentsMdResult{Content: content, Warning: warning}
}

type agentFile struct {
	path    string
	content string
}

// agentBosterBrandHome returns the brand-scoped config dir used for the
// user-level AGENTS.md lookup. Defaults to ~/.agentboster to match the CLI's
// config dir (cli/AGENTS.md: ~/.agentboster/config.json). The AGENTBOSTER_HOME
// env var overrides it for tests and self-hosted setups that relocate the dir.
func agentBosterBrandHome() string {
	if v := os.Getenv("AGENTBOSTER_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".agentboster")
}

// readAgentFile reads and trims an AGENTS.md file. Returns (file, false) when
// the path is missing, not a regular file, or empty after trimming.
func readAgentFile(path string) (agentFile, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return agentFile{}, false
	}
	if !info.Mode().IsRegular() {
		return agentFile{}, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return agentFile{}, false
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return agentFile{}, false
	}
	return agentFile{path: path, content: trimmed}, true
}

// findProjectRoot walks up from start until it finds a directory containing a
// .git entry, returning that directory. If no .git is found, returns start
// unchanged. Symlinks on the path are not resolved; this matches how the agent
// itself addresses the sandbox.
func findProjectRoot(start string) string {
	current := filepath.Clean(start)
	for {
		if _, err := os.Lstat(filepath.Join(current, ".git")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return filepath.Clean(start)
		}
		current = parent
	}
}

// dirsRootToLeaf returns the chain of directories from the project root down
// to (and including) workDir. Each directory appears once. When workDir is
// above the project root (which should not happen in practice because
// findProjectRoot defaults to start when no .git is found), the result is
// just [workDir].
func dirsRootToLeaf(workDir, projectRoot string) []string {
	workDir = filepath.Clean(workDir)
	projectRoot = filepath.Clean(projectRoot)
	if projectRoot == workDir {
		return []string{workDir}
	}
	// Ensure projectRoot is an ancestor of workDir.
	rel, err := filepath.Rel(projectRoot, workDir)
	if err != nil || strings.HasPrefix(rel, "..") {
		return []string{workDir}
	}

	var chain []string
	current := workDir
	for {
		chain = append(chain, current)
		if current == projectRoot {
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	// Reverse so root comes first.
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain
}

func renderAgentFiles(files []agentFile) string {
	if len(files) == 0 {
		return ""
	}
	var b strings.Builder
	for i, f := range files {
		if i > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("<!-- From: ")
		b.WriteString(f.path)
		b.WriteString(" -->\n")
		b.WriteString(f.content)
	}
	return b.String()
}

func formatKB(bytes int) string {
	kb := float64(bytes) / 1024
	// Mirror kimi-code: integers render without decimals, fractional values use
	// one decimal place.
	if kb == float64(int(kb)) {
		return strconv.FormatFloat(kb, 'f', 0, 64)
	}
	return strconv.FormatFloat(kb, 'f', 1, 64)
}
