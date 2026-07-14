# AgentBoster 自托管部署指南

> 在自有服务器上运行完整的 AgentBoster，不依赖 Vercel。
>
> 代码已内置双部署模式：是否为 Vercel 由 `lib/deploy/index.ts` 的 `isVercel`
> 自动判定，DB / KV / Blob 三个后端据此自动切换。自托管无需改任何代码，
> 配好环境变量即可。

---

## 一、架构与部署模式

AgentBoster 由三部分组成，本文档只讲 **Web 层**（核心）：

| 组件 | 作用 | 自托管是否必需 |
|------|------|---------------|
| **Web**（Next.js） | UI、API、数据持久化、Workflow 编排 | ✅ 必需 |
| **agentd**（Go 守护进程） | 在独立 Linux 主机上执行沙箱工具（shell / 文件 / 浏览器 / 桌面） | ⚠️ 可选，无它时代码执行能力受限 |
| **CLI** | 终端客户端 | ⚠️ 可选 |

### 双部署模式怎么切

`lib/deploy/index.ts` 读环境变量判定：Vercel 上 `VERCEL=1`（或存在
`VERCEL_DEPLOYMENT_ID`）→ `isVercel = true`；自托管两者都没有 →
`isSelfHosted`。三个后端据此自动选择：

| 后端 | Vercel | 自托管 |
|------|--------|--------|
| **数据库** | `neon-http`（fetch 驱动） | `pg`（node-postgres，TCP 连接池） |
| **KV** | Upstash Redis（HTTP） | Postgres 表 `kv_store` / `kv_sets` |
| **Blob** | `@vercel/blob` | S3 / MinIO，经 `/api/blob/*` 签名代理路由 |
| **Workflow world** | `@workflow/world-vercel` | `@workflow/world-local`（落盘持久化） |

数据库驱动按 `DATABASE_URL` 主机名自动选：`*.neon.tech` 走 neon，其它走 pg。
可用 `DB_DRIVER=neon|postgres` 强制覆盖。

**关键**：自托管**不需要**独立的 worker 进程。Workflow DevKit 在非 Vercel
环境自动使用 `world-local`，在 `next start` 的常驻进程内直接执行 workflow，
状态落盘到 `.workflow-data/`。

---

## 二、最快路径：Docker Compose

仓库根目录已提供 `docker-compose.yml`，一键拉起 web + postgres(pgvector) +
redis + minio（含自动建桶）。

```bash
# 1. 准备环境变量文件
cp docker.env.example docker.env
# 编辑 docker.env，至少填写 AUTH_SECRET / PASSWORD / 一个模型 API key
#   AUTH_SECRET 生成：openssl rand -base64 32

# 2. 构建并启动
#    必须带 --env-file：docker compose 不会自动读取 docker.env 做变量插值，
#    不带它时 minio/minio-setup 会退回 minioadmin 默认值，与 web 用的 S3 凭据
#    不一致。构建期通过 BuildKit secret 注入 docker.env（不会写进镜像层）。
DOCKER_BUILDKIT=1 docker compose --env-file docker.env up -d --build

# 3. 查看日志（web 容器启动时会自动跑 DB 迁移）
docker compose --env-file docker.env logs -f web
```

启动后访问 `http://localhost:3000`，用 `docker.env` 里的 `USERNAME` /
`PASSWORD` 登录。MinIO 控制台默认只绑定到 `127.0.0.1:9001`（不经 TLS 反代，
不对外暴露）；从宿主机本地访问 `http://localhost:9001`，远程需走 SSH 隧道
（`ssh -L 9001:127.0.0.1:9001 <host>`）或受控管理通道。

容器启动流程（`scripts/docker-entrypoint.sh`）：先跑
`scripts/self-host-migrate.ts`（ensure-vector + drizzle-kit push +
message-version 数据迁移），再 `next start`。迁移是幂等的。多副本部署时可用
`SKIP_DB_MIGRATE=1` 让单独一个 job 负责迁移。

