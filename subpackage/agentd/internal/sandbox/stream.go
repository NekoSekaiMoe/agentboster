// Package sandbox — stream.go
//
// Streaming variant of SandboxProvider.Exec, used by the long-lived
// process log endpoint (server/processes.go handleProcessStream).
//
// Background: the original Exec is synchronous — it blocks until the
// child exits and returns the merged output as a single string. That's
// the right shape for one-shot commands, but it cannot drive a real
// `tail -f` of a long-running process because:
//   - there's no way to hand the caller an io.Reader that yields bytes
//     as they arrive;
//   - the timeout parameter caps the call, so a forever-running command
//     (a dev server) would eventually be killed by the timeout, not by
//     the caller.
//
// ExecStream fills that gap. It returns an ExecStreamHandle whose Stdout
// pipe is live for as long as the caller keeps reading; closing the
// handle cancels the underlying exec and reaps the child. No timeout —
// the caller owns the lifetime.
//
// Why add to the interface instead of a side helper? Every provider
// (docker_light / docker-strict / lxc) shells out to a different binary
// (`docker exec` vs `lxc-attach`) with different arg shapes. Putting the
// per-provider pipe wiring in the provider keeps that knowledge where
// the rest of the exec path lives, instead of leaking docker / lxc
// specifics into the agent / server packages. Every provider already
// built here uses exec.Cmd, so each implementation is ~15 lines of
// StdoutPipe + context-cancel.
//
// Backward compatibility: this is an interface addition, so any external
// SandboxProvider implementation would need to grow ExecStream. The
// daemon only registers its three built-in providers (docker /
// docker-strict / lxc) — there is no RegisterProvider call site outside
// this package — so the compile breaks we'd cause are confined to this
// module and surface immediately.
package sandbox

import (
	"context"
	"fmt"
	"io"
)

// ExecStreamHandle is the live result of ExecStream. Callers MUST call
// Close exactly once when done reading; Close cancels the exec context
// and waits for the underlying process to exit, so leaking a handle
// leaks a goroutine + a child process.
type ExecStreamHandle struct {
	// Stdout is the streaming stdout (and, for providers that can't split
	// them, the merged stdout+stderr) of the child. It is closed when the
	// child exits or when Close is called.
	Stdout io.ReadCloser
	// cmd is the underlying exec.Cmd so Close can Cancel + Wait. Kept as
	// an opaque field so this file doesn't import os/exec (the provider
	// implementations do that).
	cmd streamCmd
}

// streamCmd is the small surface ExecStreamHandle.Close needs from an
// exec.Cmd. Defined here as an interface so providers pass their concrete
// *exec.Cmd without this file importing os/exec.
type streamCmd interface {
	// Wait blocks until the child exits. Must be safe to call after
	// Cancel (which typically races the child's natural exit).
	Wait() error
}

// closerCanceler is the minimum Close needs from the context machinery.
// Same indirection reason as streamCmd: keep this file dep-free.
type closerCanceler interface {
	Cancel()
}

// Close cancels the underlying exec and waits for the child to exit.
// Idempotent — subsequent calls are no-ops. The returned error is the
// child's Wait() error (typically nil on clean cancel, or an
// *exec.ExitError on natural exit); callers usually ignore it.
func (h *ExecStreamHandle) Close() error {
	if h == nil {
		return nil
	}
	if h.Stdout != nil {
		// Closing the reader first signals any io.Copy reading from it,
		// which is usually what unblocks the relay goroutine.
		_ = h.Stdout.Close()
	}
	if h.cmd != nil {
		// The provider's Wait is responsible for its own context cancel +
		// process reap — we don't reach into the context from here.
		_ = h.cmd.Wait()
	}
	return nil
}

// ExecStream is the streaming variant of Exec. It starts the child and
// returns immediately with a live stdout pipe; the child keeps running
// until the caller Close()s the handle or the child exits on its own.
//
// `cmd` is sh-style (the provider wraps it in `sh -c` exactly like Exec).
// `env` is merged into the child environment exactly like Exec. There is
// no timeout parameter by design.
//
// Providers that don't implement ExecStream (none of the built-ins
// today, but reserved for future minimal providers) should return
// fmt.Errorf("ExecStream not supported"). Callers may fall back to
// polling Exec with a small tail.
type execStreamFn func(sandboxID, cmd string, env map[string]string) (*ExecStreamHandle, error)

// errExecStreamUnsupported is the canonical error returned by providers
// that don't implement true streaming. Kept here so callers can detect
// it and fall back to polling without relying on string matching.
var errExecStreamUnsupported = fmt.Errorf("ExecStream not supported by this provider")

// IsExecStreamUnsupported reports whether err is the "provider can't
// stream" sentinel. The server's process-stream handler uses this to
// decide between SSE-over-pipe and the SSE-over-polling fallback.
func IsExecStreamUnsupported(err error) bool {
	return err == errExecStreamUnsupported
}

// withStreamCancel is a tiny helper providers use to bind a context
// cancel to the returned handle. It's here, not in each provider, so the
// cancel-on-Close behavior is identical across providers.
//
// The provider passes the *exec.Cmd and the cancel func; the helper
// returns a handle whose Close calls cancel + Waits. Importing os/exec
// is the provider's job.
func withStreamCancel(stdout io.ReadCloser, cmd streamCmd, cancel context.CancelFunc) *ExecStreamHandle {
	return &ExecStreamHandle{
		Stdout: stdout,
		cmd: &cancellableCmd{
			cmd:    cmd,
			cancel: cancel,
		},
	}
}

// cancellableCmd implements streamCmd with an explicit Cancel step
// before Wait. The order matters: cancel triggers the child's exit, and
// Wait then reaps it — without Wait the child would be a zombie.
type cancellableCmd struct {
	cmd     streamCmd
	cancel  context.CancelFunc
	closed  bool
}

func (c *cancellableCmd) Wait() error {
	if c == nil {
		return nil
	}
	if !c.closed && c.cancel != nil {
		c.cancel()
		c.closed = true
	}
	return c.cmd.Wait()
}
