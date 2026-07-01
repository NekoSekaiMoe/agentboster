# AgentBoster 本地部署指南

> 本文档帮助你在自有服务器上部署 AgentBoster，脱离 Vercel 等云平台，实现完全自主可控的本地运行环境。
>
> **适用人群**：不熟悉 Vercel，只想在本地服务器（Linux/Docker）上运行完整 AgentBoster 的用户。

---

## 一、为什么需要本地部署

AgentBoster 默认配置面向 Vercel 云平台优化（Neon Serverless Postgres、Vercel Blob 对象存储、Upstash Redis），这套方案对个人用户友好，但在以下场景下你可能需要本地部署：

1. **数据主权**：企业或合规要求要求所有数据存储在自有基础设施内，不能使用云服务
2. **成本控制**：长期运行或多用户场景下，云服务免费额度不够用，自建成本更低
3. **离线/内网环境**：政企、特殊网络环境下无法访问外部云服务
4. **完全可控**：希望掌握完整技术栈，避免依赖外部 SaaS 平台

本文档将指导你从零开始在本地服务器搭建完整的 AgentBoster 运行环境。

---

## 二、AgentBoster 架构简介

在开始部署前，需要理解 AgentBoster 由三个独立部分组成：

```
┌─────────────────────────────────────────────────────────────┐
│  ① Web 层 (Next.js)                                         │
│  - 浏览器 UI、API 服务、会话管理                              │
│  - Workflow 编排引擎                                         │
│  - 依赖：Postgres + Redis + 对象存储                         │
└─────────────────────────────────────────────────────────────┘
           ▲                    ▲
           │ HTTPS API          │ HTTPS API
           │                    │
┌──────────┴──────────┐    ┌───┴──────────────────────────┐
│  ② CLI (可选)        │    │  ③ agentd (可选)              │
│  终端客户端           │    │  Linux 守护进程                │
│  本地工具执行         │    │  沙箱工具执行 + 安全隔离       │
└─────────────────────┘    └──────────────────────────────┘
```

### 各部分职责

| 组件 | 作用 | 本地部署是否必需 |
|------|------|-----------------|
| **Web** | 核心服务，提供 UI、API、数据持久化、Workflow 编排 | ✅ **必需** |
| **agentd** | 在独立主机上执行沙箱工具（shell、文件、浏览器等） | ⚠️ 可选（无 agentd 时工具能力受限） |
| **CLI** | 终端交互客户端，通过 `agentboster login` 连接 Web | ⚠️ 可选（可以只用浏览器） |

**本文档重点**：部署 **Web 层**（这是 AgentBoster 的核心）。agentd 和 CLI 的部署见各自文档。

---

## 三、前置准备

### 3.1 硬件要求

**最低配置**（单机全栈）：
- CPU：2 核心
- 内存：4GB
- 磁盘：20GB（含数据库和依赖）
- 操作系统：Linux（推荐 Ubuntu 22.04/Debian 12/RHEL 9）

**推荐配置**（生产环境）：
- CPU：4 核心
- 内存：8GB
- 磁盘：50GB SSD

### 3.2 软件依赖

在开始前，确保服务器已安装：

```bash
# 1. Node.js 22.x（必需）
node --version  # 应输出 v22.x.x

# 2. Yarn 1.x（包管理器）
yarn --version  # 应输出 1.x.x

# 3. PostgreSQL 14+（数据库）
psql --version  # 应输出 14.x 或更高

# 4. Redis 6+（缓存和状态存储）
redis-cli --version  # 应输出 6.x 或更高

# 5. Docker（可选，用于容器化部署）
docker --version
```

**安装指南**（以 Ubuntu 为例）：

```bash
# 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 Yarn
sudo npm install -g yarn

# 安装 PostgreSQL
sudo apt-get install -y postgresql postgresql-contrib

# 安装 Redis
sudo apt-get install -y redis-server

# 启动服务
sudo systemctl enable --now postgresql
sudo systemctl enable --now redis-server
```

### 3.3 网络要求

- 如果需要外部访问（浏览器、IM 机器人回调），需要：
  - 公网 IP 或内网穿透
  - 域名（推荐，用于 HTTPS）
  - 防火墙开放 80/443 端口

- 如果仅内网使用，可跳过域名和公网 IP

---

## 四、核心依赖服务配置

在启动 Web 之前，需要先配置三个核心依赖：Postgres、Redis、对象存储。

### 4.1 配置 PostgreSQL

AgentBoster 使用 Postgres 存储所有会话、用户、配置数据，并依赖 `pgvector` 扩展实现向量检索（用于长期记忆）。

