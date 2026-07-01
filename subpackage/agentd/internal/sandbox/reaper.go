//go:build linux
// +build linux

package sandbox

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"
)

// agentdNamePrefix is the shared container-name prefix used by all three
// providers (docker.go: "agentd-{id}", docker_light.go: "agentd-light-{id}",
// lxc_persistent.go: "agentd-lxc-{id}"). Used to filter 'docker ps' output.
const agentdNamePrefix = "agentd-"

// ReapOrphans reconciles containers that exist on the host with what the
// sandbox store believes should exist. Called once at daemon startup,
// after Restore() has re-hydrated the in-memory map.
//
// Reconciliation outcomes:
//
//  1. Container exists on host, sandbox ID is in the store → no-op (the
//     container was left RUNNING across a daemon restart; LXC is fine
//     to leave running, docker-strict should be destroyed since the
//     daemon's in-memory session is gone too).
//  2. Container exists on host, sandbox ID is NOT in the store → orphan.
//     This happens after a `kill -9` or unclean shutdown. docker orphans
//     are destroyed; LXC orphans are stopped (rootfs preserved so the
//     next session can lxc-start them).
//  3. Sandbox ID is in the store, container is gone on host → stale
//     record. The store entry is removed (docker --rm already cleaned
//     up, or the operator manually destroyed it).
//
// Failures per-container are logged and skipped; one bad container does
// not abort the sweep.
func (m *Manager) ReapOrphans(ctx context.Context) error {
	if m == nil {
		return nil
	}

	dockerContainers, err := listDockerContainers(ctx)
	if err != nil {
		slog.Warn("reaper: docker list failed", "error", err)
		// Continue — LXC sweep is still useful.
	}
	lxcContainers, err := listLXCContainers(ctx)
	if err != nil {
		slog.Warn("reaper: lxc list failed", "error", err)
	}

	// Build a set of host-side containers keyed by name.
	hostNames := make(map[string]string) // name → "docker"|"lxc"
	for _, name := range dockerContainers {
		hostNames[name] = "docker"
	}
	for _, name := range lxcContainers {
		hostNames[name] = "lxc"
	}

	// Iterate store records and reconcile against host.
	records := m.store.List()
	if len(records) == 0 && len(hostNames) == 0 {
		return nil
	}

	// recordKeyedByPath maps sb.Path (which is the actual container name
	// for LXC or container ID for docker) → *SandboxRecord.
	recordKeyedByPath := make(map[string]*SandboxRecord, len(records))
	for _, rec := range records {
		recordKeyedByPath[rec.Path] = rec
	}

	// Phase 1: store records that have no matching host container → stale, remove from store.
	for _, rec := range records {
		if _, exists := hostNames[rec.Path]; !exists {
			// The sandbox's container is gone (docker --rm cleaned it up,
			// or operator destroyed it manually). Drop the stale record.
			slog.Info("reaper: removing stale record (container gone)", "id", rec.ID, "path", rec.Path, "type", rec.Type)
			if err := m.store.Remove(rec.ID); err != nil {
				slog.Warn("reaper: remove stale record failed", "id", rec.ID, "error", err)
			}
			m.mu.Lock()
			delete(m.sandboxes, rec.ID)
			m.mu.Unlock()
		}
	}

	// Phase 2: host containers that have no matching store record → orphan.
	for hostName, hostType := range hostNames {
		if _, tracked := recordKeyedByPath[hostName]; tracked {
			// Container is known. For docker-strict (no --rm), a RUNNING
			// container at startup means the daemon crashed mid-session
			// — destroy it, since its session is gone. For LXC, leave
			// running: a crashed daemon should not destroy persistent
			// workspaces; the user can attach to the LXC container again
			// or destroy it via sandbox_destroy.
			continue
		}
		slog.Info("reaper: orphan container found", "name", hostName, "type", hostType)
		switch hostType {
		case "docker":
			if err := destroyDockerContainer(ctx, hostName); err != nil {
				slog.Warn("reaper: destroy docker orphan failed", "name", hostName, "error", err)
			}
		case "lxc":
			// Stop, do not destroy — rootfs is preserved for re-attach.
			// An LXC container left RUNNING after a crash will resume
			// fine on the next lxc-start; but if the operator wants a
			// clean slate they can lxc-destroy manually.
			if err := stopLXCContainer(ctx, hostName); err != nil {
				slog.Warn("reaper: stop lxc orphan failed", "name", hostName, "error", err)
			}
		}
	}

	return nil
}