Compose 里 `.workflow-data` 挂了持久卷（`workflow-data`），容器重启不丢在途
workflow。

---

## 三、环境变量

完整清单见 `docker.env.example`。核心项：

```bash
# ── 公共 URL（自托管务必设置）──────────────────────────────
# 用于 bot webhook 回调 URL 和签名的 blob 代理 URL。不设则回退到
# http://127.0.0.1:3000，会导致 webhook 和 LLM 取附件失败。
PUBLIC_APP_URL=https://your-domain.com

# ── 认证 ──────────────────────────────
AUTH_SECRET=<openssl rand -base64 32>   # 也用于 blob 代理和 L2 链接的 HMAC
USERNAME=admin
PASSWORD=<改掉>

# ── 数据库（普通 postgres:// 自动走 pg 驱动）──────────────
DATABASE_URL=postgresql://agentboster_user:pass@postgres:5432/agentboster
# DB_DRIVER=postgres   # 可选，显式覆盖自动判定

# ── KV（Postgres 支持，无需额外配置）─────────────────────
# 自托管 KV 走 kv_store / kv_sets 表，只依赖 DATABASE_URL。
# 下面两个 Upstash 变量仅 Vercel 读，自托管留空即可。
# KV_REST_API_URL=
# KV_REST_API_TOKEN=

# ── Chat 适配器会话状态（普通 TCP Redis）──────────────────
REDIS_URL=redis://:pass@redis:6379

# ── Blob（S3 / MinIO 兼容）───────────────────────────────
S3_ENDPOINT=http://minio:9000        # MinIO / 非 AWS 才需要；真 AWS 留空
S3_BUCKET=agentboster
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true             # MinIO 需要；设了 S3_ENDPOINT 时默认 true

# ── Workflow world（自托管用 local）───────────────────────
WORKFLOW_TARGET_WORLD=local
WORKFLOW_LOCAL_DATA_DIR=/app/.workflow-data   # 落盘目录，建议挂持久卷

# ── 模型（至少配一个）────────────────────────────────────
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# ── agentd（可选）────────────────────────────────────────
# AGENTD_API_KEY=
# AGENTD_URL=https://your-agentd-host:port
```

**注意**：不要在自托管环境设 `VERCEL=1` / `VERCEL_ENV`，否则 `isVercel` 判定
错误，会去连 Upstash / Vercel Blob。

---

## 四、手动部署（不用 Docker）

### 4.1 依赖服务

- **PostgreSQL 14+**，装 `pgvector` 扩展
- **Redis 6+**（仅 chat 适配器会话状态用）
- **S3 兼容对象存储**：MinIO（自托管）、Cloudflare R2、AWS S3 等
- **Node.js 22.x** + **Yarn 1.x**

建库：

```sql
CREATE DATABASE agentboster;
CREATE USER agentboster_user WITH PASSWORD 'pass';
GRANT ALL PRIVILEGES ON DATABASE agentboster TO agentboster_user;
\c agentboster
GRANT ALL ON SCHEMA public TO agentboster_user;
```

pgvector 扩展由迁移脚本自动 `CREATE EXTENSION IF NOT EXISTS vector`，但需先装好
扩展包（如 `apt install postgresql-16-pgvector`）。

MinIO 快速启动 + 建桶：

```bash
# 控制台端口绑定到 127.0.0.1，避免把管理界面暴露到公网；API(9000) 同理，
# 生产环境应只经反代/内网访问。
docker run -d --name minio -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -v /data/minio:/data minio/minio server /data --console-address ":9001"
# 控制台 http://localhost:9001 建桶 agentboster，并创建 Access Key
```

### 4.2 构建与迁移

```bash
yarn install --frozen-lockfile

# 迁移（ensure-vector + drizzle-kit push + message-version 数据迁移，幂等）
yarn db:migrate

yarn build
```