#### 步骤 1：创建数据库和用户

```bash
# 切换到 postgres 用户
sudo -u postgres psql

-- 在 psql 中执行：
CREATE DATABASE agentboster;
CREATE USER agentboster_user WITH PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE agentboster TO agentboster_user;

-- 授予 schema 权限（Postgres 15+ 需要）
\c agentboster
GRANT ALL ON SCHEMA public TO agentboster_user;
GRANT CREATE ON SCHEMA public TO agentboster_user;

-- 退出
\q
```

#### 步骤 2：安装 pgvector 扩展

```bash
# Ubuntu/Debian
sudo apt-get install -y postgresql-16-pgvector  # 替换 16 为你的 Postgres 版本

# RHEL/CentOS
sudo yum install -y pgvector_16  # 替换 16 为你的版本
```

在数据库中启用扩展：

```bash
sudo -u postgres psql -d agentboster -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

#### 步骤 3：配置远程连接（如果 Postgres 和 Web 不在同一台机器）

编辑 `/etc/postgresql/16/main/postgresql.conf`：

```conf
listen_addresses = '*'  # 或指定 IP
```

编辑 `/etc/postgresql/16/main/pg_hba.conf`，添加：

```conf
host    agentboster    agentboster_user    0.0.0.0/0    scram-sha-256
```

重启 Postgres：

```bash
sudo systemctl restart postgresql
```

#### 步骤 4：获取连接字符串

```bash
# 格式：postgresql://用户名:密码@主机:端口/数据库名
# 示例：
postgresql://agentboster_user:your_secure_password@localhost:5432/agentboster
```

**记下这个连接字符串**，后续配置 `DATABASE_URL` 环境变量时需要用到。

### 4.2 配置 Redis

AgentBoster 使用 Redis 存储两类数据：
1. 应用全局配置和分布式锁
2. IM 机器人会话状态

#### 步骤 1：配置 Redis（默认配置通常够用）

编辑 `/etc/redis/redis.conf`（如果需要远程访问）：

```conf
bind 0.0.0.0  # 允许远程连接（注意安全）
requirepass your_redis_password  # 设置密码（强烈推荐）
```

重启 Redis：

```bash
sudo systemctl restart redis-server
```

#### 步骤 2：获取连接字符串

```bash
# 无密码（不推荐）：
redis://localhost:6379

# 有密码：
redis://:your_redis_password@localhost:6379

# 远程 Redis：
redis://:password@redis-host:6379
```

**记下这两个环境变量的值**：
- `REDIS_URL`：用于 IM 状态存储（`@chat-adapter/state-redis`）
- Redis 的 REST API URL（Upstash 兼容）：用于全局 KV 存储

**重要说明**：AgentBoster 当前代码使用 Upstash Redis SDK，它期望两种不同的连接方式：
1. `REDIS_URL`（标准 Redis 协议）：用于 IM 状态
2. `KV_REST_API_URL` + `KV_REST_API_TOKEN`（Upstash REST API）：用于全局配置

**本地 Redis 适配方案**：

如果你使用本地 Redis（非 Upstash），需要以下两种方案之一：

**方案 A**（推荐）：使用 Upstash Redis 的兼容模式

```bash
# 安装 @upstash/redis（它支持标准 Redis 协议）
# 在 .env.local 中配置：
REDIS_URL=redis://localhost:6379
KV_REST_API_URL=http://localhost:8079  # 使用 upstash-redis-rest-proxy（见下文）
KV_REST_API_TOKEN=your_local_token
```

**方案 B**：修改代码，统一使用 `ioredis`（需改造，见后文"自托管改造清单"）

### 4.3 配置对象存储

AgentBoster 使用对象存储保存：
- 用户上传的附件
- 技能仓库同步产物

默认配置使用 Vercel Blob，本地部署需要替换为：

**推荐方案**：

| 方案 | 适用场景 | 配置复杂度 |
|------|----------|----------|
| **MinIO**（自托管 S3 兼容） | 完全离线、单机全栈 | 中 |
| **Cloudflare R2** | 低成本云存储（10GB 免费） | 低 |
| **AWS S3** | 生产级可靠性 | 低 |
| **阿里云 OSS / 腾讯云 COS** | 国内网络环境 | 低 |

#### 方案 1：MinIO（推荐本地部署）

MinIO 是兼容 S3 协议的开源对象存储，可以在本地服务器运行。

**Docker 快速启动**：

```bash
docker run -d \
  --name minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  -v /data/minio:/data \
  minio/minio server /data --console-address ":9001"
