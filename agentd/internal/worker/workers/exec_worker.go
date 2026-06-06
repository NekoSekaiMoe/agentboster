//go:build linux
// +build linux

package workers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"path"
	"runtime/debug"
	"strings"
	"time"

	"github.com/clawless/agentd/internal/eventbus"
	"github.com/clawless/agentd/internal/sandbox"
)

const (
	defaultExecTimeoutMs = 60_000
	maxExecTimeoutMs     = 600_000
	maxOutputBytes       = 100 * 1024
	truncationMarker     = "\n... [truncated at 100KB] ..."
	providerTypeTmpfs    = "tmpfs"
	providerTypeDocker   = "docker"
	providerTypeLXC      = "lxc"
)

// execRequest is the payload shape for EventExecRequested.
type execRequest struct {
	BatchID          string            `json:"batch_id"`
	ID               string            `json:"id"`
	Index            int               `json:"index"`
	Command          string            `json:"command"`
	WorkDir          string            `json:"workdir"`
	Env              map[string]string `json:"env"`
	TimeoutMs        int               `json:"timeout_ms"`
	SandboxType      string            `json:"sandbox_type"`
	UseParentSandbox bool              `json:"use_parent_sandbox"`
	SandboxID        string            `json:"sandbox_id"`
}

// HandleExecCommand executes one command from an EventExecRequested event in
// an ephemeral sandbox (or the parent LXC container when explicitly requested)
// and publishes the result as EventExecCompleted.
//
// The function is invoked from a pool goroutine and returns when the command
// has finished (or been cancelled/errored). It does not block on other workers.
func HandleExecCommand(ctx context.Context, ev eventbus.Event, bus *eventbus.Bus) error {
	req, ok := parseExecRequest(ev.Payload)
	if !ok {
		slog.Error("exec_worker: invalid payload, dropping event",
			slog.String("event_type", string(ev.Type)),
			slog.String("payload_type", fmt.Sprintf("%T", ev.Payload)),
		)
		return fmt.Errorf("invalid exec request payload")
	}

	var (
		statusString = "ok"
		errMsg       = ""
		exitCode     = 0
		truncated    = false
		elapsed      time.Duration
		sbID         = ""
		sbType       = ""
		stdoutOut    = ""
		stderrOut    = ""
		ownsSandbox  = false
		sb           *sandbox.Sandbox
		provider     sandbox.SandboxProvider
	)
	if req.ID == "" {
		req.ID = fmt.Sprintf("%s:%d", req.BatchID, req.Index)
	}

	// Defer the publish + cleanup so every return path (including panic)
	// converges on a single EventExecCompleted emission.
	defer func() {
		if r := recover(); r != nil {
			stack := string(debug.Stack())
			slog.Error("exec_worker: outer panic",
				slog.Any("panic", r),
				slog.String("stack", stack),
			)
			if statusString == "ok" {
				statusString = "error"
				errMsg = fmt.Sprintf("panic: %v", r)
			}
		}
		if sb != nil && ownsSandbox && provider != nil {
			if derr := provider.Destroy(sb.ID); derr != nil {
				slog.Warn("exec_worker: sandbox destroy failed",
					slog.String("batch_id", req.BatchID),
					slog.Int("index", req.Index),
					slog.String("sandbox_id", sb.ID),
					slog.String("error", derr.Error()),
				)
			}
		}
		bus.Publish(eventbus.EventExecCompleted, &ExecResult{
			BatchID:     req.BatchID,
			ID:          req.ID,
			Index:       req.Index,
			Status:      statusString,
			ExitCode:    exitCode,
			Stdout:      stdoutOut,
			Stderr:      stderrOut,
			Duration:    elapsed,
			Error:       errMsg,
			SandboxID:   sbID,
			SandboxType: sbType,
			Truncated:   truncated,
		})
	}()

	// Resolve timeout (ms → seconds for the existing provider.Exec contract).
	timeoutMs := req.TimeoutMs
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}
	if timeoutMs > maxExecTimeoutMs {
		slog.Warn("exec_worker: clamping timeout to 10 minutes",
			slog.String("batch_id", req.BatchID),
			slog.Int("index", req.Index),
			slog.Int("requested_ms", req.TimeoutMs),
		)
		timeoutMs = maxExecTimeoutMs
	}
	timeoutSec := (timeoutMs + 999) / 1000

	// Resolve sandbox: prefer the caller's sandbox so all commands share the
	// same /workspace. If no sandbox ID is provided, fall back to an ephemeral
	// sandbox of the requested type.
	if req.SandboxID != "" {
		mgr := sandbox.DefaultManager()
		if mgr == nil {
			statusString = "error"
			errMsg = "sandbox manager not available for sandbox reuse"
			return nil
		}
		existing, found := mgr.Get(req.SandboxID)
		if !found {
			statusString = "error"
			errMsg = fmt.Sprintf("sandbox %q not found", req.SandboxID)
			return nil
		}
		sb = existing
		ownsSandbox = false
		providerName := sb.Type
		if req.SandboxType != "" {
			providerName = resolveProviderType(req.SandboxType)
		}
		var perr error
		provider, perr = sandbox.SelectProvider(providerName)
		if perr != nil {
			statusString = "error"
			errMsg = perr.Error()
			return nil
		}
	} else {
		providerType := resolveProviderType(req.SandboxType)
		var perr error
		provider, perr = sandbox.SelectProvider(providerType)
		if perr != nil {
			statusString = "error"
			errMsg = perr.Error()
			return nil
		}
		created, cerr := provider.Create(sandbox.SandboxSpec{
			Type:    providerType,
			WorkDir: req.WorkDir,
		})
		if cerr != nil {
			statusString = "error"
			errMsg = fmt.Sprintf("create sandbox: %v", cerr)
			return nil
		}
		sb = created
		ownsSandbox = true
	}

	sbID = sb.ID
	sbType = sb.Type
	command, workDirErr := commandWithWorkDir(req.Command, req.WorkDir)
	if workDirErr != nil {
		statusString = "error"
		errMsg = workDirErr.Error()
		return nil
	}

	// Execute with panic recovery.
	start := time.Now()
	var result *sandbox.ExecResult
	var execErr error

	func() {
		defer func() {
			if r := recover(); r != nil {
				stack := string(debug.Stack())
				slog.Error("exec_worker: panic in sandbox Exec",
					slog.String("batch_id", req.BatchID),
					slog.Int("index", req.Index),
					slog.String("sandbox_id", sb.ID),
					slog.Any("panic", r),
					slog.String("stack", stack),
				)
				execErr = fmt.Errorf("panic during exec: %v", r)
			}
		}()
		result, execErr = provider.Exec(sb.ID, command, req.Env, timeoutSec)
	}()
	elapsed = time.Since(start)

	// Context cancellation wins over everything.
	if ctx.Err() != nil {
		statusString = "cancelled"
		errMsg = ctx.Err().Error()
		slog.LogAttrs(ctx, slog.LevelWarn, "exec_worker: cancelled",
			slog.String("batch_id", req.BatchID),
			slog.Int("index", req.Index),
			slog.String("command", truncateString(req.Command, 80)),
			slog.String("sandbox_type", sbType),
			slog.Duration("elapsed", elapsed),
			slog.String("status", statusString),
		)
		return nil
	}

	if execErr != nil {
		if errors.Is(execErr, context.DeadlineExceeded) || isProcessTimeout(execErr) {
			statusString = "timeout"
		} else {
			statusString = "error"
		}
		errMsg = execErr.Error()
		slog.LogAttrs(ctx, slog.LevelError, "exec_worker: command failed",
			slog.String("batch_id", req.BatchID),
			slog.Int("index", req.Index),
			slog.String("command", truncateString(req.Command, 80)),
			slog.String("sandbox_type", sbType),
			slog.Duration("elapsed", elapsed),
			slog.String("status", statusString),
		)
		return nil
	}

	if result != nil {
		exitCode = result.ExitCode
		var stdTrunc, errTrunc bool
		stdoutOut, stdTrunc = truncateOutput(result.Stdout)
		stderrOut, errTrunc = truncateOutput(result.Stderr)
		truncated = stdTrunc || errTrunc

		if exitCode != 0 {
			statusString = "error"
			errMsg = fmt.Sprintf("exit code %d", exitCode)
		}
		slog.LogAttrs(ctx, slog.LevelInfo, "exec_worker: command completed",
			slog.String("batch_id", req.BatchID),
			slog.Int("index", req.Index),
			slog.String("command", truncateString(req.Command, 80)),
			slog.String("sandbox_type", sbType),
			slog.Duration("elapsed", elapsed),
			slog.String("status", statusString),
		)
		return nil
	}

	return nil
}