`yarn build` 会跑 Workflow DevKit 打包器——这是唯一能抓 workflow-bundle 违规的
关卡，务必确认它通过。

### 4.3 启动

```bash
yarn start          # 默认 0.0.0.0:3000，改端口用 PORT=8080
```

Next.js 的 `instrumentation.ts` 在进程启动时预热 pg 连接池（自托管路径），
`next start` 会等它就绪后再服务请求。**不需要任何额外的 worker 进程。**

验证：

```bash
curl http://localhost:3000/        # 返回 HTML（重定向到 /login）
psql $DATABASE_URL -c "\dt"        # 应看到 messages / users / kv_store 等表
```

---

## 五、生产环境

### 5.1 反向代理（Caddy 示例）

`yarn start` 只提供 HTTP，生产需前置反代做 TLS。

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 100MB          # 文件上传
    }
}
```

Nginx 要点：`client_max_body_size 100M`、`proxy_read_timeout 300s`（长 SSE
连接）、转发 `X-Forwarded-Proto`。

### 5.2 进程管理（systemd 示例）

自托管只需**一个** web 服务（无 worker）：

```ini
# /etc/systemd/system/agentboster-web.service
[Unit]
Description=AgentBoster Web
After=network.target postgresql.service redis.service
Requires=postgresql.service redis.service

[Service]
Type=simple
User=agentboster
WorkingDirectory=/home/agentboster/agentboster
EnvironmentFile=/home/agentboster/agentboster/.env.local
ExecStartPre=/usr/bin/yarn db:migrate
ExecStart=/usr/bin/yarn start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentboster-web
sudo journalctl -u agentboster-web -f
```

`WORKFLOW_LOCAL_DATA_DIR` 指向的目录要在 `WorkingDirectory` 下且对
`agentboster` 用户可写（重启保留在途 workflow）。

### 5.3 健康检查

```bash
curl http://localhost:3000/                              # 存活
curl -H "Authorization: Bearer $AGENTD_API_KEY" \
  http://localhost:3000/api/agentd/v1/health             # daemon 直连（如配了 agentd）
```

应用内还有运行时依赖自检（`lib/utils/runtime-health.ts`），会按部署模式检查
对应的环境变量（自托管查 DATABASE_URL / S3_* / PUBLIC_APP_URL，不查 Upstash）。

---

## 六、备份

```bash
# Postgres（含所有会话、KV、向量记忆）
pg_dump $DATABASE_URL > backup-$(date +%Y%m%d).sql

# MinIO / S3 桶：用 mc mirror 或对象存储自带的快照

# Workflow 落盘状态（可选，仅在途 run）
tar czf workflow-data.tgz .workflow-data/
```

Redis 无需备份——自托管下它只存 chat 适配器的临时会话状态，可重建。

---

## 七、常见问题

**登录后发消息无响应？**
查 `yarn start` 日志。自托管不需要 worker 进程，若卡住通常是模型 API key
未配或 DATABASE_URL 连不上。

**`KV_REST_API_URL ... required` 报错？**
说明 `isVercel` 被误判为 true（多半设了 `VERCEL=1`）。自托管移除这些变量，
KV 会自动走 Postgres。

**文件上传后 LLM 取不到 / 附件预览 403？**
检查 `PUBLIC_APP_URL` 是否为外部可达地址，以及 `AUTH_SECRET` 是否配置——blob
代理 URL 的 HMAC 签名用它派生。`/api/blob/*` 由 middleware 放行（靠签名而非
session 鉴权）。

**升级后 schema 报错？**
重跑 `yarn db:migrate`（幂等）。1.0 前 schema 可能有 breaking change，升级前
备份。

---

## 八、后续

- **agentd**（沙箱执行）：见 `subpackage/agentd/README.md`；部署/降权/runtime 目录运维见 [`agentd-deployment.md`](agentd-deployment.md)
- **CLI**：见 `subpackage/cli/README.md`
- **IM 机器人接入**：见主 README
