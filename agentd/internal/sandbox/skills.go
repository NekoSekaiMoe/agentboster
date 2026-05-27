//go:build linux
// +build linux

package sandbox

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// SkillInfo describes a discovered skill in the workspace.
type SkillInfo struct {
	Name       string    `json:"name"`
	Path       string    `json:"path"`        // absolute path: {rootFS}/workspace/skills/{name}
	HasSKILLMD bool      `json:"has_skill_md"` // has SKILL.md
	HasEntry   bool      `json:"has_entry"`    // has entry script (index.ts, index.sh, etc.)
	HasDeps    bool      `json:"has_deps"`     // has package.json or requirements.txt
	InstalledAt time.Time `json:"installed_at"`
}

// DiscoverSkills scans the workspace/skills directory and returns all discovered skills.
func DiscoverSkills(rootFS string) []SkillInfo {
	skillsDir := filepath.Join(rootFS, SkillsDir)
	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		return nil
	}

	var skills []SkillInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name == "node_modules" || name == ".git" || name[0] == '.' {
			continue
		}

		skillPath := filepath.Join(skillsDir, name)
		info := SkillInfo{
			Name: name,
			Path: skillPath,
		}

		// Check for SKILL.md
		if _, err := os.Stat(filepath.Join(skillPath, "SKILL.md")); err == nil {
			info.HasSKILLMD = true
		}

		// Check for entry scripts
		for _, entryFile := range []string{"index.ts", "index.js", "index.sh", "main.sh", "main.py"} {
			if _, err := os.Stat(filepath.Join(skillPath, entryFile)); err == nil {
				info.HasEntry = true
				break
			}
		}

		// Check for dependency files
		for _, depFile := range []string{"package.json", "requirements.txt", "go.mod", "Cargo.toml"} {
			if _, err := os.Stat(filepath.Join(skillPath, depFile)); err == nil {
				info.HasDeps = true
				break
			}
		}

		// Get install time from directory mod time
		if dirInfo, err := entry.Info(); err == nil {
			info.InstalledAt = dirInfo.ModTime()
		}

		skills = append(skills, info)
	}

	return skills
}

// EnsureSkillDir creates a skill directory with a README placeholder.
func EnsureSkillDir(rootFS, skillName string) (string, error) {
	skillPath := filepath.Join(rootFS, SkillsDir, skillName)
	if err := os.MkdirAll(skillPath, 0o755); err != nil {
		return "", fmt.Errorf("create skill dir: %w", err)
	}
	return skillPath, nil
}

// SkillDepsInstall installs dependencies for a skill.
// For npm skills: runs npm install in the skill directory.
// For pip skills: runs pip install -r requirements.txt.
func SkillDepsInstall(rootFS, skillName, manager string) (string, error) {
	skillPath := filepath.Join(rootFS, SkillsDir, skillName)

	switch manager {
	case "npm":
		reqFile := filepath.Join(skillPath, "package.json")
		if _, err := os.Stat(reqFile); os.IsNotExist(err) {
			return "", fmt.Errorf("no package.json found in skill %s", skillName)
		}
		return fmt.Sprintf("cd %s && npm install --production 2>&1", skillPath), nil

	case "pip":
		reqFile := filepath.Join(skillPath, "requirements.txt")
		if _, err := os.Stat(reqFile); os.IsNotExist(err) {
			return "", fmt.Errorf("no requirements.txt found in skill %s", skillName)
		}
		return fmt.Sprintf("pip install -r %s 2>&1", filepath.Join(skillPath, "requirements.txt")), nil

	default:
		return "", fmt.Errorf("unsupported dependency manager: %s", manager)
	}
}

// SkillsJSON returns a JSON summary of all discovered skills.
func SkillsJSON(rootFS string) (string, error) {
	skills := DiscoverSkills(rootFS)
	data, err := json.MarshalIndent(skills, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal skills: %w", err)
	}
	return string(data), nil
}

var _ = slog.Info // ensure slog import is used
