//go:build linux
// +build linux

package sandbox

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DockerLightProvider implements a lightweight Docker sandbox for daily tasks.
// Containers use alpine:edge by default with --rm for automatic cleanup.
type DockerLightProvider struct {
	mu         sync.RWMutex
	socket     string
	image      string
	defaultCPU float64
	defaultMem string
	sandboxes  map[string]*Sandbox
}

// NewDockerLightProvider creates a new lightweight Docker provider.
func NewDockerLightProvider(socket, image string, defaultCPU float64, defaultMem string) *DockerLightProvider {
	if socket == "" {
		socket = "unix:///var/run/docker.sock"
	}
	if image == "" {
		image = "alpine:edge"
	}
	if defaultCPU <= 0 {
		defaultCPU = 0.25
	}
	if defaultMem == "" {
		defaultMem = "256m"
	}
	return &DockerLightProvider{
		socket:     socket,
		image:      image,
		defaultCPU: defaultCPU,
		defaultMem: defaultMem,
		sandboxes:  make(map[string]*Sandbox),
	}
}

// Create creates a lightweight Docker container.
func (p *DockerLightProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	containerName := fmt.Sprintf("agentd-light-%s", id)

	image := spec.Image
	if image == "" {
		image = p.image
	}

	cpu := spec.CPULimit
	if cpu <= 0 {
		cpu = p.defaultCPU
	}

	mem := p.defaultMem
	if spec.MemoryLimit > 0 {
		mem = strconv.FormatInt(spec.MemoryLimit/(1024*1024), 10) + "m"
	}

	args := []string{
		"run", "-d",
		"--rm",
		"--name", containerName,
		"--cpus", fmt.Sprintf("%.2f", cpu),
		"--memory", mem,
	}

	// P2.3: apply per-spec resource overrides when set.
	if spec.PidsLimit > 0 {
		args = append(args, "--pids-limit", strconv.Itoa(spec.PidsLimit))
	}
	if spec.BlkioWeight > 0 {
		args = append(args, "--blkio-weight", strconv.Itoa(int(spec.BlkioWeight)))
	}
	if spec.DiskLimit != "" {
		// Docker doesn't have a single --disk-limit flag; use
		// --storage-opt size for overlay2-backed filesystems. This is
		// a best-effort apply — older docker/overlay2 setups ignore it.
		args = append(args, "--storage-opt", "size="+spec.DiskLimit)
	}

	// Apply OS enforcement policy
	if spec.SecurityPolicy != nil {
		policy := spec.SecurityPolicy

		// Capabilities: drop ALL, then add back minimum necessary
		args = append(args, "--cap-drop", "ALL")
		for _, cap := range policy.CapKeep {
			args = append(args, "--cap-add", cap)
		}

		// Prevent privilege escalation
		args = append(args, "--security-opt", "no-new-privileges")

		// Read-only rootfs with writable tmp directories
		args = append(args, "--read-only")
		args = append(args, "--tmpfs", "/tmp:size=128m")
		args = append(args, "--tmpfs", "/workspace:size=512m")

		// Seccomp profile
		if policy.Seccomp != nil {
			seccompPath, err := writeDockerSeccompProfile("docker-light", policy.Seccomp)
			if err != nil {
				return nil, fmt.Errorf("write docker light seccomp profile: %w", err)
			}
			args = append(args, "--security-opt", "seccomp="+seccompPath)
		}

		// Network isolation
		if policy.NetworkNone {
			args = append(args, "--network", "none")
		}
	} else {
		args = append(args, "--tmpfs", "/workspace/tmp:size=128m")
	}

	for k, v := range spec.Environment {
		args = append(args, "-e", k+"="+v)
	}

	for _, mount := range spec.Mounts {
		mountStr := fmt.Sprintf("%s:%s", mount.Source, mount.Target)
		if mount.RO {
			mountStr += ":ro"
		}
		args = append(args, "-v", mountStr)
	}

	workDir := spec.WorkDir
	if workDir == "" {
		workDir = "/workspace"
	}
	args = append(args, "-w", workDir)

	// Mask sensitive paths (bind /dev/null over them)
	if spec.SecurityPolicy != nil {
		for _, mp := range spec.SecurityPolicy.MaskedPaths {
			args = append(args, "-v", "/dev/null:"+mp+":ro")
		}
		for _, rp := range spec.SecurityPolicy.ReadonlyPaths {
			args = append(args, "-v", rp+":"+rp+":ro")
		}
	}

	initCmd := "mkdir -p /workspace/skills /workspace/downloads/photos /workspace/downloads/videos /workspace/downloads/documents /workspace/media /workspace/sessions /workspace/memory /workspace/outputs /workspace/projects /workspace/bin /workspace/.local/bin /workspace/tmp && tail -f /dev/null"
	args = append(args, image, "sh", "-c", initCmd)

	cmd := dockerCommand(p.socket, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker run failed: %w (output: %s)", err, string(output))
	}

	containerID := strings.TrimSpace(string(output))

	sb := &Sandbox{
		ID:        id,
		Type:      "docker",
		Path:      containerID,
		Status:    "ready",
		CreatedAt: time.Now(),
	}

	p.mu.Lock()
	p.sandboxes[id] = sb
	p.mu.Unlock()

	slog.Info("docker light sandbox created", "id", id, "container", containerName, "image", image)
	return sb, nil
}