```

**访问 MinIO 控制台**：`http://localhost:9001`（用户名/密码：`minioadmin`/`minioadmin`）

**创建 Bucket 和 Access Key**：

1. 登录控制台，创建 Bucket（如 `agentboster`）
2. 进入 "Access Keys"，创建新的 Access Key，记下 `Access Key` 和 `Secret Key`

**环境变量配置**（记下以备后用）：

```bash
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=agentboster
S3_ACCESS_KEY_ID=your_access_key
S3_SECRET_ACCESS_KEY=your_secret_key
S3_REGION=us-east-1  # MinIO 可以使用任意 region
```

#### 方案 2：Cloudflare R2

R2 提供 10GB 免费存储，无出口流量费用，适合小规模部署。

1. 注册 Cloudflare 账号，进入 R2 控制台
2. 创建 Bucket（如 `agentboster`）
3. 创建 API Token，获取 `Access Key ID` 和 `Secret Access Key`
4. 获取 R2 的 S3 兼容端点（格式：`https://<account_id>.r2.cloudflarestorage.com`）

**环境变量配置**：

```bash
S3_ENDPOINT=https://<your-account-id>.r2.cloudflarestorage.com
S3_BUCKET=agentboster
S3_ACCESS_KEY_ID=your_r2_access_key
S3_SECRET_ACCESS_KEY=your_r2_secret_key
S3_REGION=auto
```

---

## 五、Web 层部署（核心）

现在开始部署 AgentBoster 的核心 Web 服务。

### 5.1 获取代码

```bash
# 克隆仓库
git clone https://github.com/your-org/agentboster.git
cd agentboster

# 切换到稳定版本（可选，推荐生产环境）
git checkout v0.1.0  # 替换为最新 release 版本
```

### 5.2 配置环境变量

创建 `.env.local` 文件（Next.js 会自动加载）：

```bash
nano .env.local
```

**完整环境变量清单**：

```bash
# ==================== 核心配置 ====================

# 运行环境（必需）
NODE_ENV=production

# 应用基础 URL（必需，用于 IM webhook 回调）
# 如果有域名：https://your-domain.com
# 仅内网：http://your-server-ip:3000
APP_BASE_URL=https://your-domain.com

# 认证密钥（必需，用于 session 加密和 bot webhook 验证）
# 生成方式：openssl rand -base64 32
AUTH_SECRET=your_random_secret_here

# ==================== 数据库配置 ====================

# PostgreSQL 连接字符串（必需）
DATABASE_URL=postgresql://agentboster_user:your_secure_password@localhost:5432/agentboster

# ==================== Redis 配置 ====================

# 方案 A：使用 Upstash Redis（或兼容服务）
KV_REST_API_URL=https://your-upstash-redis.upstash.io
KV_REST_API_TOKEN=your_upstash_token

# IM 状态存储（必需）
REDIS_URL=redis://:your_redis_password@localhost:6379

# ==================== 对象存储配置 ====================

# 使用 MinIO/S3/R2（需要修改代码以支持，见后文"自托管改造清单"）
# 当前版本使用 Vercel Blob，本地部署需要以下配置：
BLOB_READ_WRITE_TOKEN=vercel_blob_token  # 如果保留 Vercel Blob

# 或者（未来支持）：
# STORAGE_DRIVER=s3
# S3_ENDPOINT=http://localhost:9000
# S3_BUCKET=agentboster
# S3_ACCESS_KEY_ID=your_access_key
# S3_SECRET_ACCESS_KEY=your_secret_key
# S3_REGION=us-east-1

# ==================== Workflow 配置 ====================

# 切换到 Postgres World（自托管关键配置）
WORKFLOW_TARGET_WORLD=@workflow/world-postgres

# ==================== agentd 配置（可选） ====================

# agentd API 密钥（如果部署了 agentd）
# 生成方式：openssl rand -hex 32
AGENTD_API_KEY=your_agentd_api_key

# mTLS 证书路径（可选，用于 Web <-> agentd 加密通信）
# AGENTD_CLIENT_CERT_PATH=/path/to/client-cert.pem
# AGENTD_CLIENT_KEY_PATH=/path/to/client-key.pem
# AGENTD_CA_CERT_PATH=/path/to/ca-cert.pem

# ==================== 初始用户配置 ====================

# 首次启动时创建的管理员账号（可选，不设则需手动创建）
USERNAME=admin
PASSWORD=your_admin_password

# ==================== AI 模型配置 ====================

# Anthropic API Key（如果使用 Claude）
ANTHROPIC_API_KEY=sk-ant-xxx

# OpenAI API Key（如果使用 GPT）
OPENAI_API_KEY=sk-xxx

# 其他模型 API Keys（按需配置）
# GOOGLE_GENERATIVE_AI_API_KEY=xxx
# DEEPSEEK_API_KEY=xxx

# ==================== 可选配置 ====================

# 禁用 Next.js 遥测
NEXT_TELEMETRY_DISABLED=1

# 日志级别（可选）
# LOG_LEVEL=info

# 如果需要代理访问外部 API（可选）
# HTTP_PROXY=http://proxy-server:port
# HTTPS_PROXY=http://proxy-server:port
```