// listDockerContainers returns the names of all agentd-managed docker
// containers (running or stopped). Filters by the agentd- name prefix.
func listDockerContainers(ctx context.Context) ([]string, error) {
	cmd := exec.CommandContext(ctx, "docker", "ps", "-a",
		"--filter", "name="+agentdNamePrefix,
		"--format", "{{.Names}}",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("docker ps: %w (stderr: %s)", err, err.Error())
	}
	var names []string
	for _, line := range strings.Split(string(out), "\n") {
		name := strings.TrimSpace(line)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

// listLXCContainers returns the names of all agentd-managed LXC containers.
// Uses lxc-ls which lists both running and stopped containers.
func listLXCContainers(ctx context.Context) ([]string, error) {
	cmd := exec.CommandContext(ctx, "lxc-ls")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("lxc-ls: %w", err)
	}
	var names []string
	for _, field := range strings.Fields(string(out)) {
		name := strings.TrimSpace(field)
		if name == "" || !strings.HasPrefix(name, agentdNamePrefix) {
			continue
		}
		names = append(names, name)
	}
	return names, nil
}

// destroyDockerContainer force-removes a docker container by name.
func destroyDockerContainer(ctx context.Context, name string) error {
	cmd := exec.CommandContext(ctx, "docker", "rm", "-f", name)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker rm -f %s: %w (output: %s)", name, err, string(out))
	}
	return nil
}

// stopLXCContainer stops an LXC container by name (rootfs preserved).
func stopLXCContainer(ctx context.Context, name string) error {
	// Best-effort stop. We don't know the rootfsBase (-P) here, so rely on
	// the default search path. lxc-stop on an already-stopped container
	// returns non-zero; ignore that.
	cmd := exec.CommandContext(ctx, "lxc-stop", "-n", name)
	_, _ = cmd.CombinedOutput()
	return nil
}

// stopAllLXC stops every LXC container currently known to the manager.
// Used during daemon shutdown to leave rootfs intact for the next start.
func (m *Manager) stopAllLXC(ctx context.Context) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, sb := range m.sandboxes {
		if sb.Type != "lxc" || sb.Path == "" {
			continue
		}
		stop := func(name string) {
			cmd := exec.CommandContext(ctx, "lxc-stop", "-n", name)
			if out, err := cmd.CombinedOutput(); err != nil {
				slog.Warn("lxc-stop failed during shutdown",
					"name", name, "error", err, "output", string(out))
			}
		}
		stop(sb.Path)
	}
}

// destroyAllDocker destroys every docker / docker-strict container known
// to the manager. Used during daemon shutdown for non-persistent sandboxes
// (docker-strict has no --rm; the daemon crashing leaves them exited).
func (m *Manager) destroyAllDocker(ctx context.Context) {
	m.mu.RLock()
	type entry struct {
		id, path string
	}
	var entries []entry
	for _, sb := range m.sandboxes {
		if (sb.Type == "docker" || sb.Type == "docker-strict") && sb.Path != "" {
			entries = append(entries, entry{sb.ID, sb.Path})
		}
	}
	m.mu.RUnlock()

	for _, e := range entries {
		cmd := exec.CommandContext(ctx, "docker", "rm", "-f", e.path)
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Warn("docker rm failed during shutdown",
				"id", e.id, "path", e.path, "error", err, "output", string(out))
		} else {
			if m.store != nil {
				if err := m.store.Remove(e.id); err != nil {
					slog.Warn("store remove failed during shutdown", "id", e.id, "error", err)
				}
			}
			m.mu.Lock()
			delete(m.sandboxes, e.id)
			m.mu.Unlock()
			slog.Info("docker container destroyed on shutdown", "id", e.id)
		}
	}
}

// awaitCmdTimeout is a conservative default for the shutdown sweep. We
// never want a stuck container to block daemon shutdown indefinitely.
var awaitCmdTimeout = 30 * time.Second
