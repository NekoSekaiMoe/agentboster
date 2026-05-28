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
>
> 在版本号没有达到 1.0 之前，我建议你可以把本项目当作一个尝鲜，我们不保证向前的兼容性。
>
> Until version 1.0 is released, I suggest you treat this as a try. We cannot guarantee full backwards compatibility at this stage.

![AgentBoster](.docs/public/images/preview.png)

AgentBoster 是一个 **Serverless AI Agent 平台**，由两部分组成：

- **AgentBoster Web** — 基于 Next.js 的前端 Dashboard，部署在 Vercel 上，提供聊天界面、配置管理、Bot 适配器
- **Agent Daemon** — 基于 Go 的 Linux 守护进程，运行在用户的 Linux 服务器上，提供沙箱执行、安全审查、任务调度。Daemon 不接触 IM，不发送通知；所有 IM 通知由 AgentBoster Web 处理

AgentBoster 拥有你对 AI Agent 的核心需求：Chat、Skills、Memory (with RAG)、Multi-Channel Bot、Sandbox 执行、Workflow，而且是 **Serverless 的**。

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Vercel (Serverless)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Next.js Web  │  │  API Routes  │  │  Workflow (Cron)  │  │
│  │  Dashboard    │  │  /api/*      │  │  DevKit           │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────┘  │
│         │                  │                                  │
│         │    mTLS + API Key │                                  │
│         ▼                  ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐│
│  │              AgentBoster API Gateway                        ││
│  └──────────────────────────┬───────────────────────────────┘│
└─────────────────────────────┼─────────────────────────────────┘
                              │ mTLS
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   User's Linux Server                        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Agent Daemon (Go)                      │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │ │
│  │  │ LLM Loop │ │ Sandbox  │ │ Security │ │ Session   │  │ │
│  │  │ Agent    │ │ Manager  │ │ L0/L1/L2 │ │ Manager   │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │ │
│  │                                                         │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              Sandbox Providers                     │  │ │
│  │  │  tmpfs  │  chroot  │  Docker                      │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  │                                                         │ │
│  │  ┌───────────────────────────────────────────────────┐  │ │
│  │  │              IM Channels                           │  │ │
│  │  │  Telegram  │  Discord  │  Slack  │  Feishu        │  │ │
│  │  └───────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 功能特性

### AgentBoster Web (Next.js)
- **Chat** — 多会话聊天，支持流式响应、消息回溯、会话搜索/置顶
- **Skills** — 技能管理，动态加载
- **Memory** — RAG 向量搜索记忆
- **Config** — Provider、Channel、Agent 配置
- **Sandbox** — 沙箱管理与监控
- **Multi-Channel Bot** — Slack、Teams、Google Chat、Telegram 适配器

### Agent Daemon (Go)
- **LLM Agent Loop** — 工具调用、多步推理、Sub-agent
- **20+ MVP Tools** — 文件读写、Shell 执行、Git、Web 搜索/抓取、Sub-agent 等
- **三层安全防护** — L0 规则过滤 → L1 AI 评分 → L2 用户授权
- **统一决策队列** — L2 安全授权 + LLM 提问 + 冲突解决 + 任务分支，串行/并发混合调度
- **三种沙箱** — tmpfs（AI 动态评估大小）、chroot（持久化）、Docker（强隔离）
- **Webhook 回调** — 任务完成或需要用户决策时，通过 HTTP 回调通知 AgentBoster Web，由 Web 端负责 IM 通知
- **Session 管理** — 会话持久化、LRU 淘汰、归档、abort 控制

---

## 技术栈

### AgentBoster Web
| 类别 | 技术 |
|------|------|
| 框架 | Next.js 15.5.9 (App Router, RSC) |
| UI | React 19, Tailwind CSS 3, shadcn/ui, Framer Motion |
| AI | Vercel AI SDK 6 (Anthropic, Google, OpenAI) |
| Chat | Chat SDK (Slack, Teams, GChat, Telegram) |
| 数据库 | Drizzle ORM + Neon Postgres |
| 缓存 | Upstash Redis |
| 存储 | Vercel Blob |
| 工作流 | Vercel Workflow DevKit |
| 沙箱 | Vercel Sandbox |
| 工具 | Biome (lint/format), Node.js (runtime) |

### Agent Daemon
| 类别 | 技术 |
|------|------|
| 语言 | Go 1.26.2 (Linux-only) |
| HTTP | Gin |
| 配置 | Viper (TOML) |
| 事件 | 自研 Event Bus |
| 通信 | mTLS + API Key |

---

## Deploy

### AgentBoster Web → Vercel

你不需要下载到本地，也不需要 VPS，你只需要：

- 一个 Vercel 账号（免费版即可）
- 一个和 OpenAI/Anthropic/Gemini 兼容的 API Key
- 点击下方按钮部署

<p align="center">
	<a href=https://vercel.com/new/clone?repository-url=https://github.com/NekoSekaiMoe/agentboster&stores=[{"type":"blob"},{"type":"integration","productSlug":"upstash-kv","integrationSlug":"upstash"},{"type":"integration","protocol":"storage","productSlug":"neon","integrationSlug":"neon"}]&env=AUTH_SECRET,USERNAME,PASSWORD&envDescription=Do_not_disclose_them_and_keep_them_safe.&project-name=agentboster&repository-name=agentboster target="_blank">
		<img src="https://vercel.com/button" alt="Deploy with Vercel" width="120" />
	</a>
</p>

### Agent Daemon → Linux Server

在你的 Linux 服务器上：

```bash
# 克隆仓库
git clone https://github.com/Niapya/agentboster.git
cd agentboster/agentd

# 编译（需要 Go 1.26+）
go build -o agentd ./cmd/agentd/

# 首次运行生成默认配置
./agentd -config agentd.toml

# 编辑配置
vim agentd.toml

# 启动
./agentd
```

---

## Quick Start

### 1. 配置环境变量

部署时需要 `AUTH_SECRET`、`USERNAME`、`PASSWORD` 三个环境变量，**不要泄漏**。

### 2. 登录并配置

打开部署链接 → 登录 → 进入「Config」→ 添加 Provider（OpenAI Compatible）→ 设置 `Default Model` 和 `Embedding Model`。

### 3. 配置 Agent Daemon

在 `agentd.toml` 中配置：

```toml
[server]
listen = ":18732"
agentboster_api_key = "your-api-key"

[agentboster]
base_url = "https://your-agentboster.vercel.app"
client_cert_path = "/path/to/client.crt"
client_key_path = "/path/to/client.key"
ca_path = "/path/to/ca.crt"

[sandbox]
default = "tmpfs"
chroot_base = "/var/lib/agentd/chroots"
docker_socket = "unix:///var/run/docker.sock"
allowed_images = ["ubuntu:22.04", "ubuntu:24.04", "alpine:latest", "golang:1.22", "node:20", "python:3.12"]
```

### 4. 连接 IM

进入 Channel 配置 → 设置 IM Bot Token → 配置 Webhook → 设置白名单。

### 5. 开始聊天

在 Web Chat 或 IM 中与 Agent 对话。

---

## 沙箱

| 类型 | 隔离级别 | 持久化 | 大小策略 | 适用场景 |
|------|---------|--------|---------|---------|
| **tmpfs** | 低（内存目录） | 可选 | AI 动态评估 + Daemon 内存探测 | 轻量临时任务 |
| **chroot** | 中（文件系统隔离） | 总是持久 | rootfs 多来源（URL/本地/preset） | 需要持久文件系统的开发任务 |
| **Docker** | 高（完整容器隔离） | 可选 | 镜像白名单 + 资源限制 | 高风险命令、需要强隔离的任务 |

tmpfs 大小由 AI 评估（轻任务 15-50MB，中任务 50-200MB，重任务 200-500MB），Daemon 探测 zram → 物理内存 → swap 三级可用空间后决定最终分配。执行中空间不足时自动扩容（上限 = min(当前 × 3, 可用内存 × 60%)）。

chroot rootfs 支持 6 种来源（按优先级）：用户指定路径 → 用户指定 URL → presets → 本地预置 → 默认 URL 下载 → 复制宿主机二进制。下载的 rootfs 自动缓存，后台定期清理过期文件（默认 30 天）。

---

## Security

- **L0** — 预定义规则，直接拒绝危险命令（`rm -rf /`、`chmod 777` 等）
- **L1** — LLM 评分，对命令进行风险评分（低/中/高）
- **L2** — 高风险命令需用户通过 Web UI 或 IM 按钮确认（pass_once/pass_until/reject_once/reject_until）
- **Decision Queue** — 统一决策队列，L2 授权 + LLM 提问 + 冲突解决 + 任务分支
- **Prompt Injection Defense** — System Prompt 内置注入防御规则
- **Docker 白名单** — 只允许白名单中的镜像
- **mTLS** — AgentBoster Web ↔ Agent Daemon 双向 TLS 认证。Daemon 不存储任何 IM Token，不知道用户使用的 IM 平台

---

## Development

```bash
cd your-agentboster

yarn install
yarn vercel pull   # 拉取环境变量
yarn dev           # 启动开发服务器
```

如果遇到 database schema 错误，运行 `yarn postbuild` 执行数据库迁移。

Agent Daemon 开发：

```bash
cd agentd
go build -o agentd ./cmd/agentd/
./agentd -config agentd.toml
```

---

## Others

我正在找工作，如果你对我有兴趣，请联系我。

如果你有任何想法或者发现了问题，请随时提交 Pull Request 或者在 Issues 中提出，欢迎任何形式的贡献。

前端 UI 基于 [ClawLess](https://github.com/Niapya/clawless) 修改而来，感谢 ClawLess 项目提供的 Dashboard 基础和灵感。

感谢 OpenClaw 和 Manus 的灵感来源，Vercel 作为部署平台，还有所有用到的开源库，以及**你**。

本项目使用 MIT License.
