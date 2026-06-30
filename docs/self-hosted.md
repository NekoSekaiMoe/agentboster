# Self-Hosted 部署指南：脱离 Vercel 自托管 AgentBoster

> 本文档帮助你把 AgentBoster Web 层从 Vercel 部署迁移到自有服务器（自托管 Next.js + 自有 Postgres + 自有对象存储 + 自有 Redis）。文档基于对仓库源码的逐行核对，区分"已验证的硬耦合点"与"建议改造方向"，不提供未经测试的代码片段。
>
> 前置结论：**AgentBoster 在架构上是可自托管的**。所有"Vercel 依赖"都是软绑定或可选优化，没有一条是架构层面的硬锁。迁移的真实工程量约为 1–2 周，主要工作量集中在替换 3 处为 Vercel 函数模型写的 trick 与切换 Workflow World，而非重写业务代码。

---

## 一、为什么需要这份文档

AgentBoster 的前身 clawless 自我定位为"部署在 Vercel 的免费 AI agent"，README 与默认配置都按 Vercel 生态优化：Neon（Serverless HTTP Postgres）、Vercel Blob、Upstash Redis、@vercel/sandbox、Workflow DevKit 默认 Vercel World。这套组合让个人用户能零成本跑起来，但也带来三个常见痛点：

1. **免费额度上限**：Vercel Hobby/Pro、Neon 免费层、Vercel Blob 免费层都按个人用量设计，重度使用或多用户会触顶。
2. **数据主权**：企业或合规场景要求所有数据留在自有基础设施内。
3. **离线/内网**：某些场景不能有任何流量经过 Vercel。

这份文档为这三类需求提供改造路径。

---

## 二、改造全景：耦合点清单

下表是源码中所有与 Vercel 生态耦合的点，按"改造难度"排序。所有路径都已通过 grep 在源码中核对。

| 耦合点 | 文件 | 类型 | 改造难度 |
|---|---|---|---|
| Workflow World 默认 Vercel | `app/.well-known/workflow/v1/config.json` | 配置切换 | 极低（1 个 env） |
| `@neondatabase/serverless`（HTTP Postgres） | `lib/core/db/index.ts`、`lib/extra/db/postgres.ts` | SDK 替换 | 低（换 driver） |
| `@vercel/blob`（对象存储） | `lib/core/blob/index.ts`、`lib/core/blob/skills.ts` | SDK 替换 | 中（包 adapter） |
| `@upstash/redis`（IM 状态、KV） | 经 `@chat-adapter/state-redis` 与 `lib/core/kv/` | SDK 替换 | 中（换自托管 Redis） |
| `@vercel/analytics`、`@vercel/speed-insights` | `app/layout.tsx` | 可选移除 | 极低（删 import） |
| `@vercel/sandbox`（agentd 回退） | `lib/core/sandbox/{manager,runtime,actions}.ts` | 可选移除 | 极低（有 agentd 即不用） |
| `VERCEL_ENV` / `VERCEL_URL` 等 env（webhook URL） | `lib/bot/webhook.ts`、`scripts/vercel-postbuild.ts` | env 补全 | 低（加 APP_BASE_URL） |
| `next/server` 的 `after()`（异步后台） | `app/api/bot/.../callback/route.ts`、`app/(skill)/actions.ts` | 行为替换 | 中（需重构后台机制） |
| `im-stream` trick（streaming Response 吊命） | `app/api/internal/im-stream/route.ts` | 可选简化 | 低（自托管下多余） |
| `maxDuration = 300` | `app/api/bot/.../callback/route.ts` | dead config | 零（自托管忽略） |

注意：`maxDuration` 是 Vercel 函数概念，自托管 `next start` 下直接被忽略，**不是障碍**。`workflow/next`（withWorkflow 包裹）是构建期 Next.js 集成，不绑 Vercel 运行时。

---

## 三、改造步骤（建议顺序）

按"低风险、高收益优先"的顺序改造。每步可独立验证，不必一次性全改。

