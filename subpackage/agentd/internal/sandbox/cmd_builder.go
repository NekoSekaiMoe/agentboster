//go:build linux
// +build linux

// Package sandbox: command builder.
//
// Hardened subprocess builder for every exec.Command / exec.CommandContext
// call site under internal/sandbox/. Borrowed from AionCore's
// aionui-runtime Builder (crates/aionui-runtime/src/spawn.rs):
//
//   - process_group(0)            -> Setpgid: true (each child is its own
//                                    process-group leader so teardown can
//                                    SIGKILL the whole subtree, including
//                                    docker-spawned MCP descendants, in one
//                                    shot). AionCore configure_platform_spawn.
//   - kill_on_drop(true)          -> cmd.Cancel kills the negative pgid on
//                                    context cancellation / Wait return.
//                                    AionCore spawn.rs Builder default.
//   - env pollution stripping     -> remove NODE_OPTIONS / NODE_DEBUG /
//                                    NODE_INSPECT / CLAUDECODE so inherited
//                                    host debug/profiling flags never reach
//                                    the sandboxed child. AionCore
//                                    strip_pollution.
//   - clean-cli mode (opt-in)     -> NO_COLOR=1 TERM=dumb so ANSI escapes do
//                                    not corrupt stdout JSON/text parsing.
//                                    AionCore clean_cli builder.
//
// Why this lives here, not per-provider: every provider (docker /
// docker_light / lxc) and the reaper construct exec.Cmd themselves today,
// each duplicating env / timeout / teardown handling inconsistently. Giving
// them a single builder means a future fix (e.g. cgroup-based killing)
// lands in one place. The existing setDockerHost env filter in docker_cli.go
// stays as-is — it composes with the stripping done here.
package sandbox

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// envPollutionKeys are inherited host env vars that must never leak into a
// sandboxed child. Matches AionCore's strip_pollution list exactly.
var envPollutionKeys = []string{
	"NODE_OPTIONS",
	"NODE_DEBUG",
	"NODE_INSPECT",
	// CLAUDECODE injects Claude Code's own IPC hooks; if it survives into a
	// nested claude-code worker the child tries to talk to a non-existent
	// parent pipe.
	"CLAUDECODE",
}

// CommandBuilder is a hardened exec.Cmd constructor. Zero-value is invalid;
// use NewCommandBuilder. Methods return the receiver for chaining.
type CommandBuilder struct {
	name     string
	args     []string
	cleanCli bool
	// extraEnvKill appends caller-supplied keys to strip on top of the
	// pollution defaults (e.g. provider-specific variables).
	extraEnvKill []string
	// extraEnv is caller-supplied env to set (K=V form), applied after
	// stripping.
	extraEnv []string
}

// NewCommandBuilder starts a hardened command builder for the given program.
// The returned builder already has process-group containment + env pollution
// stripping applied; callers only add args / env / clean-cli as needed.
func NewCommandBuilder(name string, args ...string) *CommandBuilder {
	return &CommandBuilder{name: name, args: args}
}

// Args appends more positional args to the command line.
func (b *CommandBuilder) Args(args ...string) *CommandBuilder {
	b.args = append(b.args, args...)
	return b
}

// CleanCLI enables the short-lived-CLI preset: sets NO_COLOR=1 and TERM=dumb
// so ANSI escape sequences do not leak into captured stdout/stderr. Use for
// tools whose output we parse as JSON / structured text (aionrs' clean_cli).
func (b *CommandBuilder) CleanCLI() *CommandBuilder {
	b.cleanCli = true
	return b
}

// KillEnv appends extra env var names to strip from the inherited environment,
// on top of the pollution defaults in envPollutionKeys.
func (b *CommandBuilder) KillEnv(keys ...string) *CommandBuilder {
	b.extraEnvKill = append(b.extraEnvKill, keys...)
	return b
}

// Env appends K=V env entries to set on the child (applied after stripping).
func (b *CommandBuilder) Env(kv ...string) *CommandBuilder {
	b.extraEnv = append(b.extraEnv, kv...)
	return b
}

// Build returns the configured *exec.Cmd without a context. Process-group
// containment is set; cancel-on-drop is NOT wired because Go requires
// CommandContext for a non-nil Cancel. Use BuildContext when you want
// context-driven teardown.
func (b *CommandBuilder) Build() *exec.Cmd {
	cmd := exec.Command(b.name, b.args...)
	b.apply(cmd, false)
	return cmd
}

// BuildContext returns the configured *exec.Cmd bound to ctx. When ctx is
// cancelled, Cmd.Cancel kills the whole process group (negative pgid), which
// is the Go-idiomatic equivalent of tokio's kill_on_drop(true).
func (b *CommandBuilder) BuildContext(ctx context.Context) *exec.Cmd {
	cmd := exec.CommandContext(ctx, b.name, b.args...)
	b.apply(cmd, true)
	return cmd
}

// apply mutates cmd in place to install the platform / env / teardown
// hardening. Called once from Build / BuildContext. `withCancel` is false
// for the context-less Build() path, since Go rejects Run() on a Cmd with a
// non-nil Cancel that wasn't created via CommandContext.
func (b *CommandBuilder) apply(cmd *exec.Cmd, withCancel bool) {
	// 1) Process-group containment (AionCore configure_platform_spawn).
	// Each child becomes its own pgid so we can kill(-(pgid), SIGKILL) the
	// subtree later. Setting Pgid=0 means "use the child's pid as the
	// group id", per setpgid(2).
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
	if withCancel {
		// 2) kill_on_drop equivalent: when the context fires OR Wait returns
		// with the Cmd still running, kill the whole group. Go's default
		// Cancel only SIGKILLs the direct child; docker exec spawns a shell
		// which spawns the real workload, so the default leaves orphans.
		pgidSelfKill := func() error {
			// Negative pid => signal the whole process group (kill -PGID).
			// Best-effort: if the child already exited, ESRCH is returned and
			// we ignore it (matches AionCore's HOT-path non-blocking reap).
			if cmd.Process == nil {
				return nil
			}
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			return nil
		}
		cmd.Cancel = pgidSelfKill
		// WaitDelay bounds how long Wait() blocks for the child to exit after
		// Cancel runs. 5s is generous enough for docker to propagate SIGKILL
		// into the container without hanging a request indefinitely.
		cmd.WaitDelay = 5 * time.Second
	}

	// 3) Env pollution stripping + clean-cli (AionCore strip_pollution +
	// clean_cli). Start from the inherited env, drop the pollution keys,
	// then layer caller-supplied env on top.
	kill := make(map[string]struct{}, len(envPollutionKeys)+len(b.extraEnvKill))
	for _, k := range envPollutionKeys {
		kill[k] = struct{}{}
	}
	for _, k := range b.extraEnvKill {
		kill[k] = struct{}{}
	}
	filtered := make([]string, 0, len(cmd.Env)+len(b.extraEnv)+2)
	if cmd.Env == nil {
		// cmd.Env == nil means "inherit os.Environ()"; materialize it so
		// our filtering actually applies.
		cmd.Env = os.Environ()
	}
	for _, item := range cmd.Env {
		key := item
		if i := strings.IndexByte(item, '='); i > 0 {
			key = item[:i]
		}
		if _, drop := kill[key]; drop {
			continue
		}
		filtered = append(filtered, item)
	}
	if b.cleanCli {
		filtered = append(filtered, "NO_COLOR=1", "TERM=dumb")
	}
	filtered = append(filtered, b.extraEnv...)
	cmd.Env = filtered
}