**环境变量说明**：

| 变量 | 必需性 | 说明 |
|------|--------|------|
| `NODE_ENV` | ✅ 必需 | 必须设为 `production`，否则性能和行为不正确 |
| `APP_BASE_URL` | ✅ 必需 | 外部访问的完整 URL，用于生成 webhook 回调地址 |
| `AUTH_SECRET` | ✅ 必需 | 用于 session 加密，必须是随机字符串 |
| `DATABASE_URL` | ✅ 必需 | Postgres 连接字符串 |
| `REDIS_URL` | ✅ 必需 | Redis 连接字符串（标准协议） |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | ✅ 必需 | Upstash Redis REST API 凭证 |
| `WORKFLOW_TARGET_WORLD` | ✅ 必需（自托管） | 设为 `@workflow/world-postgres` 以使用 Postgres 而非 Vercel Queue |
| `BLOB_READ_WRITE_TOKEN` | ⚠️ 当前必需 | Vercel Blob token（未改造前）|
| `AGENTD_API_KEY` | ⚠️ 可选 | 如果部署 agentd 则必需 |
| `USERNAME` / `PASSWORD` | ⚠️ 推荐 | 首次启动自动创建的管理员账号 |
| AI API Keys | ⚠️ 推荐 | 至少配置一个 LLM provider |

**重要提醒**：

1. **不要设置 `VERCEL=1` 或 `VERCEL_ENV`**：这些是 Vercel 平台的环境变量，自托管时设置会导致逻辑走错分支
2. **`APP_BASE_URL` 必须是可从外部访问的地址**：如果你使用 IM 机器人（Telegram、Discord 等），这个 URL 必须能被 IM 平台的服务器访问到
3. **`AUTH_SECRET` 必须保密**：泄露会导致 session 被伪造

### 5.3 安装依赖

```bash
# 在 agentboster 根目录执行
yarn install --frozen-lockfile
```

**注意**：根目录使用 Yarn Classic（1.x），不是 Yarn Berry。`cli/` 子目录是独立仓库，不需要在这里安装。

### 5.4 初始化数据库

在启动应用之前，需要推送数据库 schema 并确保 pgvector 扩展已启用。

```bash
# 1. 确保 pgvector 扩展存在
yarn db:ensure-vector

# 2. 推送 Drizzle schema 到数据库
yarn db:push
```

**这两步是幂等的**，重复执行不会破坏数据。但如果你升级到新版本，schema 可能有 breaking change，升级前请查看 CHANGELOG。

**验证数据库**：

```bash
# 连接数据库查看表
psql $DATABASE_URL -c "\dt"

# 应该看到类似以下的表：
# messages, users, agentd_nodes, l2_decisions, long_term_memories, chunks, ...
```

### 5.5 构建应用

```bash
yarn build
```

这一步会：
1. 编译 Next.js（RSC + Client Components）
2. 运行 Workflow DevKit 的 `withWorkflow` 注入，生成 `app/.well-known/workflow/v1/*` 端点
3. 输出构建产物到 `.next/` 目录

**注意**：
- `yarn build` 不会执行 `postbuild` 脚本（因为它门控在 `VERCEL=1 && VERCEL_ENV=production`）
- 你已经手动执行了 `yarn db:push`，所以不需要 postbuild
- 构建时长约 1-3 分钟（取决于服务器性能）

**常见构建错误**：

| 错误 | 原因 | 解决方案 |
|------|------|---------|
| `DATABASE_URL is not set` | 环境变量未加载 | 确保 `.env.local` 在项目根目录 |
| `Cannot find module @neondatabase/serverless` | 依赖未安装 | 运行 `yarn install` |
| TypeScript 错误 | 代码类型问题 | 构建会忽略（`next.config.ts` 配置了 `ignoreBuildErrors`），可以继续 |

### 5.6 启动应用

```bash
yarn start
```