// isProcessTimeout returns true if the error looks like a process-level
// timeout (the `timeout` wrapper exits 124 on hit) rather than a context
// deadline.
func isProcessTimeout(err error) bool {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode() == 124
	}
	return false
}

// resolveProviderType maps the public sandbox_type alias to the registered
// provider name. "tmpfs" is the default alias for the docker light provider
// (which mounts /workspace as a tmpfs). Unknown values pass through and let
// SelectProvider produce the "not registered" error.
func resolveProviderType(sandboxType string) string {
	switch sandboxType {
	case "":
		return providerTypeDocker
	case providerTypeTmpfs:
		return providerTypeDocker
	default:
		return sandboxType
	}
}

// parseExecRequest normalizes an event payload into an execRequest. The
// producer side may publish either a map[string]any or a struct with json
// tags, so we accept both via a JSON round-trip and common-alias fallbacks.
func parseExecRequest(payload any) (execRequest, bool) {
	if payload == nil {
		return execRequest{}, false
	}
	switch v := payload.(type) {
	case execRequest:
		return v, true
	case *execRequest:
		if v == nil {
			return execRequest{}, false
		}
		return *v, true
	case map[string]any:
		return execRequest{
			BatchID:          stringFromMap(v, "batch_id"),
			ID:               stringFromMap(v, "id"),
			Index:            intFromMap(v, "index"),
			Command:          stringFromMap(v, "command"),
			WorkDir:          firstNonEmpty(stringFromMap(v, "workdir"), stringFromMap(v, "work_dir")),
			Env:              stringMapFromMap(v, "env"),
			TimeoutMs:        intFromMap(v, "timeout_ms"),
			SandboxType:      firstNonEmpty(stringFromMap(v, "sandbox_type"), stringFromMap(v, "sandbox_hint")),
			UseParentSandbox: boolFromMap(v, "use_parent_sandbox"),
			SandboxID:        stringFromMap(v, "sandbox_id"),
		}, true
	default:
		raw, err := json.Marshal(v)
		if err != nil {
			return execRequest{}, false
		}
		var req execRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return execRequest{}, false
		}
		if req.WorkDir == "" {
			if m, ok := payload.(map[string]any); ok {
				req.WorkDir = firstNonEmpty(stringFromMap(m, "work_dir"))
			}
		}
		if req.SandboxType == "" {
			if m, ok := payload.(map[string]any); ok {
				req.SandboxType = firstNonEmpty(stringFromMap(m, "sandbox_hint"))
			}
		}
		return req, true
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func commandWithWorkDir(cmd string, workDir string) (string, error) {
	wd := strings.TrimSpace(workDir)
	target := "/workspace"
	if wd != "" && wd != "." {
		if strings.HasPrefix(wd, "/") {
			cleanAbs := path.Clean(wd)
			if cleanAbs != "/workspace" && !strings.HasPrefix(cleanAbs, "/workspace/") {
				return "", fmt.Errorf("workdir must be inside /workspace: %s", workDir)
			}
			target = cleanAbs
		} else {
			cleanRel := path.Clean(wd)
			if cleanRel == ".." || strings.HasPrefix(cleanRel, "../") {
				return "", fmt.Errorf("workdir must not escape /workspace: %s", workDir)
			}
			target = path.Join("/workspace", cleanRel)
		}
	}
	return fmt.Sprintf("cd %s && %s", shellQuote(target), cmd), nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

func stringFromMap(m map[string]any, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func intFromMap(m map[string]any, key string) int {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case int:
			return n
		case int32:
			return int(n)
		case int64:
			return int(n)
		case float64:
			return int(n)
		case float32:
			return int(n)
		}
	}
	return 0
}

func stringMapFromMap(m map[string]any, key string) map[string]string {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	switch env := v.(type) {
	case map[string]string:
		return env
	case map[string]any:
		result := make(map[string]string, len(env))
		for k, val := range env {
			if s, ok := val.(string); ok {
				result[k] = s
			}
		}
		return result
	default:
		return nil
	}
}

func boolFromMap(m map[string]any, key string) bool {
	if v, ok := m[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

// truncateOutput applies the byte-based 100 KiB cap and returns the (possibly
// truncated) string and whether truncation occurred.
func truncateOutput(s string) (string, bool) {
	if len(s) <= maxOutputBytes {
		return s, false
	}
	return s[:maxOutputBytes] + truncationMarker, true
}

// truncateString returns the first n bytes of s with "..." appended if it was
// truncated. Used for log fields only.
func truncateString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