### 步骤 1：切换 Workflow World 到 Postgres World（最重要，最容易）

Workflow DevKit 的 World 抽象层把"workflow 跑在哪"完全外置。默认 Vercel World 用 Vercel Queues + Vercel 持久化做 step 调度与状态存储；切到 Postgres World 后，用 Postgres 表 + graphile-worker 接管，零代码改动。

**操作**：在自托管环境设置：

```
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
```

并按 Postgres World 文档配置（需要 `DATABASE_URL` 指向你的 Postgres，graphile-worker 需要 worker 进程）。参考 `node_modules/workflow/docs/deploying/index.mdx` 与 `building-a-world.mdx`。

**验证**：`npx workflow inspect runs --backend @workflow/world-postgres` 应能看到运行记录。

**注意**：Postgres World 是 Vercel 官方维护的生产级参考实现（见 `building-a-world.mdx` 的 Reference Implementation 提示），不是社区边角料。这一步是整个迁移中性价比最高的。

### 步骤 2：把 Postgres 从 Neon HTTP 驱动换成 pg 连接池

`lib/core/db/index.ts` 当前用 `neon`（HTTP 驱动，无连接池，适合 Vercel 函数短生命周期）+ `drizzle/neon-http`。自托管是常驻进程，应该用 `pg`（TCP 连接池，更适合长跑）。

**改造方向**：

- 把 `import { neon } from '@neondatabase/serverless'` 换成 `pg` 的 `Pool`。
- 把 `drizzle-orm/neon-http` 换成 `drizzle-orm/node-postgres`。
- `DATABASE_URL` 仍指向同一个 Postgres（schema 完全不动，drizzle schema 定义与 driver 无关）。

`lib/extra/db/postgres.ts`（用 `NeonQueryFunction`）也要同步改造。

**验证**：跑一次聊天，确认 messages 表正常写入。

**注意**：如果你的自托管 Postgres 同时是 Neon（远程），HTTP 驱动也能用，但延迟比 TCP 连接池高。最佳实践是 Postgres 与 Web 同主机或同 VPC。

### 步骤 3：替换 Vercel Blob 为 S3/R2

`lib/core/blob/index.ts` 与 `lib/core/blob/skills.ts` 用 `@vercel/blob` 存附件与技能仓库同步产物。

**改造方向**：在这两个文件内包一层存储 adapter，按 `STORAGE_DRIVER` env 选择后端：

- 默认 `vercel`：保留现有 `@vercel/blob` 调用。
- `s3`：用 `@aws-sdk/client-s3` 实现 `putBlob`、`getBlob`、`deleteBlob`、`listBlobs` 等接口（签名要与 `@vercel/blob` 的 PutBlobResult 等返回类型兼容）。
- `r2`：Cloudflare R2 用 S3 兼容 API，复用 s3 driver 改 endpoint。

调用方（业务代码）不动，只改 adapter 内部。

**验证**：上传一个附件，确认能在 S3/R2 里看到对象。

### 步骤 4：替换 Upstash Redis 为自托管 Redis

Upstash Redis 在两个地方用：

- `@chat-adapter/state-redis`（IM 适配器状态）：见 `lib/bot/adaptor.ts` 的 `createBotAdapters`。
- `lib/core/kv/`（全局配置 AppConfig、配对标记、分布式锁）。

**改造方向**：

- Upstash 提供两种 SDK：REST（HTTP）与 `@upstash/redis/cluster`。自托管 Redis 用 `ioredis` 或 `node-redis`（TCP）。
- 包一层 KV adapter，按 `KV_DRIVER` env 选择。`lib/core/kv/config.ts` 等文件内的 `Redis` 调用替换为 adapter 接口。
- `@chat-adapter/state-redis` 是 Chat SDK 的官方适配器，签名接受 Upstash 客户端。要么提供一个"伪 Upstash 客户端"（实现相同接口，内部用 ioredis），要么 fork 这个 adapter。

**验证**：触发一次 IM 配对，确认 `pair:bound:<adapter>:<imUserId>` 写入 Redis。