默认监听 `0.0.0.0:3000`。可以通过 `PORT` 环境变量改变端口：

```bash
PORT=8080 yarn start
```

**首次启动时的日志**：

```
[db:ensure-vector] ensuring pgvector extension
[db:ensure-vector] pgvector extension is ready
[seedInitialUser] Creating initial user: admin
[seedInitialUser] Initial user created successfully
 ▲ Next.js 15.5.9
 - Local:        http://0.0.0.0:3000
 - Network:      http://192.168.1.100:3000

 ✓ Ready in 2.3s
```

**验证启动成功**：

```bash
# 本地访问
curl http://localhost:3000/

# 应该返回 HTML（重定向到登录页）
```

### 5.7 启动 graphile-worker（关键！）

如果你设置了 `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`，你**必须**启动 graphile-worker 进程，否则 workflow 任务会被入队但永不执行。

**现象**：如果忘记启动 worker，用户发消息后会一直转圈，没有任何响应。

**启动方式**：

在**另一个终端**或使用进程管理器（见后文），运行：

```bash
# 方式 1：使用 npx
npx graphile-worker --connection-string "$DATABASE_URL"

# 方式 2：使用代码脚本（如果项目提供了 scripts/worker.ts）
npx tsx scripts/worker.ts
```

**验证 worker 运行**：

```bash
# 查看进程
ps aux | grep graphile-worker

# 应该看到类似：
# user  12345  graphile-worker --connection-string postgresql://...
```

**注意**：
- graphile-worker 是**独立进程**，与 `yarn start` 分开运行
- 它需要访问同一个 `DATABASE_URL`
- 如果 worker 崩溃，workflow 会停滞，需要重启 worker

---

## 六、访问和验证

### 6.1 浏览器访问

在浏览器中打开：

```
http://localhost:3000
```

或者如果配置了域名：

```
https://your-domain.com
```

**首次访问**：

1. 会自动重定向到登录页 `/login`
2. 使用 `.env.local` 中配置的 `USERNAME` 和 `PASSWORD` 登录
3. 登录成功后进入聊天界面

### 6.2 发送测试消息

1. 在聊天输入框输入：`你好，请做个自我介绍`
2. 点击发送

**预期行为**：
- 消息立即显示在界面
- 出现"思考中"状态
- 几秒后 AI 回复出现

**如果一直转圈不响应**：
- 检查 graphile-worker 是否启动（`ps aux | grep graphile`）
- 检查 `yarn start` 的日志是否有错误
- 检查数据库连接是否正常（`psql $DATABASE_URL -c "SELECT 1"`）

### 6.3 验证数据持久化

```bash
# 查询 messages 表
psql $DATABASE_URL -c "SELECT id, role, content FROM messages LIMIT 5;"

# 应该看到你刚才发送的消息和 AI 的回复
```

### 6.4 验证 Workflow 运行

```bash
# 使用 workflow inspect 工具
npx workflow inspect runs --backend @workflow/world-postgres

# 应该看到最近的 workflow run 记录
```

---

## 七、生产环境部署建议

### 7.1 使用反向代理

**`yarn start` 只提供 HTTP 服务**，生产环境必须在前面加反向代理来处理：
- HTTPS/TLS 终止
- 域名绑定
- 静态资源缓存
- 请求限流
- 日志记录

**推荐方案 A：Caddy（最简单）**

Caddy 自动申请和续期 Let's Encrypt 证书。

安装 Caddy：

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

配置 Caddy（`/etc/caddy/Caddyfile`）：

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
    
    # 日志
    log {
        output file /var/log/caddy/agentboster.log
    }
    
    # 请求体大小限制（用于文件上传）
    request_body {
        max_size 100MB
    }
}
```

启动 Caddy：

```bash
sudo systemctl enable --now caddy
```

**推荐方案 B：Nginx**

安装 Nginx 和 Certbot：

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

配置 Nginx（`/etc/nginx/sites-available/agentboster`）：

```nginx
upstream agentboster_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80;
    server_name your-domain.com;
    
    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    # SSL 证书（Certbot 自动配置）
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    
    # 请求体大小限制
    client_max_body_size 100M;
    
    # 超时配置（用于长时间 SSE 连接）
    proxy_read_timeout 300s;
    proxy_connect_timeout 75s;
    
    location / {
        proxy_pass http://agentboster_backend;
        proxy_http_version 1.1;
        
        # 转发真实 IP
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持（如果未来需要）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    
    # 日志
    access_log /var/log/nginx/agentboster-access.log;
    error_log /var/log/nginx/agentboster-error.log;
}
```

启用配置并申请证书：

```bash
# 启用配置
sudo ln -s /etc/nginx/sites-available/agentboster /etc/nginx/sites-enabled/
sudo nginx -t  # 测试配置
sudo systemctl reload nginx

