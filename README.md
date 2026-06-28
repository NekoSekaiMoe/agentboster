# AgentBoster (WIP)

<p align="center">
  <img src="./app/icon.png" alt="agentboster" width="160" />
</p>

<p align="center">
  <a href="./README.EN.md">EN: README</a>
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/node.js-%E2%9C%93-339933?logo=node.js" />
  <img alt="Go" src="https://img.shields.io/badge/go-1.26-00ADD8?logo=go" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-yellow" />
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
</p>

> [!NOTE]
> 在 1.0 发布前，功能与接口仍可能变化，升级兼容性不作保证。

AgentBoster 是由两个独立模块协作的 AI 平台：

- **Web（Next.js 15）**：前端、会话管理、IM 适配、配置、任务编排与持久化执行
- **agentd（Go）**：Linux 守护进程，负责沙箱执行、工具调用安全与任务调度

Web 负责 IM 与展示，Daemon 负责执行与安全边界，因此两端的部署和运行环境可独立调整。

---

## 当前仓库结构

```
app/                    # Next.js App Router（页面与 API）
  (auth)/              # 登录
  (chat)/              # 聊天、文件相关页面
  (config)/            # 系统配置
  (memory)/            # 记忆与 RAG 管理
  (schedule)/          # 任务/日程
  (skill)/             # 技能管理
  api/                 # Web 侧 API
  .well-known/workflow/ # Workflow 回调免鉴权路径
components/             # React UI 与 shadcn 组件
hooks/                  # 共享 Hook
lib/                    # 核心业务与基础设施代码
types/                  # 类型定义
scripts/                # 工具脚本
agentd/                 # Go 守护进程源码（Linux-only）
  cmd/agentd            # 运行入口
  internal/             # 核心子模块（agent/sandbox/security 等）
```

---

## 核心能力（精简）

### Web 侧
- 多会话流式聊天、会话搜索、历史回溯
- 多渠道 Bot（Telegram/Discord/Slack/Feishu/Teams）与统一通知路由
- Skills、Provider、工具、MCP、Soul、审计与监控配置
- Workflow 持久化执行与 L1/L2 安全审批流
- RAG/内置记忆管理

### Daemon 侧
- 文件与终端类工具执行（含会话化多步 Agent）
- 沙箱调度：`docker`、`docker-strict`、`lxc`
- 三层安全：L0 规则、L1 打分、L2 用户授权
- 多节点注册、心跳与资源上报
- 任务事件总线与 worker pool

---

## 快速部署

### 1) Web（Vercel）

1. 准备 `AUTH_SECRET`、`USERNAME`、`PASSWORD`、`BLOB_ACCESS`
2. 需要联网搜索可选填 `TAVILY_API_KEY`
3. 部署到 Vercel（按项目 README 内按钮或手动部署）

### 2) Daemon（Linux）

```bash
cd agentd
go build -o agentd ./cmd/agentd/
cp agentd.toml.example agentd.toml
cp agentd.toml /etc/agentd/agentd.toml   # 示例
sudo ./agentd -config /etc/agentd/agentd.toml
```

Linux 环境、Docker/LXC 可按需安装；如需浏览器/GUI 类工具，需通过 daemon 配置启用相应 sandbox。

> 方向分离：  
> **Daemon → Web** 始终走 HTTPS + API Key；  
> **Web → Daemon** 才走 mTLS（当 daemon 可被公网访问时）。

完整部署细节请见 [`agentd/README.md`](./agentd/README.md)。

---

## 环境变量（Web）

- `AUTH_SECRET`、`USERNAME`、`PASSWORD`
- `DATABASE_URL`（生产运行时必填）
- `BLOB_ACCESS`
- `BLOB_READ_WRITE_TOKEN`（如用 Vercel Blob）
- `TAVILY_API_KEY`（可选）
- `AGENTD_API_KEY`（与 daemon 配置中的 `clawless_api_key` 一致）
- `AGENTD_CLIENT_CERT_PATH` / `AGENTD_CLIENT_KEY_PATH` / `AGENTD_CA_PATH`（仅在 Web 需要主动访问 daemon 时）

---

## 常用命令

- `yarn dev`：启动 Web 开发环境
- `yarn build`：构建 Web
- `yarn lint:check`：提交前必跑（`tsc --noEmit && biome check .`）
- `yarn test`：运行全部 Web 测试
- `yarn db:generate`：生成 Drizzle 变更
- `yarn db:push`：推送 schema 到数据库
- `go test ./...`：运行 daemon 测试（在 `agentd/` 下）
- `go build -o agentd ./cmd/agentd/`：构建 daemon

---

## IM 命令（节选）

`/start`、`/new`、`/session`、`/stop`、`/cancel`、`/retry`、`/model`、`/approve`、`/reject`、`/compact`、`/help`、`/memory`

---

## 贡献

提交 PR 或发 Issue。项目采用 MIT 许可证。