// Exec runs a command inside the Docker container.
func (p *DockerLightProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	dockerArgs := []string{"exec", "-w", "/workspace"}
	for k, v := range env {
		dockerArgs = append(dockerArgs, "-e", k+"="+v)
	}
	dockerArgs = append(dockerArgs, sb.Path, "sh", "-c", cmd)

	var execCmd *exec.Cmd
	if timeout > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
		defer cancel()
		execCmd = dockerCommandContext(ctx, p.socket, dockerArgs...)
	} else {
		execCmd = dockerCommand(p.socket, dockerArgs...)
	}

	start := time.Now()
	output, err := execCmd.CombinedOutput()
	duration := time.Since(start)

	result := &ExecResult{
		Stdout:   string(output),
		Duration: duration,
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
		}
		result.Stderr = string(output)
	}

	return result, nil
}

// ExecStream is the streaming variant of Exec — see SandboxProvider.
// Used by the /processes/:id/stream SSE endpoint to `tail -f` a managed
// process's output without burning a goroutine on polling.
//
// Implementation: same `docker exec` arg shape as Exec, but using
// exec.Cmd.StdoutPipe + a cancelable context instead of CombinedOutput.
// The caller owns the lifetime — closing the returned handle cancels the
// docker exec child and reaps it. No timeout, on purpose.
func (p *DockerLightProvider) ExecStream(sandboxID, cmd string, env map[string]string) (*ExecStreamHandle, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	dockerArgs := []string{"exec", "-w", "/workspace"}
	for k, v := range env {
		dockerArgs = append(dockerArgs, "-e", k+"="+v)
	}
	dockerArgs = append(dockerArgs, sb.Path, "sh", "-c", cmd)

	ctx, cancel := context.WithCancel(context.Background())
	execCmd := dockerCommandContext(ctx, p.socket, dockerArgs...)

	stdout, err := execCmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	// stderr is folded into stdout so the caller sees the same merged
	// stream CombinedOutput would have produced. Without this, error
	// output from the child would be dropped on the floor.
	execCmd.Stderr = execCmd.Stdout

	if err := execCmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start: %w", err)
	}
	return withStreamCancel(stdout, execCmd, cancel), nil
}

// Destroy stops and removes the Docker container.
func (p *DockerLightProvider) Destroy(sandboxID string) error {
	p.mu.Lock()
	sb, ok := p.sandboxes[sandboxID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}
	delete(p.sandboxes, sandboxID)
	p.mu.Unlock()

	rmCmd := dockerCommand(p.socket, "rm", "-f", sb.Path)
	if output, err := rmCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker rm failed: %w (output: %s)", err, string(output))
	}

	slog.Info("docker light sandbox destroyed", "id", sandboxID)
	return nil
}

// Status returns the Docker container status.
func (p *DockerLightProvider) Status(sandboxID string) (*Sandbox, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	cmd := dockerCommand(p.socket, "inspect", "--format", "{{.State.Status}}", sb.Path)
	output, err := cmd.CombinedOutput()
	if err != nil {
		sb.Status = "destroyed"
		return sb, nil
	}

	status := strings.TrimSpace(string(output))
	switch status {
	case "running":
		sb.Status = "ready"
	case "exited", "dead":
		sb.Status = "destroyed"
	default:
		sb.Status = status
	}

	return sb, nil
}

// Restart is not supported for lightweight Docker sandboxes — they are
// ephemeral (docker rm on Destroy), so there is no rootfs to resume.
// The HealthChecker falls back to Destroy for non-restartable providers.
func (p *DockerLightProvider) Restart(sandboxID string) error {
	return fmt.Errorf("restart not supported for docker-light sandboxes")
}

var _ SandboxProvider = (*DockerLightProvider)(nil)
