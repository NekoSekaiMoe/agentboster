package sandbox

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// WorkspaceLockState is the snapshot returned by TryAcquire observers
// (e.g. for the /workspaces/:id/lock HTTP endpoint). It carries enough
// info for the Web layer to render a "busy, held by X since Y" message.
type WorkspaceLockState struct {
	WorkspaceID    string    `json:"workspace_id"`
	HolderType     string    `json:"holder_type"` // "chat_run" | "async_task"
	ExecSessionID  string    `json:"exec_session_id"`
	OwnerTaskID    string    `json:"owner_task_id,omitempty"`
	NodeGeneration uint64    `json:"node_generation"`
	AcquiredAt     time.Time `json:"acquired_at"`
	ExpiresAt      time.Time `json:"expires_at"`
}

// WorkspaceLock serializes access to a workspace's long-lived container at
// the execution-session (run) granularity. Only one execution session may
// hold the lock at a time; a second TryAcquire returns the current holder
// so the caller can surface a "busy" signal.
//
// M1: holder-aware upgrade of the M0b mutex. The lock lives in agentd
// memory (it's the only process that touches the container); Web-side
// workspaces.node_generation is the fencing token that lets a stale agentd
// detect it no longer owns the container after a failover.
//
// Not a sync.Locker — the contract is TryAcquire/Release with holder
// identity, not Lock/Unlock. The M0b ExecLockFor path still returns a
// sync.Mutex so the executeTool serialization keeps working unchanged;
// this WorkspaceLock layers holder/ttl/generation on top for the HTTP
// acquire/release endpoints.
type WorkspaceLock struct {
	mu    sync.Mutex
	state *WorkspaceLockState
}

// NewWorkspaceLock returns an unlocked WorkspaceLock.
func NewWorkspaceLock() *WorkspaceLock {
	return &WorkspaceLock{}
}

// TryAcquire attempts to take the lock for (holderType, execSessionID).
// Returns (state, true, nil) on success. When the lock is held by a
// different exec session, returns the current holder state with ok=false
// and a nil error — the caller translates that into an HTTP 409 busy.
//
// workspaceID is injected by the registry on acquire and stamped into the
// state so the returned snapshot carries the workspace even on a FIRST
// acquire (previously the struct literal read l.state.WorkspaceID while
// l.state was still nil, dereferencing a nil pointer and panicking on the
// very first acquire of a freshly-created or TTL-reaped lock).
//
// Re-entrant acquire by the SAME exec session is a no-op success (returns
// the existing state); this covers a run that calls acquire twice
// defensively without deadlocking itself.
//
// ttl is the duration after which the lock is considered leaked (run
// crashed without Release) and the next TryAcquire may steal it. ttl<=0
// disables expiry (use only for testing).
//
// nodeGeneration is the Web-side fencing token at acquire time. It's
// stamped into the state so a later request carrying a higher generation
// (post-failover) can recognize this lock as stale.
//
// The returned *WorkspaceLockState is a COPY of the internal state, so
// callers cannot observe concurrent mutation (matches State()'s defensive
// copy; previously this method returned the live internal pointer).
func (l *WorkspaceLock) TryAcquire(
	workspaceID, holderType, execSessionID string,
	ownerTaskID string,
	ttl time.Duration,
	nodeGeneration uint64,
	now time.Time,
) (*WorkspaceLockState, bool, error) {
	if execSessionID == "" {
		return nil, false, fmt.Errorf("exec_session_id is required")
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.state != nil {
		// Expired? Stealable.
		if ttl > 0 && !l.state.ExpiresAt.IsZero() && now.After(l.state.ExpiresAt) {
			l.state = nil
		}
	}
	if l.state != nil && l.state.ExecSessionID != execSessionID {
		// Held by someone else — return a COPY so the caller can't observe
		// later mutation of l.state.
		s := *l.state
		return &s, false, nil
	}

	// Either free or re-entrant by the same exec session.
	var expiresAt time.Time
	if ttl > 0 {
		expiresAt = now.Add(ttl)
	}
	// Preserve a prior workspace id across re-entrant acquire; fall back to
	// the injected workspaceID on a fresh acquire (was previously read from
	// a nil l.state, causing a panic).
	wsID := workspaceID
	if l.state != nil && l.state.WorkspaceID != "" {
		wsID = l.state.WorkspaceID
	}
	l.state = &WorkspaceLockState{
		WorkspaceID:    wsID,
		HolderType:     holderType,
		ExecSessionID:  execSessionID,
		OwnerTaskID:    ownerTaskID,
		NodeGeneration: nodeGeneration,
		AcquiredAt:     now,
		ExpiresAt:      expiresAt,
	}
	// Return a COPY, not the internal pointer.
	s := *l.state
	return &s, true, nil
}

// Release frees the lock, but only if the caller's execSessionID matches
// the current holder. A mismatched release is a no-op (returns false) so
// one run can't accidentally release another's lock. Returns true when the
// lock was actually released.
func (l *WorkspaceLock) Release(execSessionID string) bool {
	released, _ := l.ReleaseWithGeneration(execSessionID, nil)
	return released
}

// ErrStaleGeneration is returned by ReleaseWithGeneration when the
// caller-supplied node_generation does not match the generation recorded
// at acquire time — a fencing violation (a stale holder trying to release
// a lock that was re-acquired under a newer generation after failover).
var ErrStaleGeneration = errors.New("stale node_generation")

// ReleaseWithGeneration is Release with optional generation fencing.
// When nodeGeneration is nil the behavior is identical to Release
// (legacy callers). When non-nil, the release is rejected with
// ErrStaleGeneration (released=false, lock stays held) unless it matches
// the NodeGeneration stamped at TryAcquire time.
func (l *WorkspaceLock) ReleaseWithGeneration(execSessionID string, nodeGeneration *uint64) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == nil {
		return false, nil
	}
	if l.state.ExecSessionID != execSessionID {
		return false, nil
	}
	if nodeGeneration != nil && *nodeGeneration != l.state.NodeGeneration {
		return false, fmt.Errorf("%w: lock acquired at generation %d, release sent %d",
			ErrStaleGeneration, l.state.NodeGeneration, *nodeGeneration)
	}
	l.state = nil
	return true, nil
}