### 步骤 5：补全 webhook 的 APP_BASE_URL（替代 Vercel env）

`lib/bot/webhook.ts` 的 `getAppBaseUrl` 优先读 `VERCEL_PROJECT_PRODUCTION_URL` 等 Vercel env，fallback 到 `http://127.0.0.1:3000`。自托管下这些 Vercel env 都是 undefined，会 fallback 到 localhost——这显然不对（外部 IM 平台回调不到 localhost）。

**改造方向**：在 `getAppBaseUrl` 顶部加一个显式 env 优先级：

```
优先级：APP_BASE_URL > VERCEL_PROJECT_PRODUCTION_URL > VERCEL_BRANCH_URL > VERCEL_URL > NODE_ENV=production ? 报错 : LOCAL_BASE_URL
```

即在自托管生产环境，强制要求 `APP_BASE_URL=https://your-domain.com`，没设就报错（避免静默用 localhost）。

`isProductionDeployment` 同理：去掉对 `NEXT_PUBLIC_VERCEL_ENV` 的依赖，只用 `NODE_ENV`。

### 步骤 6：替换 next/server 的 after()

这是**改造中唯一需要重构行为的点**，因为 `after()` 在自托管 `next start` 下行为不同（不再延迟到响应后执行，而是降级为响应前等待）。

**两处调用**：

1. `app/api/bot/[authSecret]/[adapter]/callback/route.ts:37`：`waitUntil: (p) => after(() => p)` —— Chat SDK webhook 用它把 IM 流消费放到响应后。
2. `app/api/bot/[authSecret]/[adapter]/callback/route.ts:84, 130`：`after(() => fetch('/api/internal/im-stream...'))` —— webhook ACK 后 fire-and-forget 触发 IM 流消费端点。
3. `app/(skill)/actions.ts:269`：`after(async () => { ... })` —— 技能相关后台清理。

**问题**：自托管下 `after(p)` 会让响应等 p 完成。第 1、2 处会让 IM webhook 阻塞到整个 workflow run 完成（几十秒到几分钟），触发 IM 平台的 webhook 超时重试，造成重复触发。

**改造方向**（任选其一）：

- **方案 A：显式后台任务队列**。用 BullMQ 或类似机制，把 `after` 内容改成 enqueue 一个 job，由独立 worker 进程消费。最干净，但要引入队列基础设施。
- **方案 B：detached fire-and-forget**。用 `void fetch(...)` 不 await，立即返回 ACK。Node 事件循环会保留 promise 到完成，但响应不等。注意：Next.js 自托管下未 await 的 fetch 在响应后是否被中断，需要测试（可能需要显式 `keepAlive`）。
- **方案 C：保留 after()，接受降级行为**。如果 IM 平台 webhook 超时容忍度高（如 Telegram 是 60 秒），且 workflow run 通常更短，可以先不改，观察是否真的触发重试。

**验证**：触发一次 IM 消息，确认 webhook 立即返回 200 ACK，且消息最终被处理（不重复、不丢失）。

### 步骤 7：（可选）简化 im-stream trick

`app/api/internal/im-stream/route.ts` 的注释明确说明：这个端点是用一个永远不结束的 ReadableStream 把 Vercel 函数吊着不退出，绕过 maxDuration。自托管下 Node 进程没有 maxDuration 概念，**这个 trick 多余但不有害**。

**改造方向**（可选）：

- 直接同步消费 workflow readable，不绕弯。
- 或者保留现状（不影响功能，只是有一段 dead 逻辑）。

### 步骤 8：移除可选的 Vercel 工具

- `app/layout.tsx` 的 `@vercel/analytics` 与 `@vercel/speed-insights`：删除 import 与组件即可，换成本地分析或留空。
- `@vercel/sandbox`（`lib/core/sandbox/`）：自托管且有 agentd 节点的情况下，sandbox 回退永远不会触发。可以保留代码（不发包不占资源），也可以删除。
- `scripts/vercel-postbuild.ts` 的 `VERCEL=1 && VERCEL_ENV=production` 门控：自托管下手动跑 `db:push` 与 `migrate-message-versions`，不依赖 postbuild。

