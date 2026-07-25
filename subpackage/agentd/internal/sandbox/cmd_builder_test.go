//go:build linux
// +build linux

package sandbox

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCommandBuilder_SetsProcessGroup(t *testing.T) {
	cmd := NewCommandBuilder("true").Build()
	if cmd.SysProcAttr == nil {
		t.Fatal("expected SysProcAttr to be set")
	}
	if !cmd.SysProcAttr.Setpgid {
		t.Fatal("expected Setpgid=true so each child is its own pgid leader")
	}
}

func TestCommandBuilder_StripsEnvPollution(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--inspect-brk")
	t.Setenv("NODE_DEBUG", "http")
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("NODE_INSPECT", "9229")
	t.Setenv("KEEP_ME", "yes")

	cmd := NewCommandBuilder("env").Build()

	got := map[string]string{}
	for _, kv := range cmd.Env {
		i := strings.IndexByte(kv, '=')
		if i < 0 {
			continue
		}
		got[kv[:i]] = kv[i+1:]
	}
	for _, key := range envPollutionKeys {
		if _, ok := got[key]; ok {
			t.Errorf("pollution key %q leaked into child env", key)
		}
	}
	if got["KEEP_ME"] != "yes" {
		t.Errorf("non-pollution env var KEEP_ME should survive, got %q", got["KEEP_ME"])
	}
}

func TestCommandBuilder_ExtraKillEnv(t *testing.T) {
	t.Setenv("SECRET_TOKEN", "abc")
	t.Setenv("NODE_OPTIONS", "--max-old-space-size=4096")

	cmd := NewCommandBuilder("env").KillEnv("SECRET_TOKEN").Build()
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, "SECRET_TOKEN=") {
			t.Errorf("extra kill-env SECRET_TOKEN should have been stripped, got %q", kv)
		}
		// NODE_OPTIONS should ALSO be gone (default pollution list).
		if strings.HasPrefix(kv, "NODE_OPTIONS=") {
			t.Errorf("default pollution key NODE_OPTIONS should also be stripped")
		}
	}
}

func TestCommandBuilder_CleanCLISetsNoColorAndTermDumb(t *testing.T) {
	cmd := NewCommandBuilder("env").CleanCLI().Build()
	got := map[string]string{}
	for _, kv := range cmd.Env {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			got[parts[0]] = parts[1]
		}
	}
	if got["NO_COLOR"] != "1" {
		t.Errorf("CleanCLI should set NO_COLOR=1, got %q", got["NO_COLOR"])
	}
	if got["TERM"] != "dumb" {
		t.Errorf("CleanCLI should set TERM=dumb, got %q", got["TERM"])
	}
}

func TestCommandBuilder_AppendsArgsAndEnv(t *testing.T) {
	cmd := NewCommandBuilder("docker", "exec").
		Args("-w", "/workspace", "container", "sh", "-c", "echo hi").
		Env("FOO=bar", "BAZ=qux").
		Build()

	wantArgs := []string{"exec", "-w", "/workspace", "container", "sh", "-c", "echo hi"}
	if len(cmd.Args) != len(wantArgs)+1 { // +1 for program name
		t.Fatalf("args length mismatch: got %v want %v", cmd.Args, append([]string{"docker"}, wantArgs...))
	}
	for i, want := range append([]string{"docker"}, wantArgs...) {
		if cmd.Args[i] != want {
			t.Errorf("arg[%d]: got %q want %q", i, cmd.Args[i], want)
		}
	}
	var sawFoo, sawBaz bool
	for _, kv := range cmd.Env {
		if kv == "FOO=bar" {
			sawFoo = true
		}
		if kv == "BAZ=qux" {
			sawBaz = true
		}
	}
	if !sawFoo || !sawBaz {
		t.Errorf("Env() should append both entries, sawFoo=%v sawBaz=%v", sawFoo, sawBaz)
	}
}

func TestCommandBuilder_CancelKillsProcessGroup(t *testing.T) {
	// Spawn a long-running `sh -c 'sleep 30 & wait'` as the direct child. It
	// becomes its own pgid leader (Setpgid=true). The backgrounded `sleep`
	// grandchild shares that pgid. When we cancel the context, Cmd.Cancel
	// must SIGKILL the negative pgid so BOTH the shell and the grandchild
	// die promptly. If Cancel only killed the direct child pid (Go's
	// default), the sleep grandchild would survive and the negative-pgid
	// existence check below would fail.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cmd := NewCommandBuilder("sh", "-c", "sleep 30 & wait").
		BuildContext(ctx)

	start := time.Now()
	doneCh := make(chan error, 1)
	go func() {
		_, err := cmd.CombinedOutput()
		doneCh <- err
	}()

	// Give the shell time to spawn the grandchild and capture the child pid.
	time.Sleep(300 * time.Millisecond)
	childProc := cmd.Process
	var childPid int
	if childProc != nil {
		childPid = childProc.Pid
	}
	cancel()

	select {
	case <-doneCh:
		elapsed := time.Since(start)
		if elapsed > 4*time.Second {
			t.Errorf("Wait took %v, expected fast teardown via group kill", elapsed)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("Cancel did not tear down the process within 6s")
	}

	// Give the kernel a moment to reap the killed group. The Cancel callback
	// fires asynchronously from CombinedOutput's Wait return, so the sleep
	// grandchild may still be in its final-TASK_DEAD transition when we reach
	// this line. 200ms is plenty for the SIGKILL to propagate.
	time.Sleep(200 * time.Millisecond)

	// The whole process group must be gone: signalling the negative pgid
	// with 0 (existence probe) should return ESRCH.
	if childPid > 1 {
		if err := syscall.Kill(-childPid, 0); err == nil {
			t.Errorf("process group %d still alive after cancel — group kill did not fire", -childPid)
		}
	}
}

func TestCommandBuilder_DockerHostEnvComposesWithStripping(t *testing.T) {
	// docker_cli.go's setDockerHost rebuilds cmd.Env from scratch after we've
	// set it; simulate that interplay by setting DOCKER_HOST after Build.
	t.Setenv("NODE_OPTIONS", "--inspect")
	cmd := NewCommandBuilder("docker", "version").Build()
	// Simulate setDockerHost appending DOCKER_HOST after the fact.
	cmd.Env = append(cmd.Env, "DOCKER_HOST=unix:///tmp/x.sock")
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, "NODE_OPTIONS=") {
			t.Error("NODE_OPTIONS should have been stripped before DOCKER_HOST append")
		}
	}
}

func TestCommandBuilder_PreservesInheritedEnvByDefault(t *testing.T) {
	// Sanity: with no pollution keys present, every inherited var survives.
	t.Setenv("PATH", "/usr/local/bin:/usr/bin")
	cmd := NewCommandBuilder("true").Build()
	found := false
	for _, kv := range cmd.Env {
		if strings.HasPrefix(kv, "PATH=") {
			found = true
			break
		}
	}
	if !found {
		t.Error("PATH should be inherited into child env by default")
	}
}

// Ensure the context-less Build() returns a runnable Cmd: `true` should exit 0.
func TestCommandBuilder_TrueExitsZero(t *testing.T) {
	if err := NewCommandBuilder("true").Build().Run(); err != nil {
		t.Errorf("true should exit 0, got %v", err)
	}
}

// Suppress unused-import warnings if a future refactor drops a dependency.
var _ = os.Environ
var _ = (*exec.Cmd)(nil)
var _ = syscall.SIGKILL