# 申请 Let's Encrypt 证书
sudo certbot --nginx -d your-domain.com
```

### 7.2 进程管理

`yarn start` 运行的是前台进程，SSH 断开会退出。生产环境需要使用进程管理器。

**推荐方案 A：systemd（Linux 原生，最推荐）**

创建 systemd 服务文件 `/etc/systemd/system/agentboster-web.service`：

```ini
[Unit]
Description=AgentBoster Web Service
After=network.target postgresql.service redis.service
Requires=postgresql.service redis.service

[Service]
Type=simple
User=agentboster
WorkingDirectory=/home/agentboster/agentboster
EnvironmentFile=/home/agentboster/agentboster/.env.local
ExecStart=/usr/bin/yarn start
Restart=always
RestartSec=10

# 安全加固
NoNewPrivileges=true
PrivateTmp=true

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentboster-web

[Install]
WantedBy=multi-user.target
```

创建 graphile-worker 服务文件 `/etc/systemd/system/agentboster-worker.service`：

```ini
[Unit]
Description=AgentBoster Workflow Worker
After=network.target postgresql.service agentboster-web.service
Requires=postgresql.service

[Service]
Type=simple
User=agentboster
WorkingDirectory=/home/agentboster/agentboster
EnvironmentFile=/home/agentboster/agentboster/.env.local
ExecStart=/usr/bin/npx graphile-worker --connection-string ${DATABASE_URL}
Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentboster-worker

[Install]
WantedBy=multi-user.target
```

启用并启动服务：

```bash
# 创建专用用户（推荐）
sudo useradd -r -s /bin/bash -d /home/agentboster -m agentboster
sudo chown -R agentboster:agentboster /home/agentboster/agentboster

# 重载 systemd 配置
sudo systemctl daemon-reload

# 启用开机自启
sudo systemctl enable agentboster-web agentboster-worker

# 启动服务
sudo systemctl start agentboster-web agentboster-worker

# 查看状态
sudo systemctl status agentboster-web
sudo systemctl status agentboster-worker

# 查看日志
sudo journalctl -u agentboster-web -f
sudo journalctl -u agentboster-worker -f
```

**推荐方案 B：PM2（Node 生态传统选择）**

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动应用
pm2 start "yarn start" --name agentboster-web
pm2 start "npx graphile-worker --connection-string $DATABASE_URL" --name agentboster-worker

# 设置开机自启
pm2 startup
pm2 save

# 查看状态和日志
pm2 status
pm2 logs agentboster-web
```

### 7.3 Docker 部署（可选）

如果你熟悉 Docker，可以使用容器化部署。仓库根目录已提供 `Dockerfile`。

#### 单机 Docker Compose 方案

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: agentboster
      POSTGRES_USER: agentboster_user
      POSTGRES_PASSWORD: your_secure_password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agentboster_user -d agentboster"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass your_redis_password
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "--raw", "incr", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    ports:
      - "9000:9000"
      - "9001:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  web:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://agentboster_user:your_secure_password@postgres:5432/agentboster
      REDIS_URL: redis://:your_redis_password@redis:6379
      KV_REST_API_URL: redis://:your_redis_password@redis:6379  # 需要适配
      APP_BASE_URL: https://your-domain.com
      AUTH_SECRET: ${AUTH_SECRET}
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres"
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      USERNAME: admin
      PASSWORD: ${ADMIN_PASSWORD}
    ports:
      - "3000:3000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/', (r) => {process.exit(r.statusCode === 200 || r.statusCode === 307 ? 0 : 1)})"]
      interval: 30s
      timeout: 10s
      retries: 3

  worker:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      web:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://agentboster_user:your_secure_password@postgres:5432/agentboster
    command: ["npx", "graphile-worker", "--connection-string", "postgresql://agentboster_user:your_secure_password@postgres:5432/agentboster"]
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

启动：

```bash
# 创建 .env 文件存放敏感信息
cat > .env <<EOF
AUTH_SECRET=$(openssl rand -base64 32)
ADMIN_PASSWORD=your_admin_password
ANTHROPIC_API_KEY=sk-ant-xxx
EOF

# 启动所有服务
docker-compose up -d

# 查看日志
docker-compose logs -f web

# 初始化数据库（首次启动）
docker-compose exec web yarn db:ensure-vector
docker-compose exec web yarn db:push
```