---

## 四、启动 Web 服务：从开发到生产

这一步回答最基础的问题：自托管下到底用什么命令把 Web 跑起来。答案跟 Vercel 部署不一样，必须分清"开发"、"构建"、"运行"三个阶段。

### 4.1 三条核心命令及其用途

仓库 `package.json` 的 scripts 暴露了三条标准 Next.js 命令，自托管下都要用：

| 命令 | 作用 | 自托管下用在 |
|---|---|---|
| `yarn dev`（`next dev`） | 开发模式：热重载、source map、详细错误、**单进程**、不压缩、不做 production 优化 | 仅本地调试 |
| `yarn build`（`next build`） | 构建：编译 RSC、生成 `.next/` 产物、跑 Workflow DevKit 的 step 编译（withWorkflow 注入） | 部署前一次 |
| `yarn start`（`next start`） | 生产运行：跑构建产物 `.next/`，常驻 Node HTTP 服务，**这才是自托管的运行命令** | 生产部署 |

**关键区别**：Vercel 部署时你只跑 `yarn build`（或 `yarn deploy` = `vercel --prod`），运行交给 Vercel 平台拉起函数；自托管时你必须**自己跑 `yarn start`**，它在你机器上起一个常驻 Node 进程监听端口。这是两种部署形态最根本的差异。

### 4.2 自托管的正确启动流程（生产部署）

按以下顺序操作，假设你已经完成 §三的改造步骤：

**第一步：准备环境变量**

在启动前加载所有必要 env（具体清单见 §五的拓扑章节与 §十一的对照表）。最简的方式是写一个 `.env.local`（Next.js 自动加载）或用 systemd 的 `EnvironmentFile=`。

注意：`NODE_ENV=production` 是**必须**的。如果不设，Next.js 会按开发模式跑，性能差且行为不一致。但 `VERCEL=1` / `VERCEL_ENV` **不要设**（自托管下应该让代码走非 Vercel 分支）。

**第二步：装依赖**

```
yarn install --frozen-lockfile
```

注意 agentboster 仓库根用 Yarn Classic（无 engines 字段，跟随主线）。CLI 子仓是独立的 Yarn monorepo，agentd 是独立 Go module——这两个不需要在启动 Web 时安装，它们各自独立部署。

**第三步：确保数据库就绪**

```
yarn db:ensure-vector    # 确保 pgvector 扩展存在
yarn db:push             # 推送 schema 到你的 Postgres
```

这两步是**自托管下替代 postbuild 门控**的等价操作。在 Vercel 上这两步由 `scripts/vercel-postbuild.ts` 在 `VERCEL_ENV=production` 时自动执行；自托管下要手动跑（或者写进部署脚本）。

`db:push` 是幂等的，重复执行不会破坏数据。但 schema 变更要小心（项目处于 WIP，1.0 前 schema 可能 breaking change，升级前要看 changelog）。

**第四步：构建**

```
yarn build
```

这一步会：

- 编译所有 RSC 与 Client Component
- 跑 `withWorkflow` 注入，把 `app/.well-known/workflow/v1/{flow,step,config}.js` 等 Workflow DevKit 端点编译生成
- 输出到 `.next/` 目录

注意：`yarn build` 不会执行 `postbuild`（因为它门控在 `VERCEL=1 && VERCEL_ENV=production`）。自托管下你不希望它执行（你已经手动跑了 `db:push`），所以保持门控即可，不要设那两个 env。

如果你想强制 postbuild 跑（比如想让 `migrate-message-versions` 自动执行），可以临时 `VERCEL=1 VERCEL_ENV=production yarn build`，但通常没必要。

**第五步：启动生产服务**

```
yarn start
```

默认监听 `0.0.0.0:3000`。可以用 `PORT=xxx yarn start` 或 `next start -p xxx` 改端口。

