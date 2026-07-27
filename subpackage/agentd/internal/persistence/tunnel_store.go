//go:build linux

// Package persistence — tunnel_store.go
//
// Disk-backed registry of public tunnels (ref_liveagent §2.2 follow-up).
//
// Why persist tunnels when the underlying TCP relay is in-memory?
//   agentd restarts for OS updates / config reloads. A developer who
//   shared a preview URL shouldn't have it 404 just because the daemon
//   cycled — the sandbox is still running, the service still answers on
//   its internal port, so the only thing that disappeared is the slug→
//   (sandbox,port) mapping. Persisting that small mapping to disk and
//   re-loading it on startup lets the same URL keep working.
//
// Shape: identical to BackgroundTaskStore — a KeyValueStore[TunnelRecord]
// wrapper with a small domain API. The store file lives under
// <dataDir>/tunnels/ alongside background_tasks/, and is restored once
// on daemon startup (Manager.Restore path) the same way the background
// task store is.
//
// What is NOT persisted: open TCP connections. Even with the registry
// restored, in-flight relay goroutines die with the process — that's
// inherent to a stateless TCP proxy. Clients reconnect and pick up a
// fresh relay on the same slug, which is the desired behavior.
package persistence

import (
	"path/filepath"
	"time"
)

// TunnelRecord is one public→sandbox tunnel. Persisted to disk so the
// slug stays valid across daemon restarts. The relay itself is rebuilt
// on each connect, so the persisted record only needs to carry enough
// to redial the backend.
type TunnelRecord struct {
	ID         string    `json:"id"`
	Slug       string    `json:"slug"`
	SessionID  string    `json:"session_id"`
	SandboxID  string    `json:"sandbox_id"`
	TargetPort int       `json:"target_port"`
	// TargetHost is a HINT from create-time. Sandboxes can change IPs
	// across restarts, so the relay re-resolves via sbMgr.ContainerIP on
	// every connect; this field is only used for diagnostics / logging.
	TargetHost string    `json:"target_host"`
	CreatedAt  time.Time `json:"created_at"`
	// LastActivity is updated on each connect and read by the idle reaper
	// to garbage-collect tunnels nobody has used recently. The reaper
	// removes the record from the store; in-flight connections finish on
	// their own (we don't kill them mid-stream).
	LastActivity time.Time `json:"last_activity"`
}

// TunnelStore persists tunnel records to disk via KeyValueStore.
type TunnelStore struct {
	kv *KeyValueStore[TunnelRecord]
}

// NewTunnelStore creates a store rooted at <dir>/tunnels/. Pass an empty
// dir for a purely in-memory store (testing only — production wants
// persistence so slugs survive restarts).
func NewTunnelStore(dir string) (*TunnelStore, error) {
	kv, err := NewKeyValueStore(dir, "tunnels", func(t *TunnelRecord) string {
		// Key by slug, not ID: every lookup path (connect, delete-by-slug)
		// arrives with the slug, and the URL is built from the slug. The
		// ID is just a stable handle for the REST API's DELETE path.
		return t.Slug
	})
	if err != nil {
		return nil, err
	}
	return &TunnelStore{kv: kv}, nil
}

// TunnelPath returns the on-disk directory for tunnel records, mirroring
// BackgroundTaskPath. Called by main.go to thread the data dir in.
func TunnelPath(base string) string {
	return filepath.Join(base, "tunnels")
}

// Save persists a tunnel record.
func (s *TunnelStore) Save(t *TunnelRecord) error { return s.kv.Save(t) }

// Remove deletes a tunnel record by slug.
func (s *TunnelStore) Remove(slug string) error { return s.kv.Remove(slug) }

// Load returns the tunnel record for a slug (or false when unknown).
func (s *TunnelStore) Load(slug string) (*TunnelRecord, bool) { return s.kv.Load(slug) }

// ListAll returns every persisted tunnel.
func (s *TunnelStore) ListAll() []*TunnelRecord { return s.kv.ListAll() }

// ListWhere returns tunnels matching the predicate.
func (s *TunnelStore) ListWhere(pred func(*TunnelRecord) bool) []*TunnelRecord {
	return s.kv.ListWhere(pred)
}

// Restore re-loads tunnel records from disk. Call once at daemon startup
// before the HTTP server starts accepting traffic.
func (s *TunnelStore) Restore() error { return s.kv.Restore() }