### 7.4 健康检查和监控

**健康检查端点**：

```bash
# 检查 Web 服务（需要 AGENTD_API_KEY）
curl -H "Authorization: Bearer $AGENTD_API_KEY" \
  http://localhost:3000/api/agentd/v1/health

# 简单存活检查（无需鉴权）
curl http://localhost:3000/
```

**监控建议**：

1. **数据库连接数**：

```bash
# PostgreSQL 连接数监控
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'agentboster';"
```

2. **Redis 内存使用**：

```bash
redis-cli -a your_redis_password INFO memory | grep used_memory_human
```

3. **进程状态**：

```bash
# systemd
sudo systemctl status agentboster-web agentboster-worker

# PM2
pm2 status
```

4. **日志监控**：

```bash
# systemd 日志
sudo journalctl -u agentboster-web --since "10 minutes ago"

# PM2 日志
pm2 logs agentboster-web --lines 100
```

---

## 八、自托管改造清单（当前版本限制）

AgentBoster 当前版本（v0.1.0）的代码是为 Vercel 部署优化的，本地部署需要注意以下限制和改造点：

### 8.1 对象存储（当前必须改造）

**现状**：代码强依赖 `@vercel/blob`

**影响范围**：
- `lib/core/blob/index.ts`：附件上传/下载
- `lib/core/blob/skills.ts`：技能仓库同步产物

**临时方案**：
1. 保留使用 Vercel Blob（需要 Vercel 账号和 `BLOB_READ_WRITE_TOKEN`）
2. 附件功能受限，但不影响核心聊天

**永久方案**（需要修改代码）：

在 `lib/core/blob/index.ts` 中添加 adapter 层：

```typescript
// 伪代码示例
const storageDriver = process.env.STORAGE_DRIVER || 'vercel';

if (storageDriver === 's3') {
  // 使用 @aws-sdk/client-s3
  const s3Client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    },
    region: process.env.S3_REGION || 'us-east-1',
  });
  // 实现 put/get/delete/list 接口
} else {
  // 使用 @vercel/blob（默认）
}
```

### 8.2 Redis KV（需要适配）

**现状**：代码使用两套 Redis SDK：
1. `@upstash/redis`（REST API，需要 `KV_REST_API_URL` + `KV_REST_API_TOKEN`）
2. `@chat-adapter/state-redis`（标准 Redis 协议，需要 `REDIS_URL`）

**影响**：使用本地 Redis 时，第一套无法直接连接（Upstash SDK 期望 REST API）

**临时方案**：
- 使用 Upstash 的免费层（10,000 命令/天）
- 或使用 upstash-redis-rest-proxy（开源工具，将本地 Redis 转为 REST API）

**永久方案**（需要修改代码）：

在 `lib/core/kv/index.ts` 中统一使用 `ioredis` 或 `node-redis`：

```typescript
// 替换 @upstash/redis 为 ioredis
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
```

### 8.3 after() 异步机制（影响 IM webhook）

**现状**：代码使用 `next/server` 的 `after()` API，在 Vercel 上可以延迟到响应后执行，在自托管 `next start` 下会降级为同步等待

**影响范围**：
- `app/api/bot/[authSecret]/[adapter]/callback/route.ts`（3 处）
- `app/(skill)/actions.ts`（1 处）

**问题**：IM webhook 会阻塞到 workflow 完成（几十秒到几分钟），导致 IM 平台超时重试

**临时方案**：
- 如果 IM 平台超时容忍度高（如 Telegram 60 秒），且 workflow 通常较短，可以暂时不改
- 观察是否出现重复消息（超时重试的症状）

**永久方案**（需要修改代码）：

方案 A：使用后台任务队列（如 BullMQ）

```typescript
// 替换 after(() => fetch(...))
await queue.add('process-im-message', { messageId, adapterId });
```

方案 B：fire-and-forget（需测试）

```typescript
// 替换 after(() => fetch(...))
void fetch(...).catch(err => logger.error('background fetch failed', err));
```

### 8.4 数据库驱动（推荐优化，非必需）

**现状**：使用 `@neondatabase/serverless`（HTTP 协议，无连接池）

**问题**：自托管是常驻进程，HTTP 驱动延迟高于 TCP 连接池

**改造方案**（可选）：

替换为 `pg` + TCP 连接池：

```typescript
// lib/core/db/index.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });
```

---

## 九、常见问题

### 9.1 启动后一直转圈，没有响应

**原因**：graphile-worker 未启动

**解决**：