**这就是自托管的 Web 服务**。它是一个常驻 Node 进程，没有 Vercel 函数的超时、扩缩、Edge 网络——所有请求都进这一个进程处理。

### 4.3 三个常见错误

**错误一：用 `yarn dev` 跑生产**

`yarn dev` 是 `next dev`，开发模式：不压缩、不做 tree-shaking、保留详细错误页、Recompile on file change、性能远低于 production build。**绝对不能用来对外服务**。Vercel 部署时 Vercel 自动跑 build 然后用 production runtime，自托管时同理——必须 `yarn build && yarn start`。

判断方法：进程列表里如果是 `next dev` 就是开发模式，`next start`（或 `next-server`）才是生产。

**错误二：不跑 `yarn build` 直接 `yarn start`**

`yarn start` 跑的是 `.next/` 目录的构建产物。如果没跑过 build，`.next/` 不存在或过期，`yarn start` 会报错或跑老版本。每次代码变更后必须重新 `yarn build` 再 `yarn start`（或重启）。

**错误三：让 `next start` 直接暴露公网**

`next start` 监听 HTTP（无 TLS）。生产部署**必须在前面加反向代理**（Nginx、Caddy、Traefik），由反代处理 TLS、域名、限流、静态资源缓存。直接把 `next start` 暴露公网会有证书问题与安全问题。

### 4.4 推荐的进程管理方式

`yarn start` 跑的是前台进程，SSH 断开就退出。生产部署要用进程管理器：

**systemd 方案**（Linux 原生，最推荐）：

写一个 `agentboster-web.service`，`ExecStart=/path/to/yarn start`，`WorkingDirectory=/path/to/repo`，`EnvironmentFile=/path/to/env`，`User=non-root`，`Restart=always`。然后用 `systemctl enable --now agentboster-web`。这样开机自启、崩溃自动重启、日志进 journalctl。

**Docker 方案**（推荐用于拓扑 A 单机全栈）：

写 Dockerfile（基础镜像 `node:22-alpine`，`COPY` 源码，`yarn install --frozen-lockfile --production=false`、`yarn build`、`EXPOSE 3000`、`CMD ["yarn", "start"]`），用 docker-compose 跟 Postgres、Redis、agentd 一起编排。注意 Next.js 的 standalone 输出（`output: 'standalone'` in next.config）可以大幅减小镜像体积，但 agentboster 当前没启用，按需开启。

**PM2 / forever 方案**（Node 生态传统选择）：

`pm2 start "yarn start" --name agentboster-web`。比 systemd 简单，但功能重叠 systemd，Linux 上推荐 systemd 而非 PM2。

### 4.5 graphile-worker 的独立进程（关键且容易遗漏）

切换 Workflow World 到 Postgres World 后（§三步骤 1），workflow step 的执行依赖 graphile-worker。**graphile-worker 是独立进程**，不在 `yarn start` 里。

如果忘了起 worker，workflow run 会被 enqueue 但永不消费——表现是用户发消息后一直转圈，没有任何响应。

启动方式（按 graphile-worker 文档）：

```
npx graphile-worker --connection-string $DATABASE_URL
```

或者写成代码脚本（`scripts/worker.ts`），用 `tsx` 跑：

```
tsx scripts/worker.ts
```

具体取决于 `@workflow/world-postgres` 的版本要求（看 node_modules/@workflow/world-postgres 的 README）。这个 worker 进程也要用 systemd 或 Docker 编排常驻。

### 4.6 端口、反代、健康检查的完整组合

典型生产部署：

- `yarn start` 监听 `127.0.0.1:3000`（建议绑 localhost，不直接暴露）
- Caddy / Nginx 反代 `https://your-domain.com` → `http://127.0.0.1:3000`
  - Caddy 优势：自动 TLS（Let's Encrypt）
  - Nginx 优势：生态熟、配置资料多
- 健康检查：定期 curl `https://your-domain.com/api/agentd/v1/health`（注意这个端点要 `AGENTD_API_KEY` 鉴权）或更简单的 `/`（重定向到登录页）

### 4.7 启动后验证

