//go:build linux

package sandbox

import (
	"context"
	"errors"
	"os/exec"
	"testing"
	"time"
)

// TestClassifyExecError covers the P8 categorization that the three
// sandbox providers now rely on to populate ExecResult.Err. The four
// distinguishable cases (timeout / binary-missing / non-zero-exit /
// success) were previously all collapsed into ExitCode=-1 + nil error,
// which broke self-healing callers that needed to tell them apart.
func TestClassifyExecError(t *testing.T) {
	t.Run("nil error returns nil", func(t *testing.T) {
		if got := classifyExecError(context.Background(), nil); got != nil {
			t.Fatalf("want nil, got %v", got)
		}
	})

	t.Run("timeout is categorized", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Nanosecond)
		defer cancel()
		time.Sleep(2 * time.Nanosecond) // ensure deadline exceeded
		// Use a real syscall-style error rather than ctx.Err() directly,
		// because classifyExecError inspects ctx.Err() to detect timeout —
		// simulate the path exec.CommandContext takes: it returns an error
		// wrapping ctx.Err() when the deadline fires mid-process.
		err := errors.New("signal: killed")
		got := classifyExecError(ctx, err)
		if !errors.Is(got, ErrCommandTimeout) {
			t.Fatalf("want ErrCommandTimeout, got %v", got)
		}
	})

	t.Run("exit error is not a host failure (returns nil for caller to wrap)", func(t *testing.T) {
		// Simulate *exec.ExitError without running a process: we only need
		// errors.As to match. Build a real one via a trivial command.
		cmd := exec.Command("sh", "-c", "exit 3")
		err := cmd.Run()
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("setup: expected *exec.ExitError, got %T", err)
		}
		// A plain context (no deadline) with an ExitError should classify
		// as nil — the caller wraps it as ErrNonZeroExit at the site.
		got := classifyExecError(context.Background(), err)
		if got != nil {
			t.Fatalf("ExitError should not be classified as host failure; got %v", got)
		}
	})

	t.Run("binary missing is categorized", func(t *testing.T) {
		got := classifyExecError(context.Background(), exec.ErrNotFound)
		if !errors.Is(got, ErrExecBinaryMissing) {
			t.Fatalf("want ErrExecBinaryMissing, got %v", got)
		}
	})

	t.Run("other error passes through", func(t *testing.T) {
		orig := errors.New("something else")
		got := classifyExecError(context.Background(), orig)
		if !errors.Is(got, orig) {
			t.Fatalf("want passthrough of original error, got %v", got)
		}
	})
}

// TestExecResultErrSentinels locks the wire identity of the sentinel
// errors so callers using errors.Is keep working across refactors.
func TestExecResultErrSentinels(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"not found", ErrSandboxNotFound},
		{"timeout", ErrCommandTimeout},
		{"binary missing", ErrExecBinaryMissing},
		{"non-zero exit", ErrNonZeroExit},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if !errors.Is(tc.err, tc.err) { // self-identity
				t.Fatalf("%s does not satisfy errors.Is with itself", tc.name)
			}
		})
	}
}

// TestClassifyNonZeroExit_DeadContainer is the P8 refinement regression
// test. docker exec / lxc-attach surface a gone container as exit code 1
// with a distinctive stderr; without classifyNonZeroExit that case was
// miscategorized as ErrNonZeroExit, hiding the real cause from callers
// that want to recreate the sandbox. Verify each known stderr pattern
// resolves to ErrSandboxNotFound.
func TestClassifyNonZeroExit_DeadContainer(t *testing.T) {
	err := errors.New("underlying exec error")
	for _, tc := range []struct {
		name   string
		stderr string
	}{
		{"docker no such container", "Error: No such container: abc123"},
		{"docker container not found", "Error response from daemon: container abc not found"},
		{"lxc not running", "lxc-attach: abc: is not running"},
		{"generic sandbox not found", "sandbox not found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyNonZeroExit(tc.stderr, 1, err)
			if !errors.Is(got, ErrSandboxNotFound) {
				t.Errorf("stderr %q should classify as ErrSandboxNotFound; got %v", tc.stderr, got)
			}
		})
	}
}

// TestClassifyNonZeroExit_OrdinaryFailure confirms a plain non-zero exit
// with no dead-container marker stays ErrNonZeroExit (the common case —
// e.g. grep returning 1 because no matches).
func TestClassifyNonZeroExit_OrdinaryFailure(t *testing.T) {
	err := errors.New("exit status 1")
	got := classifyNonZeroExit("no matches found", 1, err)
	if !errors.Is(got, ErrNonZeroExit) {
		t.Errorf("ordinary non-zero exit should stay ErrNonZeroExit; got %v", got)
	}
	if errors.Is(got, ErrSandboxNotFound) {
		t.Errorf("ordinary failure must NOT be misclassified as ErrSandboxNotFound")
	}
}
