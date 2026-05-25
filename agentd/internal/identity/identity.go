//go:build linux
// +build linux

package identity

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Resolve loads an existing node ID from disk or generates a new one.
func Resolve(idFile string) (string, error) {
	if idFile == "" {
		idFile = "/var/run/agentd.node_id"
	}
	dir := filepath.Dir(idFile)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create dir for node id: %w", err)
	}

	if data, err := os.ReadFile(idFile); err == nil {
		id := strings.TrimSpace(string(data))
		if id != "" {
			slog.Info("loaded existing node id", "node_id", id, "file", idFile)
			return id, nil
		}
	}

	id := generate()
	if err := os.WriteFile(idFile, []byte(id+"\n"), 0o644); err != nil {
		return "", fmt.Errorf("write node id file: %w", err)
	}
	slog.Info("generated new node id", "node_id", id, "file", idFile)
	return id, nil
}

func generate() string {
	hostname, _ := os.Hostname()
	return fmt.Sprintf("node-%s-%d", hostname, time.Now().UnixNano())
}