按这个顺序验证 Web 起来了：

1. `curl http://127.0.0.1:3000/` 应返回 HTML（重定向到登录页或聊天页）
2. 浏览器访问域名，能看到登录页
3. 用初始 `USERNAME` / `PASSWORD` 登录（首次启动 seedInitialUser 会建初始用户）
4. 浏览器发一条消息，看 `messages` 表是否写入
5. 看 `yarn start` 的 stdout / journalctl 是否有 workflow run 启动日志
6. 如果一直转圈，检查 graphile-worker 进程是否在跑（§4.5）

---

## 五、推荐的部署拓扑

### 拓扑 A：单机全栈（最简）

适合个人/小团队自托管。

- 一台 Linux 服务器（2C4G 起）
- Docker Compose 跑：Next.js（`next start`）+ Postgres（带 pgvector）+ Redis + agentd
- S3/R2 用云服务（避免本地 minio 运维负担）
- 反向代理：Caddy 或 Nginx 做 TLS + 域名

环境变量清单：

```
NODE_ENV=production
APP_BASE_URL=https://your-domain.com
DATABASE_URL=postgres://...（本地 Postgres）
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
STORAGE_DRIVER=s3
S3_ENDPOINT=...
S3_BUCKET=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
KV_DRIVER=redis
REDIS_URL=redis://...
AUTH_SECRET=...
AGENTD_API_KEY=...
USERNAME=...
PASSWORD=...
```

注意：graphile-worker 需要独立进程（在同一个 Docker Compose 里起一个 worker 服务容器）。

### 拓扑 B：控制面/执行面分离

适合团队/企业。

- Web 控制面：跑在一台服务器或私有云
- agentd 执行面：跑在用户 VPC 内（数据主权所在）
- Postgres：独立机器或托管服务（Crunchy Bridge、Aurora、Supabase Pro）
- Redis：独立或托管
- 对象存储：S3/R2

Web 与 agentd 之间走 Pattern B（mTLS），见 architecture.md §六。

### 拓扑 C：完全离线/内网

适合政企、特殊合规。

- 所有组件在内网（Postgres、Redis、MinIO、agentd、Web）
- 不依赖任何外部 SaaS（Blob 换 MinIO、Redis 自建、LLM 用 Ollama 或本地模型）
- IM 通道可选：内部 IM（Mattermost/Rocket.Chat 通过社区 adapter）或不启用 IM

**注意**：LLM 本地化（Ollama）需要额外改造，因为 `lib/ai/providers.ts` 的 provider 抽象支持 Ollama，但 L1 打分用的 scorer 模型、记忆抽取用的 LLM 都需要单独配。

---

## 六、迁移后保留与失去的

### 保留的能力

- 完整三层架构（Web + agentd + CLI）
- Workflow 持久化与可恢复（Postgres World 提供等价能力）
- L0/L1/L2 三层安全
- 多节点调度
- IM 多渠道接入（只要 Redis 与公网 webhook 可达）
- 长期记忆与 RAG（pgvector 不动）
- 审计日志、监控

### 失去的优化

- **Vercel 函数自动扩缩**：自托管需自己处理流量突发（固定容量或 k8s）。
- **Vercel Edge 网络**：自托管需自己配 CDN（Cloudflare 或前端）。
- **Vercel Queues 触发器**：切到 Postgres World 后用 graphile-worker，需要运维 worker 进程。
- **`after()` 异步模型**：失去"webhook 立即 ACK + 后台处理"的开箱体验，需要自建后台机制。
- **Vercel dashboard 集成**：observability 换成本地 `workflow inspect` 或自建监控。

### 不变的核心

业务代码（chatMain、workflow agent、安全流、调度逻辑、IM 接入）完全不动。schema 不动。所有改造集中在 SDK 层、env 层、World 配置层。

---

## 七、验证清单

改造完成后，按以下清单逐项验证：

