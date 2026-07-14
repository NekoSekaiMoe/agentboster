package config

import (
	"strings"
	"testing"
)

func TestValidateRejectsRootfulDockerSocketByDefault(t *testing.T) {
	cfg := Config{Version: "1"}
	cfg.Sandbox.DockerSocket = "unix:///var/run/docker.sock"

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected rootful Docker socket to be rejected")
	}
	if !strings.Contains(err.Error(), "root-equivalent risk") {
		t.Fatalf("expected root-equivalent risk error, got %v", err)
	}
}

func TestValidateRejectsEmptyDockerSocket(t *testing.T) {
	cfg := Config{Version: "1"}

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected empty Docker socket to be rejected")
	}
	if !strings.Contains(err.Error(), "sandbox.docker_socket is required") {
		t.Fatalf("expected required Docker socket error, got %v", err)
	}
}

func TestValidateAllowsRootfulDockerSocketWithExplicitOverride(t *testing.T) {
	cfg := Config{Version: "1"}
	cfg.Sandbox.DockerSocket = "unix:///var/run/docker.sock"
	cfg.Sandbox.AllowRootfulDocker = true

	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected explicit rootful Docker override to pass, got %v", err)
	}
}

func TestValidateAllowsRootlessDockerSocket(t *testing.T) {
	cfg := Config{Version: "1"}
	cfg.Sandbox.DockerSocket = "unix:///run/user/1001/docker.sock"

	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected rootless Docker socket to pass, got %v", err)
	}
}

func TestDefaultAgentdTOMLUsesRootlessDockerSocket(t *testing.T) {
	toml := DefaultAgentdTOML()
	if !strings.Contains(toml, `docker_socket = "unix:///run/user/1001/docker.sock"`) {
		t.Fatalf("expected rootless Docker socket in default TOML, got:\n%s", toml)
	}
}

// TestNestedEnvOverrideApplies guards the SetEnvKeyReplacer wiring: a nested
// config key like clawless.node_id_file must be overridable via the documented
// AGENTD_CLAWLESS_NODE_ID_FILE env var. Without the "." -> "_" replacer,
// AutomaticEnv looks for the dotted AGENTD_CLAWLESS.NODE_ID_FILE (unsettable
// from a shell) and every documented override is silently ignored.
func TestNestedEnvOverrideApplies(t *testing.T) {
	t.Setenv("AGENTD_CLAWLESS_NODE_ID_FILE", "/from/env/node_id")
	t.Setenv("AGENTD_SERVER_LISTEN", ":28732")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.ClawLess.NodeIDFile != "/from/env/node_id" {
		t.Fatalf("nested env override ignored: node_id_file = %q, want /from/env/node_id",
			cfg.ClawLess.NodeIDFile)
	}
	if cfg.Server.Listen != ":28732" {
		t.Fatalf("nested env override ignored: server.listen = %q, want :28732",
			cfg.Server.Listen)
	}
}
