//go:build linux
// +build linux

package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
)

// Workspace subdirectories — standardized layout inspired by CyberGroupmate's workspace design.
// Each sandbox type (chroot/tmpfs/docker) calls InitWorkspaceLayout after creating the base directory.
const (
	WorkspaceDir     = "workspace"
	SkillsDir        = "workspace/skills"
	DownloadsDir     = "workspace/downloads"
	PhotosDir        = "workspace/downloads/photos"
	VideosDir        = "workspace/downloads/videos"
	DocumentsDir     = "workspace/downloads/documents"
	MediaDir         = "workspace/media"
	SessionsDir      = "workspace/sessions"
	MemoryDir        = "workspace/memory"
	OutputsDir       = "workspace/outputs"
	ProjectsDir      = "workspace/projects"
	BinDir           = "workspace/bin"
	LocalDir         = "workspace/.local"
	LocalBinDir      = "workspace/.local/bin"
)

// workspaceSubdirs is the full list of subdirectories to create inside the sandbox root.
var workspaceSubdirs = []string{
	"workspace/skills",
	"workspace/downloads/photos",
	"workspace/downloads/videos",
	"workspace/downloads/documents",
	"workspace/media",
	"workspace/sessions",
	"workspace/memory",
	"workspace/outputs",
	"workspace/projects",
	"workspace/bin",
	"workspace/.local/bin",
}

// InitWorkspaceLayout creates the standardized workspace subdirectory structure
// inside the given sandbox root path. Safe to call multiple times (idempotent).
func InitWorkspaceLayout(sandboxRoot string) error {
	for _, subdir := range workspaceSubdirs {
		path := filepath.Join(sandboxRoot, subdir)
		if err := os.MkdirAll(path, 0o755); err != nil {
			return fmt.Errorf("create workspace subdir %s: %w", path, err)
		}
	}
	return nil
}

// WorkspaceRoot returns the absolute path to the workspace directory
// given a sandbox root path and sandbox type.
func WorkspaceRoot(sandboxRoot, sandboxType string) string {
	if sandboxType == "docker" {
		return "/" + WorkspaceDir
	}
	return filepath.Join(sandboxRoot, WorkspaceDir)
}