- [ ] `next build && next start` 能正常启动
- [ ] 浏览器登录正常（cookie clawless-auth 颁发与校验）
- [ ] 浏览器聊天能完整跑一轮（消息写入 messages 表）
- [ ] Workflow run 能持久化（重启 Web 进程后，session 能 resume）
- [ ] IM webhook 立即返回 200 ACK（不阻塞）
- [ ] IM 消息最终被处理（不重复、不丢失）
- [ ] agentd 节点能注册与心跳（查 agentd_nodes 表）
- [ ] 工具调用能在 agentd 沙箱执行（查 agent_tool_activity_logs）
- [ ] L2 决策能触发 IM 卡片与用户响应（查 l2_decisions 表）
- [ ] 附件上传到自托管存储（查 S3/MinIO）
- [ ] 长期记忆抽取与召回（查 long_term_memories 与 chunks）
- [ ] 定时任务能触发（查 scheduled_tasks 的 lastFiredFor）
- [ ] CLI 能 login 配对与聊天

---

## 八、长期维护与上游同步

### 风险：与主仓 rebase 的冲突

自托管意味着你 fork 了一份代码。每次 agentboster 主仓更新，rebase 时最容易冲突的是：

- `lib/core/blob/`（你改了 adapter）
- `lib/core/db/index.ts`（你换了 driver）
- `lib/core/kv/`（你换了 Redis 客户端）
- `lib/bot/webhook.ts`（你改了 getAppBaseUrl）
- `app/api/bot/.../callback/route.ts`（你改了 after）

### 缓解策略

1. **把改造收拢到 adapter 文件**。所有 Vercel 替换都集中到 `lib/core/storage/`、`lib/core/db/drivers/`、`lib/core/kv/drivers/` 这类新目录，业务代码 import 抽象接口。rebase 时只冲突 adapter 文件。
2. **保留 Vercel 默认，通过 env 切换**。不要删除 Vercel 路径，而是用 `STORAGE_DRIVER` 等 env 选择后端。这样你的 fork 与主仓始终兼容，只是多了几条 if 分支。
3. **把 Workflow World 切换做成纯 env**（已经是了，`WORKFLOW_TARGET_WORLD`）。零冲突。
4. **把 after() 替换做成 Next.js runtime 检测**：检测 `process.env.VERCEL`，是 Vercel 就用 after，否则用 fallback。这样代码同时支持两种部署。

策略 2 + 4 的好处是：你的 fork 可以**理论上提交回主仓作为"自托管支持"**，而不是永远 fork。如果作者接受，自托管变成主仓一等公民，你不再背 fork 债。

### 推动上游

最健康的长期方案是推动 agentboster 主仓官方支持自托管。具体提议：

- 加 `STORAGE_DRIVER`、`KV_DRIVER`、`DATABASE_DRIVER` 等 env 开关。
- 加 `APP_BASE_URL` env。
- 加 `WORKFLOW_TARGET_WORLD` 文档说明（README 目前完全没提 World 抽象，这其实是个宣传遗漏）。
- 在 README 加 "Self-Hosted" 章节链到本指南（或主仓版本）。

如果作者接受，自托管从"fork 改造"变成"配置项"，整个社区受益。

---

## 九、常见问题

### Q1：能不能部分迁移？比如 Web 留 Vercel、数据出 Vercel？

能，而且这是**推荐做法**。Web 控制面留 Vercel（享受自动扩缩、Edge、零运维），DATABASE_URL 指自有 Postgres，Blob 换 S3，agentd 在自己 VPC——这是数据主权 + 云便利的折中。本指南的步骤 2、3、4、5 都适用这种部分迁移，不需要做步骤 6（after）。

### Q2：自托管后还有 Vercel 函数 10 秒超时吗？

没有。`next start` 是常驻 Node 进程，没有函数超时概念。`maxDuration = 300` 是 dead config，被忽略。但要注意 Next.js 默认的 response timeout（有些反代如 Nginx 默认 60 秒），长 IM 流可能需要调高超时。

### Q3：Workflow 切 Postgres World 后，Vercel World 的代码会不会冲突？