```bash
# 检查 worker 进程
ps aux | grep graphile-worker

# 如果没有，启动它
npx graphile-worker --connection-string "$DATABASE_URL"
```

### 9.2 提示 "KV_REST_API_URL and KV_REST_API_TOKEN env vars are required"

**原因**：代码期望 Upstash Redis REST API 凭证

**解决方案 A**（推荐）：注册 Upstash 免费账号

1. 访问 https://upstash.com/
2. 创建 Redis 数据库
3. 获取 REST API URL 和 Token
4. 配置到 `.env.local`

**解决方案 B**：使用 upstash-redis-rest-proxy（未测试）

### 9.3 文件上传失败

**原因**：`@vercel/blob` 需要 Vercel 凭证

**临时方案**：注册 Vercel 账号，获取 `BLOB_READ_WRITE_TOKEN`

**永久方案**：等待代码适配 S3/MinIO（见"自托管改造清单"）

### 9.4 IM 机器人收到重复消息

**原因**：webhook 超时导致平台重试，触发重复处理

**解决方案**：见"自托管改造清单" → "after() 异步机制"

### 9.5 升级后数据库报错

**原因**：Schema 变更

**解决方案**：

```bash
# 查看当前 schema 与代码的差异
npx drizzle-kit push --dry-run

# 如果安全，推送变更
yarn db:push
```

**警告**：1.0 之前 schema 可能有 breaking change，升级前备份数据库！

### 9.6 如何备份数据

**PostgreSQL 备份**：

```bash
# 备份
pg_dump $DATABASE_URL > agentboster-backup-$(date +%Y%m%d).sql

# 恢复
psql $DATABASE_URL < agentboster-backup-20260701.sql
```

**Redis 备份**：

```bash
# 触发 RDB 快照
redis-cli -a your_redis_password SAVE

# 备份文件位置：/var/lib/redis/dump.rdb
```

---

## 十、性能优化建议

### 10.1 数据库优化

**连接池配置**（如果使用 `pg`）：

```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,  // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

**索引优化**（Drizzle 已定义，无需手动创建）：

```bash
# 查看表索引
psql $DATABASE_URL -c "\d+ messages"
```

### 10.2 Redis 优化

**内存策略**（`/etc/redis/redis.conf`）：

```conf
maxmemory 2gb
maxmemory-policy allkeys-lru  # LRU 淘汰策略
```

### 10.3 Next.js standalone 模式（可选）

启用 standalone 输出可以减小镜像体积（如果使用 Docker）：

在 `next.config.ts` 中添加：

```typescript
const nextConfig: NextConfig = {
  output: 'standalone',  // 添加这一行
  // ... 其他配置
};
```

然后修改 Dockerfile 的 COPY 路径：

```dockerfile
# 替换：
COPY --from=builder /app/.next ./.next
# 为：
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
```

---

## 十一、总结

本文档提供了 AgentBoster Web 层的完整本地部署方案，适合不熟悉 Vercel 的用户。

**部署检查清单**：

- [ ] PostgreSQL 已安装并配置 pgvector 扩展
- [ ] Redis 已安装并配置密码
- [ ] 对象存储已配置（Vercel Blob 或 MinIO/S3）
- [ ] `.env.local` 已创建并填写所有必需变量
- [ ] 依赖已安装（`yarn install`）
- [ ] 数据库已初始化（`yarn db:ensure-vector && yarn db:push`）
- [ ] 应用已构建（`yarn build`）
- [ ] Web 服务已启动（`yarn start`）
- [ ] graphile-worker 已启动
- [ ] 反向代理已配置（Caddy/Nginx）
- [ ] 进程管理已配置（systemd/PM2）
- [ ] 防火墙已开放端口（80/443）
- [ ] 健康检查通过
- [ ] 浏览器访问成功并能发送消息

**后续步骤**：

1. **部署 agentd**（可选）：见 `agentd/README.md`，提供沙箱工具执行能力
2. **安装 CLI**（可选）：见 `cli/README.md`，提供终端交互体验
3. **配置 IM 机器人**（可选）：见主 README 的 IM 接入章节
4. **监控和告警**：配置 Prometheus + Grafana 或使用云监控服务
5. **定期备份**：设置 cron 任务自动备份 Postgres 和 Redis

**获取帮助**：

- 问题反馈：https://github.com/your-org/agentboster/issues
- 社区讨论：见主 README 的联系方式

---

*本文档基于 AgentBoster v0.1.0 编写，面向完全本地部署场景。部分功能（对象存储、Redis KV）当前需要临时依赖云服务或修改代码，未来版本将提供完整的本地适配方案。*
