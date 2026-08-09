package sandbox

import (
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
func (l *WorkspaceLock) TryAcquire(
	holderType, execSessionID string,
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
		// Held by someone else.
		return l.state, false, nil
	}

	// Either free or re-entrant by the same exec session.
	var expiresAt time.Time
	if ttl > 0 {
		expiresAt = now.Add(ttl)
	}
	l.state = &WorkspaceLockState{
		WorkspaceID:    l.state.WorkspaceID, // preserved across re-entrant
		HolderType:     holderType,
		ExecSessionID:  execSessionID,
		OwnerTaskID:    ownerTaskID,
		NodeGeneration: nodeGeneration,
		AcquiredAt:     now,
		ExpiresAt:      expiresAt,
	}
	if l.state.WorkspaceID == "" {
		// First acquire has no workspace id stamped yet — caller fills via state.
	}
	return l.state, true, nil
}

// Release frees the lock, but only if the caller's execSessionID matches
// the current holder. A mismatched release is a no-op (returns false) so
// one run can't accidentally release another's lock. Returns true when the
// lock was actually released.
func (l *WorkspaceLock) Release(execSessionID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.state == nil {
		return false
	}
	if l.state.ExecSessionID != execSessionID {
		return false
	}
	l.state = nil
	return true
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

// Snapshot returns the current holder state for a workspace (nil if free
// or unknown). Used by the HTTP release/inspect endpoints.
func (r *WorkspaceLockRegistry) Snapshot(workspaceID string) *WorkspaceLockState {
	lock := r.Get(workspaceID)
	if lock == nil {
		return nil
	}
	return lock.State()
}