// State returns a snapshot of the current holder, or nil when unlocked.
func (l *WorkspaceLock) State() *WorkspaceLockState {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == nil {
		return nil
	}
	s := *l.state
	return &s
}

// WorkspaceLockRegistry owns the per-workspace WorkspaceLock instances.
// Lazy creation on first acquire. The registry is process-local (agentd
// is the only container owner); Web-side node_generation is the fencing
// token that bridges failover across nodes.
type WorkspaceLockRegistry struct {
	mu    sync.Mutex
	locks map[string]*WorkspaceLock
}

// NewWorkspaceLockRegistry returns an empty registry.
func NewWorkspaceLockRegistry() *WorkspaceLockRegistry {
	return &WorkspaceLockRegistry{locks: make(map[string]*WorkspaceLock)}
}

// Get returns (lazily creating) the WorkspaceLock for a workspace.
func (r *WorkspaceLockRegistry) Get(workspaceID string) *WorkspaceLock {
	if workspaceID == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[workspaceID]
	if !ok {
		lock = NewWorkspaceLock()
		r.locks[workspaceID] = lock
	}
	return lock
}

// lookup returns the existing lock WITHOUT creating one. Used by read-only
// paths (Snapshot) so probing an unknown workspace doesn't pollute the
// registry with empty entries that are never deleted.
func (r *WorkspaceLockRegistry) lookup(workspaceID string) *WorkspaceLock {
	if workspaceID == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.locks[workspaceID]
}

// Snapshot returns the current holder state for a workspace (nil if free
// or unknown). Used by the HTTP release/inspect endpoints. Does NOT create
// a registry entry for unknown workspaces.
func (r *WorkspaceLockRegistry) Snapshot(workspaceID string) *WorkspaceLockState {
	lock := r.lookup(workspaceID)
	if lock == nil {
		return nil
	}
	return lock.State()
}

// DeleteIfReleased removes the registry entry for workspaceID when its
// lock is currently free (state == nil). Returns true when an entry was
// deleted. Active locks are preserved.
//
// The check-and-delete is atomic with respect to TryAcquire on the same
// lock instance (both take l.mu). A TryAcquire that already captured the
// *WorkspaceLock pointer before the deletion may still acquire the old
// instance afterwards — the same accepted trade-off documented on
// Manager.cleanupWorkspaceEntriesLocked for execLocks: the acquirer gets
// a working lock whose holder state is simply no longer reachable via the
// registry, rather than corrupted state.
func (r *WorkspaceLockRegistry) DeleteIfReleased(workspaceID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, ok := r.locks[workspaceID]
	if !ok {
		return false
	}
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.state != nil {
		return false
	}
	delete(r.locks, workspaceID)
	return true
}

// CleanupReleased sweeps the registry and deletes every entry whose lock
// is free (state == nil) OR whose state is non-nil but EXPIRED, using the
// same expiry semantics as TryAcquire: ExpiresAt is only stamped when a
// ttl was set at acquire time, so a non-zero ExpiresAt in the past means
// the lock leaked (run crashed without Release) and is stealable. Locks
// with a zero ExpiresAt (acquired with ttl<=0) never expire, mirroring
// TryAcquire's ttl>0 gate. `now` is injected for testability (pass
// time.Now() in production).
//
// Returns the number of entries removed (released + expired). Active,
// unexpired locks are preserved. See DeleteIfReleased for the
// check-and-delete atomicity contract.
func (r *WorkspaceLockRegistry) CleanupReleased(now time.Time) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := 0
	for workspaceID, lock := range r.locks {
		lock.mu.Lock()
		free := lock.state == nil ||
			(!lock.state.ExpiresAt.IsZero() && now.After(lock.state.ExpiresAt))
		lock.mu.Unlock()
		if free {
			delete(r.locks, workspaceID)
			removed++
		}
	}
	return removed
}
