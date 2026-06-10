//go:build linux
// +build linux

package sandbox

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DockerProvider implements SandboxProvider using Docker containers.
// Used for high-risk commands requiring strong isolation (strict mode).
type DockerProvider struct {
	mu            sync.RWMutex
	socket        string   // docker socket path
	allowedImages []string // image whitelist
	defaultCPU    float64
	defaultMem    string
	sandboxes     map[string]*Sandbox
}

// NewDockerProvider creates a new strict Docker sandbox provider.
func NewDockerProvider(socket string, allowedImages []string, defaultCPU float64, defaultMem string) *DockerProvider {
	if socket == "" {
		socket = "unix:///var/run/docker.sock"
	}
	if defaultCPU <= 0 {
		defaultCPU = 1.0
	}
	if defaultMem == "" {
		defaultMem = "512m"
	}
	return &DockerProvider{
		socket:        socket,
		allowedImages: allowedImages,
		defaultCPU:    defaultCPU,
		defaultMem:    defaultMem,
		sandboxes:     make(map[string]*Sandbox),
	}
}

// Create creates a Docker container sandbox.
func (p *DockerProvider) Create(spec SandboxSpec) (*Sandbox, error) {
	id := uuid.New().String()[:8]
	containerName := fmt.Sprintf("agentd-%s", id)

	// Default image
	image := spec.Image
	if image == "" {
		image = "ubuntu:22.04"
	}

	// Validate image against whitelist
	if len(p.allowedImages) > 0 {
		allowed := false
		for _, a := range p.allowedImages {
			if a == image {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("docker image %q not in allowed list: %v", image, p.allowedImages)
		}
	}

	cpu := spec.CPULimit
	if cpu <= 0 {
		cpu = p.defaultCPU
	}
	mem := p.defaultMem
	if spec.MemoryLimit > 0 {
		mem = fmt.Sprintf("%dm", spec.MemoryLimit/(1024*1024))
	}

	// Build docker run command
	args := []string{
		"run", "-d",
		"--name", containerName,
		"--network", "none", // No network by default (strong isolation)
		"--memory", mem, // Memory limit
		"--cpus", fmt.Sprintf("%.2f", cpu), // CPU limit
		"--pids-limit", "128", // Process limit
		"--security-opt", "no-new-privileges",
		"--cap-drop", "ALL", // Drop all capabilities
		"--read-only",               // Read-only rootfs
		"--tmpfs", "/tmp:size=256m", // Writable tmp
		"--tmpfs", "/workspace:size=512m", // Writable workspace on read-only rootfs
		"-w", "/workspace",
	}

	if spec.SecurityPolicy != nil && spec.SecurityPolicy.Seccomp != nil {
		seccompPath, err := writeDockerSeccompProfile(fmt.Sprintf("docker-strict-%s", id), spec.SecurityPolicy.Seccomp)
		if err != nil {
			return nil, fmt.Errorf("write docker strict seccomp profile: %w", err)
		}
		args = append(args, "--security-opt", "seccomp="+seccompPath)
	}

	// Add environment variables
	for k, v := range spec.Environment {
		args = append(args, "-e", k+"="+v)
	}

	// Add mounts
	for _, mount := range spec.Mounts {
		mountStr := fmt.Sprintf("%s:%s", mount.Source, mount.Target)
		if mount.RO {
			mountStr += ":ro"
		}
		args = append(args, "-v", mountStr)
	}

	if spec.SecurityPolicy != nil {
		for _, mp := range spec.SecurityPolicy.MaskedPaths {
			args = append(args, "-v", "/dev/null:"+mp+":ro")
		}
		for _, rp := range spec.SecurityPolicy.ReadonlyPaths {
			args = append(args, "-v", rp+":"+rp+":ro")
		}
	}

	// Create workspace directory structure inside the container
	workspaceInitCmd := "mkdir -p /workspace/skills /workspace/downloads/photos /workspace/downloads/videos /workspace/downloads/documents /workspace/media /workspace/sessions /workspace/memory /workspace/outputs /workspace/projects /workspace/bin /workspace/.local/bin"

	// Keep container running
	args = append(args, image, "sh", "-c", workspaceInitCmd+" && tail -f /dev/null")

	cmd := dockerCommand(p.socket, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker run failed: %w (output: %s)", err, string(output))
	}

	containerID := strings.TrimSpace(string(output))

	sbType := spec.Type
	if sbType == "" {
		sbType = "docker-strict"
	}

	sb := &Sandbox{
		ID:         id,
		Type:       sbType,
		Path:       containerID,
		Status:     "ready",
		Persistent: false, // Docker sandboxes are not persistent by default
		CreatedAt:  time.Now(),
	}

	p.mu.Lock()
	p.sandboxes[id] = sb
	p.mu.Unlock()

	slog.Info("docker sandbox created", "id", id, "container", containerName, "image", image)
	return sb, nil
}

// Exec runs a command inside the Docker container.
func (p *DockerProvider) Exec(sandboxID, cmd string, env map[string]string, timeout int) (*ExecResult, error) {
	p.mu.RLock()
	sb, ok := p.sandboxes[sandboxID]
	p.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("sandbox %q not found", sandboxID)
	}

	dockerArgs := []string{"exec"}

	// Add environment variables
	for k, v := range env {
		dockerArgs = append(dockerArgs, "-e", k+"="+v)
	}

	dockerArgs = append(dockerArgs, sb.Path, "bash", "-c", cmd)

	var execCmd *exec.Cmd
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
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
	} else {
		result.ExitCode = 0
	}

	return result, nil
}

// Destroy stops and removes the Docker container.
func (p *DockerProvider) Destroy(sandboxID string) error {
	p.mu.Lock()
	sb, ok := p.sandboxes[sandboxID]
	if !ok {
		p.mu.Unlock()
		return fmt.Errorf("sandbox %q not found", sandboxID)
	}
	delete(p.sandboxes, sandboxID)
	p.mu.Unlock()

	// Stop container
	stopCmd := dockerCommand(p.socket, "stop", sb.Path)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		slog.Warn("docker stop failed", "container", sb.Path, "error", err, "output", string(output))
	}

	// Remove container
	rmCmd := dockerCommand(p.socket, "rm", "-f", sb.Path)
	if output, err := rmCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker rm failed: %w (output: %s)", err, string(output))
	}

	slog.Info("docker sandbox destroyed", "id", sandboxID)
	return nil
}

// Status returns the Docker container status.
func (p *DockerProvider) Status(sandboxID string) (*Sandbox, error) {
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

// SetPersistent marks a Docker sandbox as persistent (won't be auto-destroyed).
func (p *DockerProvider) SetPersistent(sandboxID string, persistent bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sb, ok := p.sandboxes[sandboxID]; ok {
		sb.Persistent = persistent
	}
}

var _ SandboxProvider = (*DockerProvider)(nil)
