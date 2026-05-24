package config

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
low = 0.4
medium = 0.7
high = 0.9
critical = 0.9

[sandbox]
default = "tmpfs"
chroot_base = "/var/lib/agentd/chroots"
tmpfs_size = "512m"
docker_socket = "unix:///var/run/docker.sock"
rootfs_cache_dir = "/var/lib/agentd/images"
local_rootfs_path = "/var/lib/agentd/images/alpine-minirootfs.tar.gz"
default_rootfs_url = "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz"
cache_max_age_days = 30

[sandbox.chroot.init]
commands = [
    "apk add --no-cache git curl bash",
    "mkdir -p /workspace",
    "echo 'nameserver 8.8.8.8' > /etc/resolv.conf",
]

[[sandbox.chroot.presets]]
name = "alpine-dev"
path = "/var/lib/agentd/images/alpine-dev-rootfs"

[[sandbox.chroot.presets]]
name = "ubuntu-22.04"
path = "/var/lib/agentd/images/ubuntu-22.04-rootfs"

[sandbox.docker]
allowed_images = ["ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "golang:1.22", "node:20", "python:3.12"]

[cache]
path = "/tmp/agentd"
session_max_size = 104857600  # 100MB
sync_interval = "30s"
 retry_max_attempts = 5

[session]
max_count = 50
timeout = "30m"
store_path = "/tmp/agentd/sessions"

[worker]
# review_pool_size 默认 NumCPU * 4（IO/系统调用密集型）
# sandbox_pool_size 默认 NumCPU * 2（IO 密集型）
# task_pool_size 默认 NumCPU
# memory_pool_size 默认 2
# cleanup_pool_size 默认 1
review_pool_size = 0   # 0 = 使用默认值 (NumCPU * 4)
sandbox_pool_size = 0  # 0 = 使用默认值 (NumCPU * 2)
task_pool_size = 0     # 0 = 使用默认值 (NumCPU)
`
}