不会。Workflow DevKit 的 World 是运行时按 env 选择的，Vercel World 代码在 Postgres World 下不被加载。`app/.well-known/workflow/v1/config.json` 里的 `queue/v2beta` 触发器是 Vercel World 用的，切 Postgres World 后由 graphile-worker 接管，不冲突。

### Q4：不换 neon，直接用本地 Postgres 配 neon HTTP 驱动行不行？

行，但不是最优。neon HTTP 驱动假设无状态短查询，本地 Postgres 用 HTTP 模拟 TCP 有性能开销。最佳是步骤 2 描述的换 `pg`。

### Q5：agentd 的 Linux-only 限制在自托管下是不是问题？

不是。自托管本来就是 Linux 服务器（agentd 部署在那）。Windows/macOS 自托管 Web 可以，但 agentd 必须有 Linux 机器——这是 agentd 的硬约束，与 Web 自托管无关。

### Q6：CLI 在自托管下需要改吗？

不需要。CLI 是瘦客户端，只跟 Web 的 HTTPS API 通信。Web 自托管在哪，CLI 配对时填对应 URL 即可。`agentboster login --url https://your-domain.com` 即可（具体 flag 见 cli/README.md）。

### Q7：迁移后还能用 Vercel 的 observability 吗？

Vercel Analytics 与 Speed Insights 失去（步骤 8 移除）。但 Workflow DevKit 的 observability（`workflow inspect`）通过 `--backend @workflow/world-postgres` 仍可用。其他监控换成本地方案（Prometheus + Grafana、或 OpenTelemetry）。

---

## 十、快速决策：你应该自托管吗？

| 你的情况 | 建议 |
|---|---|
| 个人用、流量小、不介意数据在 Vercel | 留 Vercel 默认，零成本，享受自动扩缩 |
| 个人用、想要数据/技能在自己手里 | 部分迁移：Web 留 Vercel，Postgres/Blob 出 Vercel（步骤 2、3） |
| 小团队、需要 IM 接入与多端协作 | 单机全栈（拓扑 A），1-2 周改造 |
| 企业、需要合规与数据主权 | 控制面/执行面分离（拓扑 B） |
| 政企、完全内网、不能有任何外部依赖 | 完全离线（拓扑 C），额外需要 LLM 本地化改造 |
| 边缘设备、单板机 | 不要选 AgentBoster，选 picoclaw（架构不匹配） |
| 个人单机、不要 Web | 不要选 AgentBoster，选 manboster（单二进制） |

---

## 十一、附录：环境变量对照表（Vercel vs 自托管）

| 用途 | Vercel 部署 | 自托管部署 |
|---|---|---|
| 鉴权密钥 | `AUTH_SECRET` | `AUTH_SECRET`（不变） |
| Postgres | `DATABASE_URL`（指 Neon） | `DATABASE_URL`（指自有 Postgres） |
| Workflow World | 默认 Vercel World | `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` |
| 对象存储 | `BLOB_READ_WRITE_TOKEN`（Vercel Blob） | `STORAGE_DRIVER=s3` + S3 凭证 |
| Redis | `KV_REST_API_URL` + `KV_REST_API_TOKEN`（Upstash） | `REDIS_URL`（自托管 Redis） |
| Webhook 基址 | 自动从 `VERCEL_URL` 推断 | `APP_BASE_URL=https://your-domain.com` |
| 部署检测 | `VERCEL=1`、`VERCEL_ENV=production` | `NODE_ENV=production` |
| daemon 鉴权 | `AGENTD_API_KEY` | `AGENTD_API_KEY`（不变） |
| mTLS（Web→agentd） | `AGENTD_CLIENT_CERT_PATH` 等 | 不变（或留空） |

---

*本文档基于 AgentBoster 仓库源码（Web 层）逐行核对撰写。所有耦合点文件路径与改造方向均可在源码中复核。改造代码需自行实现与测试；本指南提供路径与方向，不提供未经测试的代码片段。文档生成时项目处于 WIP 状态，1.0 前接口与 schema 可能变化，改造前请以最新源码为准。*
