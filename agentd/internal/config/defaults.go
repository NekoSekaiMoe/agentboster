package config

import "runtime"

// DefaultAgentdTOML returns the default agentd.toml content.
func DefaultAgentdTOML() string {
	return `# Agent Daemon Configuration
# Generated automatically — edit as needed

[server]
listen = ":18732"
# mTLS certificate paths (required for production)
tls_cert_path = ""
tls_key_path = ""
ca_path = ""
# Legacy dual-auth (optional, mTLS is primary)
webui_username = "admin"
webui_password = ""
# API key for ClawLess → Daemon callbacks
clawless_api_key = ""

[clawless]
base_url = "http://localhost:3000"
# mTLS client cert for Daemon → ClawLess API calls
client_cert_path = ""
client_key_path = ""
ca_path = ""

[security]
l1_provider = "local_ollama"
l1_endpoint = "http://localhost:11434/api/generate"
l1_model = "tinyllama:latest"
l1_api_key = ""

[security.l1_threshold]
low = 0.3
medium = 0.7
high = 0.9

[sandbox]
default = "tmpfs"
chroot_base = "/var/lib/agentd/chroots"
tmpfs_size = "512m"
docker_socket = "unix:///var/run/docker.sock"

[cache]
path = "/tmp/agentd"
session_max_size = 104857600  # 100MB
sync_interval = "30s"
 retry_max_attempts = 5

[session]
max_count = 50
timeout = "30m"
store_path = "/tmp/agentd/sessions"
`
}

// NumCPU returns the number of CPUs for worker pool sizing.
func NumCPU() int {
	return runtime.NumCPU()
}
