//go:build linux
// +build linux

package sandbox

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MediaCategory represents the type of media file.
type MediaCategory string

const (
	CategoryPhotos    MediaCategory = "photos"
	CategoryVideos    MediaCategory = "videos"
	CategoryDocuments MediaCategory = "documents"
	CategoryOther     MediaCategory = "other"
)

// MediaFileInfo describes a saved media file.
type MediaFileInfo struct {
	Path      string        `json:"path"`
	Category  MediaCategory `json:"category"`
	Size      int64         `json:"size"`
	MimeType  string        `json:"mime_type,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
}

// MediaManager manages media files within a sandbox workspace.
type MediaManager struct {
	mu          sync.RWMutex
	workspace   string // absolute path to workspace root
	manifest    map[string]string // filename → absolute path
	manifestPath string
}

// NewMediaManager creates a media manager for the given sandbox workspace.
func NewMediaManager(workspacePath string) *MediaManager {
	return &MediaManager{
		workspace:    workspacePath,
		manifest:     make(map[string]string),
		manifestPath: filepath.Join(workspacePath, ".media-manifest.json"),
	}
}

// Init creates the media/download directory structure.
func (m *MediaManager) Init() error {
	dirs := []string{
		filepath.Join(m.workspace, "downloads", "photos"),
		filepath.Join(m.workspace, "downloads", "videos"),
		filepath.Join(m.workspace, "downloads", "documents"),
		filepath.Join(m.workspace, "media"),
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create media dir %s: %w", dir, err)
		}
	}
	return nil
}

// SaveMedia saves a media file to the appropriate category directory.
func (m *MediaManager) SaveMedia(data []byte, filename string, mimeType string, category MediaCategory) (*MediaFileInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	catDir := filepath.Join(m.workspace, "downloads", string(category))
	if err := os.MkdirAll(catDir, 0o755); err != nil {
		return nil, fmt.Errorf("create category dir: %w", err)
	}

	// Sanitize filename
	safeName := sanitizeFilename(filename)
	destPath := filepath.Join(catDir, safeName)

	if err := os.WriteFile(destPath, data, 0o640); err != nil {
		return nil, fmt.Errorf("write media file: %w", err)
	}

	info := &MediaFileInfo{
		Path:      destPath,
		Category:  category,
		Size:      int64(len(data)),
		MimeType:  mimeType,
		CreatedAt: time.Now(),
	}

	m.manifest[safeName] = destPath
	m.saveManifestUnsafe()

	slog.Info("media saved", "path", destPath, "size", info.Size, "category", category)
	return info, nil
}

// ListMedia returns all media files, optionally filtered by category.
func (m *MediaManager) ListMedia(category MediaCategory) []MediaFileInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var results []MediaFileInfo
	baseDir := filepath.Join(m.workspace, "downloads")

	categories := []MediaCategory{category}
	if category == "" {
		categories = []MediaCategory{CategoryPhotos, CategoryVideos, CategoryDocuments, CategoryOther}
	}

	for _, cat := range categories {
		catDir := filepath.Join(baseDir, string(cat))
		entries, err := os.ReadDir(catDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			results = append(results, MediaFileInfo{
				Path:      filepath.Join(catDir, entry.Name()),
				Category:  cat,
				Size:      info.Size(),
				CreatedAt: info.ModTime(),
			})
		}
	}

	return results
}

// CleanupExpired removes media files older than retentionDays.
// Returns the number of files removed.
func (m *MediaManager) CleanupExpired(retentionDays int) int {
	m.mu.Lock()
	defer m.mu.Unlock()

	cutoff := time.Now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	removed := 0

	baseDir := filepath.Join(m.workspace, "downloads")
	for _, cat := range []MediaCategory{CategoryPhotos, CategoryVideos, CategoryDocuments, CategoryOther} {
		catDir := filepath.Join(baseDir, string(cat))
		entries, err := os.ReadDir(catDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			if info.ModTime().Before(cutoff) {
				path := filepath.Join(catDir, entry.Name())
				if err := os.Remove(path); err == nil {
					delete(m.manifest, entry.Name())
					removed++
					slog.Info("media cleanup: removed expired file", "path", path, "age", time.Since(info.ModTime()).Hours()/24)
				}
			}
		}
	}

	if removed > 0 {
		m.saveManifestUnsafe()
	}

	return removed
}

// MediaJSON returns a JSON summary of all media files.
func (m *MediaManager) MediaJSON(category MediaCategory) (string, error) {
	files := m.ListMedia(category)
	data, err := json.MarshalIndent(files, "", "  ")
	if err != nil {
		return "", fmt.Errorf("marshal media list: %w", err)
	}
	return string(data), nil
}

// GetMediaPath returns the absolute path for a media filename.
func (m *MediaManager) GetMediaPath(filename string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if path, ok := m.manifest[filename]; ok {
		return path
	}
	return ""
}

// saveManifestUnsafe writes the manifest to disk. Must be called with lock held.
func (m *MediaManager) saveManifestUnsafe() {
	data, err := json.MarshalIndent(m.manifest, "", "  ")
	if err != nil {
		slog.Warn("media manifest marshal failed", "error", err)
		return
	}
	if err := os.WriteFile(m.manifestPath, data, 0o640); err != nil {
		slog.Warn("media manifest write failed", "error", err)
	}
}

// CategorizeMediaType maps a MIME type or media type string to a MediaCategory.
func CategorizeMediaType(mediaType string) MediaCategory {
	switch strings.ToLower(mediaType) {
	case "photo", "image":
		return CategoryPhotos
	case "video":
		return CategoryVideos
	case "document", "pdf", "file":
		return CategoryDocuments
	default:
		return CategoryOther
	}
}

func sanitizeFilename(name string) string {
	// Remove path separators and other dangerous characters
	name = strings.ReplaceAll(name, "/", "_")
	name = strings.ReplaceAll(name, "\\", "_")
	name = strings.ReplaceAll(name, "..", "_")
	// Limit length
	if len(name) > 200 {
		name = name[:200]
	}
	return name
}
