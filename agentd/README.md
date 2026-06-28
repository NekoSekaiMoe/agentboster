# Agent Daemon (`agentd`)

`agentd` is the Linux daemon for AgentBoster. It executes tasks in sandboxed environments and reports results back to the Web service.

---

## 1) One-page architecture

- **Language / platform:** Go 1.26, Linux-only (`//go:build linux`)
- **Core runtime:** daemon receives task/tool execution signals and runs sandboxed tools (`docker`, `docker-strict`, `lxc`)
- **Safety:** L0/L1/L2 三级审批、会话与事件总线、worker pool
- **Data model:** 状态持久化主要在 Web 的 Postgres；daemon 本地仅缓存最小运行状态

### 通信方向（必须明确）

- **Daemon → Web（心跳、状态、回调）**：始终 `HTTPS + X-API-Key`
- **Web → Daemon（主动调用）**：只有 daemon 可被公网访问时才走 mTLS（常见于 frp/NAT 穿透场景）
- 在 Vercel 部署的 Web 上，**不要**给 Daemon→Web 路径配置 mTLS 客户端证书

---

## 2) 快速开始（最少步骤）

### 前置条件

- Linux amd64 主机
- Go 1.26.2（仅用于构建）
- 以 root 身份启动（启动后会降权到 `[security].run_as_user`）
- 若使用 `docker`：已安装 Docker（推荐 rootless）
- 若使用 `lxc`：需 `lxc-create/lxc-start/lxc-attach`
- Web 必须可达（daemon 会回调 Web 的 `clawless.base_url`）

### 2.1 编译

```bash
cd agentd
go build -o agentd ./cmd/agentd/
```

### 2.2 生成共享密钥

```bash
openssl rand -hex 32
```

- Web 侧：`AGENTD_API_KEY=<上面生成的值>`
- daemon：`agentd.toml` 的 `[server].clawless_api_key = "<同一个值>"`

### 2.3 生成配置

```bash
cp agentd.toml.example agentd.toml
```

**最小运行（常见，daemon 不直接暴露给 Web）：**

```toml
[server]
listen           = ":18732"
clawless_api_key = "与 AGENTD_API_KEY 完全一致"

[clawless]
base_url        = "https://your-agentboster.vercel.app"
client_cert_path = ""
client_key_path  = ""
ca_path          = ""

[sandbox]
default       = "docker"
docker_socket = "unix:///run/user/1001/docker.sock"

[security]
run_as_user = "agentd"
```

**若 daemon 需被 Web 主动访问（frp / 公网）：**

```toml
[server]
listen           = ":18732"
tls_cert_path    = "./certs/server-cert.pem"
tls_key_path     = "./certs/server-key.pem"
ca_path          = "./certs/ca-cert.pem"
clawless_api_key = "与 AGENTD_API_KEY 完全一致"

[clawless]
base_url        = "https://your-agentboster.vercel.app"
client_cert_path = ""
client_key_path  = ""
ca_path          = ""
```

### 2.4 启动

```bash
sudo ./agentd -config agentd.toml
```

验证：

```bash
curl -k https://127.0.0.1:18732/health
```

未配置 mTLS 时请用 `http://127.0.0.1:18732/health`。

---

## 3) mTLS 与证书（按需）

仅在 daemon 会被公网/Web 主动访问时开启 mTLS，通常通过 frp。

```bash
sudo ./agentd -gen-certs ./certs
```

会生成：

- `ca-cert.pem` / `ca-key.pem`
- `server-cert.pem` / `server-key.pem`（daemon）
- `client-cert.pem` / `client-key.pem`（Web 主动访问时）

常见误区：daemon 到 Web 的方向**不需要**设置 `AGENTD_CLIENT_*`，也不应该在该方向设置 mTLS 客户端证书。

---

## 4) 常用命令与运维

### CLI

```bash
./agentd -config agentd.toml         # 启动 daemon
./agentd -gen-certs ./certs          # 生成证书
./agentd -cert-dir ./certs           # 指定证书目录（默认 ./certs）
go test ./...                        # 运行单元测试
go vet ./... && go build ./...        # 静态检查 + 校验构建
```

### 推荐 systemd

```ini
[Unit]
Description=Agent Daemon
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/agentd -config /etc/agentd/agentd.toml
WorkingDirectory=/etc/agentd
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### 常见故障（前 10 秒解决）

| 现象 | 处理 |
|---|---|
| 连接 Web 报 `connection refused [::1]:3000` | Web 地址未就绪 / base_url 指向本机地址 |
| `x509: certificate signed by unknown authority` | 使用了错误根证书，通常是 Vercel 场景误配 `clawless.ca_path` |
| `./agentd: 1: Syntax error` | 二进制架构不对（ARM 在 amd64 主机上运行） |
| `docker socket not accessible` | 检查 Docker socket 与启动用户是否匹配（如 `allow_rootful_docker`） |
| `lxc-create not found` | 未安装 LXC，可跳过或安装后再用 `lxc` provider |
| `node register failed` | 多为 API Key 不一致或 Web URL 无法到达 |
| 工具仍走 Vercel Sandbox | daemon 未被 Web 可达，未在 Web 注册公网 Node URL |

---

## 5) 运行时能力速览

- Sandbox：`docker`、`docker-strict`、`lxc`
- 安全：L0（规则）→ L1（打分）→ L2（用户决策）
- 工具：文件、shell、git、web、memory、sub-agent、代码总结、媒体、任务控制等（通过 tool registry）
- 调度：worker pool + 事件总线

`/health` 与 `/metrics` 支持无鉴权查询，受保护接口位于 `/api/v1/*`（见下）

---

## 6) 受保护 API（摘要）

所有受保护路由返回：

```json
{ "success": bool, "data": ..., "error": ... }
```

- `GET /health`（公开）：实例状态
- `GET /metrics`（公开）：汇总指标
- `/api/v1/*`（鉴权）：`/tasks`, `/sessions`, `/memories`, `/l2-confirm`, `/tools/*`, `/llm-proxy` 等

完整端点清单请看源码路由定义：`internal/server/routes.go`。

---

## 7) 版本、配置与高级参数

- 当前版本号写在 `cmd/agentd/main.go`；变更 HTTP 契约或本地缓存格式时一并更新
- 配置文件结构以 `agentd.toml.example` 为准；支持 `AGENTD_<SECTION>_<KEY>` 覆盖环境变量（如 `AGENTD_SERVER_LISTEN`）
- 推荐阅读：`LAYOUT.MD`（模块地图）

---

## 8) 相关入口

- [Root README](../README.md)
- [`agentd.toml.example`](agentd.toml.example)
- [LAYOUT.MD](LAYOUT.MD)
