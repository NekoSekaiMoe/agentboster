//go:build linux

package sandbox

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// Sentinel errors for categorized sandbox Exec failures. Callers that
// need to distinguish failure modes (e.g. desktop.probeHealth, the agent
// runScript wrapper) can test with errors.Is. The providers still return
// (result, nil) for non-zero exits — preserving legacy behavior for the
// ~30 existing callers that assume err==nil implies a usable result — but
// also populate result.Err so new/updated callers can branch on cause.
//
// The categorization matters because the pre-P8 Exec collapsed four
// fundamentally different failures into ExitCode=-1 + nil error:
//   - sandbox/container gone (restart, destroy, host crash)
//   - timeout (context deadline)
//   - exec binary missing (lxc-attach/docker CLI not on host)
//   - command ran and exited non-zero (a normal business error)
//
// All four were indistinguishable, which broke self-healing logic that
// needed to tell "container is gone, recreate it" from "my grep returned
// 1 because no matches".
var (
	// ErrSandboxNotFound indicates the sandbox/container does not exist
	// (destroyed, never created, host restarted). Retry requires creating
	// a new sandbox, not re-running the command.
	ErrSandboxNotFound = errors.New("sandbox not found")

	// ErrCommandTimeout indicates the command exceeded its timeout. The
	// sandbox itself is still alive; the caller may retry with a longer
	// timeout or a different command.
	ErrCommandTimeout = errors.New("command timed out")

	// ErrExecBinaryMissing indicates the host-side exec client (lxc-attach,
	// docker) was not found on the daemon's PATH. This is a daemon
	// misconfiguration, not a sandbox problem.
	ErrExecBinaryMissing = errors.New("exec client binary not found")

	// ErrNonZeroExit indicates the command ran and exited with a non-zero
	// status. This is a normal business error; ExitCode holds the value.
	ErrNonZeroExit = errors.New("command exited non-zero")
)

// classifyExecError inspects the error returned by exec.Cmd.Run/Output
// and maps it to one of the sentinel categorizes above. Returns nil when
// err is a plain *exec.ExitError (the command ran and exited non-zero —
// caller wraps it as ErrNonZeroExit at the call site where ExitCode is
// known). Returns ErrCommandTimeout for context deadline, and a generic
// wrap for anything else (most commonly exec.ErrNotFound → binary missing).
func classifyExecError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	// Timeout detection: exec.CommandContext kills the process on deadline
	// and returns an error whose chain wraps context.DeadlineExceeded
	// (often as "signal: killed" over a DeadlineExceeded root). Check the
	// chain first, then the ctx itself as a fallback (covers the case where
	// the process was killed mid-run and the wrapper wasn't attached).
	if errors.Is(err, context.DeadlineExceeded) || (ctx != nil && ctx.Err() == context.DeadlineExceeded) {
		return fmt.Errorf("%w: %v", ErrCommandTimeout, err)
	}
	// *exec.ExitError means the process ran and exited non-zero. Callers
	// handle that as ErrNonZeroExit (with the exit code) at the site.
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return nil // caller decides; not a host-side failure
	}
	// Anything else is typically exec.ErrNotFound (binary missing) or a
	// syscall error from starting the exec client. Treat as binary-missing
	// unless proven otherwise — the common cause.
	if errors.Is(err, exec.ErrNotFound) {
		return fmt.Errorf("%w: %v", ErrExecBinaryMissing, err)
	}
	return err
}

// classifyNonZeroExit further refines a non-zero-exit result by inspecting
// the captured stderr. The docker / lxc-attach CLIs surface a gone
// container as exit code 1 with a distinctive stderr ("No such container",
// "is not running", "not found") — without this refinement every dead-
// container Exec would be miscategorized as ErrNonZeroExit, hiding the real
// cause from callers that want to recreate the sandbox. Returns either
// ErrSandboxNotFound (wrapped, when the container is gone) or
// ErrNonZeroExit (wrapped, for ordinary business failures).
func classifyNonZeroExit(stderr string, exitCode int, err error) error {
	lower := strings.ToLower(stderr)
	// docker: "No such container: <id>" / "container ... not found"
	// lxc-attach: "... is not running" / "lxc-attach: ...: not found"
	// Generic fallbacks for shimmed CLI wrappers.
	if strings.Contains(lower, "no such container") ||
		strings.Contains(lower, "container not found") ||
		strings.Contains(lower, "no such sandbox") ||
		strings.Contains(lower, "sandbox not found") ||
		strings.Contains(lower, "is not running") ||
		strings.Contains(lower, "not found") {
		return fmt.Errorf("%w: %v", ErrSandboxNotFound, err)
	}
	return fmt.Errorf("%w (exit %d)", ErrNonZeroExit, exitCode)
}
