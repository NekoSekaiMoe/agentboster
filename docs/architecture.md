# AgentBoster 架构白皮书

> 本文档基于对 AgentBoster 仓库（Web / agentd / CLI 三部分）实际源码的逐行阅读撰写，所有结论可在引用的源码文件中复核。文档不包含代码片段，仅以文字描述结构、职责、数据流与设计取舍。文档生成时项目处于 WIP 状态（1.0 前接口可能变化）。

## 导读

本文档面向希望深入理解 AgentBoster 内部实现的工程师、贡献者与评估者。文档不替代 README（高层地图）与 AGENTS.md（贡献者速查），而是补充它们的空白，提供三层架构的端到端深度剖析。所有结论基于实际源码而非描述性段落，关键处在引用的源码文件中可复核。

阅读路径建议。若你是初次了解平台，建议从 §一平台总览与 §二Web 层架构读起，建立对权威中心与编排核心的认识；再读 §三agentd 架构理解执行面的沙箱与安全；最后读 §四CLI 架构理解瘦客户端边界。若你关注特定主题，可直接跳转：安全相关看 §2.6、§3.6、§十五；部署相关看 §六、§十六、附录 B；二次开发看 §九、附录 A；实战行为看 §七关键数据流、§十八端到端场景；避坑看 §十九反模式与陷阱。

术语约定。本文用 L0/L1/L2 指代三层安全（规则黑名单、LLM 风险评分、用户授权），用 chatMain 指代消息派发总闸，用 'use step'/'use workflow' 指 Workflow DevKit 的指令标注，用 local_* 指代 CLI 本机工具家族，用 Pattern A/Pattern B 指代 agentd 的两种部署拓扑。完整术语索引见 §十七。

文档边界。本文不涉及与同类项目（memoh、manboster、picoclaw、astrbot）的对比（那在 results.md）；不涉及具体业务用法（那在 README）；不涉及贡献流程（那在 AGENTS.md）。本文专注架构本身：各层职责、协作机制、数据流、设计取舍、边界情形。WIP 状态意味着部分细节可能在 1.0 前变化，引用源码时请以当前 commit 为准。

---

## 零、阅读准备

### 0.1 前置概念

阅读本文前，建议熟悉以下概念：Next.js App Router（React Server Component 与 Client Component 边界、route handler、middleware）；Vercel Workflow DevKit（durable step、可恢复 workflow、step 沙箱）；Drizzle ORM 与 Postgres（含 pgvector 向量扩展）；Go 的 gin HTTP 框架与 cgroup v2；Linux 容器（docker、LXC）与隔离原语（capabilities、seccomp、namespace）；AI SDK 的 stream 与 tool calling；Chat SDK 的 webhook 模型。

不熟悉上述概念不影响理解本文的主线（硬分层、强异步、低耦合、强安全），但会影响对部分实现细节的理解。本文会在首次提及每个概念时简要说明其作用。

### 0.2 源码阅读方法

本文引用源码用 path:line 格式（如 lib/chat/index.ts:1428 指该文件第 1428 行）。复核方法：用 ripgrep 或直接读对应文件。注意本文生成时的 commit 状态与文件时间，后续 commit 可能改变行号或重构结构；若引用失效，按模块名与函数名搜索即可定位。

### 0.3 文档结构

本文分二十二章正文加三个附录。正文按"总览到分层到横切到应用"组织：§一是平台总览；§二到§四是三层架构详述；§五是横切关注点；§六是部署拓扑；§七是关键数据流；§八是设计取舍；§九到§十六是深层细节、性能、安全、运维；§十七是术语索引；§十八到§二十是场景、反模式、生态；§二十一与§二十二是版本策略与文档导航。附录 A 是目录速查，附录 B 是配置速查，附录 C 是命令速查。

---

## 一、平台总览

### 1.1 一句话定位

AgentBoster 是一个多端协作的 AI 平台，由三个可独立部署、独立安装、独立升级的部分组成：一个运行在云端的 Web 应用（Next.js 15），一个运行在 Linux 主机上的守护进程 agentd（Go），以及一个运行在开发者本机的终端 CLI（基于 pi 框架的瘦客户端）。三者通过窄 HTTP 契约协作，没有共享代码路径、没有共享数据库 schema、没有共享进程状态。Web 是唯一的权威中心，agentd 与 CLI 都是可丢弃、可水平扩缩的执行端。

### 1.2 三个组成部分

Web（Next.js 15.5 + React 19 + TypeScript）承担全部"体验与编排"职责：浏览器 UI、会话与配置管理、即时通讯（IM）机器人接入、Workflow 持久化编排、三层安全审批（L2 交互）、节点注册表、审计与监控。它使用 Postgres（建议带 pgvector 扩展）作为权威存储，用 Upstash Redis 存 IM 适配器状态与分布式锁，用 Vercel Blob 存附件与技能仓库产物。Web 既是面向最终用户的 SaaS 前端，也是面向 agentd 与 CLI 的 API 后端。

agentd（Go 1.26.2，仅支持 Linux amd64）是一个 root 守护进程，承担"执行隔离与安全边界"职责：在 docker / docker-strict / lxc 三档沙箱内执行工具（exec、文件、浏览器、git 等），落地三层安全的前两层（L0 规则黑名单、L1 LLM 风险评分），上报节点心跳与资源指标，接收 Web 下发的 L2 决策结果。它本身无状态——所有注册、心跳、工具结果、审查日志都 POST 给 Web；自身只保留沙箱、本地缓存与会话运行时镜像。重启后从 Web 重新拉取节点身份与 L0 规则。

CLI（基于 pi 框架的 Yarn Classic monorepo，Node 不低于 22.19）是终端编码 Agent，承担"开发者本机终端场景"：交互式 TUI、非交互 `--print` 模式、`agentboster login` 设备配对、本机 `local_*` 工具执行（shell、读写文件、问答）。它是一个瘦客户端——不做模型推理、不持久化会话；本地 session 文件仅是 Web 数据的临时镜像（写在 OS 临时目录，退出即清），`--resume` 直接从 Web 远程拉取消息重建上下文。

### 1.3 四个设计主轴

整个平台的工程取舍围绕四个主轴展开，贯穿三层。

第一是硬分层：Web 是唯一权威，会话状态、模型编排、工具路由、Workflow 运行时、凭证与审计日志全部归 Web。agentd 与 CLI 都不带本地权威状态。agentd 注册、心跳、工具结果都 POST 给 Web；自身只保留沙箱与本地缓存指标，重启后从 Web 重新拉取节点身份。CLI 不做模型推理、不持久化会话；本地 session 文件仅是 Web 数据的临时镜像，退出即清。这种"执行端可丢弃"的约束，使 agentd 节点和 CLI 进程都能水平扩缩、随时重启，而不影响会话连续性。

第二是强异步：所有 LLM 调用、工具循环、子代理编排都不直接跑在请求线程上，而是落地为 Workflow DevKit 的可恢复步骤。用户提交一条消息后，Web 启动或恢复一个 workflow run，把每一步的增量（assistant 文本、工具调用、工具结果）持久化到 messages 表。工具调用经 L0/L1/L2 安全流处理后，通过事件总线派发——要么由 agentd 节点经 `/api/agentd/v1/*` 回调，要么由 CLI 经 `local-tool-request` SSE 流。任一执行端宕机，workflow 暂停，等待下一次消息或 agentd 回调；恢复后从中断点续跑，而非重头开始。

第三是低耦合：三层之间只通过窄 HTTP 契约通信，没有共享代码路径、共享 DB schema 或共享进程内状态。CLI 到 Web 走 `POST /api/cli/chat` 加一组会话/消息 CRUD，鉴权用 Bearer `clawless-auth` 加设备吊销检查。agentd 到 Web 走 `POST /api/agentd/v1/nodes/{register,heartbeat}` 加一组工具与决策回调，鉴权用 `AGENTD_API_KEY`（HTTPS），Web 主动访问 agentd 时另叠 mTLS 双向证书。Web 不需要知道 agentd 与 CLI 的内部实现，只认 HTTP body 与事件 schema。agentd 是独立 Go 模块，CLI 是独立 Yarn monorepo，两者各有自己的 AGENTS.md、工具链与发版周期。

第四是强安全：工具执行永远穿过三层独立的安全评估，任一层可独立否决。L0 是规则黑名单（在执行端静态拦截 rm -rf /、fork bomb、提权等已知危险模式）；L1 是 LLM 风险评分（对命令风险评分，超阈值上报或转 L2）；L2 是用户授权（在 Web UI 或 CLI TUI 人工 approve/deny）。CLI 的 `--yolo` 跳过三层，但仅对 CLI 本机的 `local_*` 工具生效；经 Web 派发到 agentd 的工具仍走完整流程。Web 与 agentd 之间默认 HTTPS 加 API Key，当 agentd 节点具备公网 URL 或 frp 通道时，额外启用 mTLS 双向证书。

---

## 二、Web 层架构

Web 层是整个平台的中枢，本节详述其入口、配置、路由、核心业务模块、数据库 schema 与 IM 接入。

### 2.1 入口与构建配置

仓库根的 package.json 声明项目名为 agentboster、私有、MIT 许可。脚本方面，`yarn dev` 启动 Next 开发服务器；`yarn build` 运行 next build（注意，构建本身不强制类型或 ESLint 正确性）；`yarn lint:check` 是真正的发版前质量门，等价于 `tsc --noEmit && biome check .`；`yarn test` 跑 Vitest。数据库相关脚本包括 `db:generate`（drizzle-kit 生成迁移）、`db:push`（推送 schema）、`db:studio`（可视化）、`db:ensure-vector`（运行脚本确保 pgvector 扩展存在）。`postbuild` 脚本只在 Vercel 生产环境（`VERCEL=1` 且 `VERCEL_ENV=production`）执行向量扩展检查、schema 推送与消息版本迁移；本地 build 不动数据库。

依赖方面，框架层是 next 15.5、react 19.2；AI 层是 ai SDK 主包加 `@ai-sdk/{anthropic,google,openai,openai-compatible,mcp,react}`；工作流编排是 Vercel 的 Workflow DevKit（workflow 包配合 `@workflow/ai`、`workflow/next`、`workflow/api`）；数据库层是 drizzle-orm 加 `@neondatabase/serverless`（Serverless HTTP 驱动，无连接池开销，适配 Vercel 函数）加 `@upstash/redis` 加 `@vercel/{blob,queue,sandbox,analytics}`；IM 适配器是 chat 主包加 `@chat-adapter/{telegram,discord,slack,teams,gchat,state-redis}`，飞书用 `@larksuiteoapi/node-sdk`，QQ 用 `qq-official-bot`；UI 与状态层是 `@tanstack/react-query`、Radix UI 全家桶、framer-motion、tailwindcss、shadcn、sonner、CodeMirror 6。工具层用 zod 同时做运行时校验与类型推导。

next.config.ts 用 `withWorkflow` 包裹基础配置，把 Workflow DevKit 的 `.well-known/workflow/*` 路由与构建期 step 编译注入 Next。它显式忽略构建期的 ESLint 与 TypeScript 错误（所以质量全靠 lint:check），生产环境移除 console（仅保留 error/warn），并对 Radix、lucide、react-markdown、framer-motion 等做按需加载优化。关键的 `serverExternalPackages` 把 `@chat-adapter/discord`、`@discordjs/ws`、`@vercel/queue`、`discord-interactions`、`discord.js`、`zlib-sync` 强制外部化——这些是原生或 WebSocket 依赖，webpack 打包会破坏。全局响应头加 `X-Robots-Tag: noindex,nofollow`，私有部署不被搜索引擎收录。

tsconfig.json 把 `@/*` 映射到仓库根，AGENTS.md 推荐优先用 `@/` 别名而非长相对路径。它排除了 node_modules、ref（vendored 参考资料）、memoh、cli——这意味着根的 `tsc --noEmit` 不会类型检查 CLI 子仓。drizzle.config.ts 指向 `lib/core/db/schema/index.ts` 作为 schema 源，迁移输出到 `lib/core/db/migrations`，连接串来自 `DATABASE_URL`。

### 2.2 中间件：路由的总门

middleware.ts 是全局路由门，按严格的决策顺序处理每个请求。

第一步识别公开路径：登录页、登录 API、`.well-known/workflow/*`（Workflow DevKit 内部回调）、`/api/internal/im-stream`（fire-and-forget 消费 IM 流，带不可猜的 `wrun_` ULID 即视为鉴权）、任何含扩展名的静态资源——这些直接放行。

第二步处理 Bot webhook：`/api/bot/:adapter/*` 放行。webhook 自身在路由处理器内用常量时间比较校验 URL 中的 authSecret 与 `AUTH_SECRET` 是否相等，避免时序侧信道。

第三步处理 agentd 与 soul 回调：`/api/agentd/v1*` 与 `/api/soul*` 仅当 `AGENTD_API_KEY` 与请求头 `x-api-key` 或 `Authorization: Bearer` 常量时间比较相等时放行。也就是说这些路由走 API Key（可选叠加 mTLS），不依赖用户 session。

第四步检查鉴权是否已配置：如果缺少 `AUTH_SECRET`，API 返回 503 加缺失环境变量与示例 env，页面跳登录。

第五步是正常鉴权：从 cookie `clawless-auth` 或 `Authorization: Bearer` 取 token，两种来源走同一套 `verifyAuthToken`——这意味着 CLI 与浏览器共享同一 token 格式（base64url 编码的 payload 加 base64url 编码的 HMAC 签名）。校验通过后把 `x-user-id`、`x-user-name` 注入响应头供下游路由读取；失败时 API 返回 401，页面带 redirect 跳登录。

### 2.3 app 目录：App Router 结构

页面采用 Next.js App Router 的路由组（route groups）组织。根 layout 是 React Server Component，注入主题提供者（next-themes）、国际化提供者、Toast 通知（sonner）、移动端导航包裹器、Vercel 分析组件，并设置 robots 元数据为不可索引。登录页在 `(auth)` 组下；主聊天域在 `(chat)` 组下，包含根聊天页、具体会话页、定时任务页、附件页，有自己的 layout 与 error 边界；配置域在 `(config)` 组下，含分页签的配置页、任务、通知，配 loading 与 error 边界；技能管理在 `(skill)` 组下；长期记忆与内置记忆（SOUL/AGENTS/IDENTITY/USER）管理在 `(memory)` 组下。

RSC 与 Client Component 的边界遵循惯例：layout 多为 RSC（负责 metadata 与初始化），交互页（聊天框、配置表单）需 `'use client'`，数据获取靠 AI SDK 的 `useChat`、`@tanstack/react-query` 与自定义 transport。

API 路由（约 90 个 route.ts）按职责分组。Web 主聊天入口是 `app/(chat)/api/ai/route.ts`，用 Zod 校验请求体（含 id、trigger 类型 submit-message/regenerate-message/route-message、可选 messageId/model/input/messages），读 cookie 鉴权，调 chatMain 并以 60 秒超时包住，返回 AI SDK 的 UI 消息流响应把 workflow 的 readable 流回给浏览器。

CLI 端点在 `app/api/cli/*` 下，Bearer 鉴权。`cli/chat/route.ts` 是 CLI 主聊天入口，schema 比 `/api/ai` 多 `clientId`（必填）与 `label`，声明 source 类型为 cli，首次消息写 session channel 为 `cli:<clientId>`，触发 `local_*` 工具注册。会话 CRUD、历史拉取、上下文压缩、模型清单（含 resolveModelContextLimit 下发）、偏好、消息元数据等端点配套。

agentd 回调端点在 `app/api/agentd/v1/*` 下，API Key 加可选 mTLS，覆盖极广：节点注册/心跳/状态/健康/能力；任务（创建、查询、终结、记忆、流式输出、摘要及其进度/整理/应用）；L1 评分（单条、批量、健康）；L2 决策（请求、列表、解决、确认）；工具（流式执行透传、MCP 执行、活动日志）；知识与记忆与文件（知识搜索、记忆 CRUD、blob 上传、vault 列表）；以及其他（LLM 代理、通知发送与召回、审查日志、沙箱、会话中止与状态、agent 配置、任务摘要、工作区、L0 规则）。

Soul 端点在 `app/api/soul/*` 下：`/api/soul` GET 返回全局 `builtin_memories.SOUL` 内容，`/api/soul/[sessionId]` 返回会话级 soul。agentd 拉取后注入自己的系统提示，避免两端人格漂移。内部端点包括 `im-stream`（中间件 bypass，消费 IM 触发的 workflow 流）。业务端点覆盖配置（含 L0 规则、审计日志下载、工具活动日志、节点监控、指标）、知识库（文档、连接器、连接器同步、搜索）、vault（列表、读取）、文件下载、任务历史、配对码生成、沙箱工具、通知（含标记已读）。Bot webhook 是单一路由 `app/api/bot/[authSecret]/[adapter]/callback/route.ts` 承载所有 Chat SDK 适配器，maxDuration 设为 300 秒（IM 流可能远超默认 10 秒）。鉴权端点含登录、用户、配对生成/交换/吊销、CLI 设备列表与吊销。

### 2.4 lib 目录：核心业务模块

lib 目录按业务域划分为十余个一级子目录：ai、audio、auth、bot、chat、core（含 blob/db/kv/sandbox）、extra（agent/auth/channels/config/cron/db/memory/sandbox/security，多数是 daemon 风格子系统的 TS 镜像）、i18n、knowledge、mcp、memory、security、utils、vault、workflow（含 agent/scheduled）。

会话与消息持久化的入口是 `lib/chat/index.ts` 的 `chatMain` 函数，它是 Web、CLI、IM、定时任务共享的消息派发总闸。流程是：先 normalizeSource 把来源归一为 ChatSource（web/im/cli/scheduled）；再 parseChatInputEnvelope 区分命令与消息；命令走 executeCommand（斜杠命令），其中 `/init-agents-md` 走专用 workflow；IM 来源且无 sessionId 时先做相似度去重（返回"已有相似会话"提示）；接着 ensureMessageSession 取或建会话，assertSessionWritable 做跨通道读写校验；regenerate-message 时尝试 canResumeRun 加 pauseWorkflow；归一化输入、upsertUserMessage、必要时 deleteMessagesAfterUiMessageId 截断下游版本、使当前会话摘要失效、可能分配会话标题；最后若有可恢复的 workflowRunId 就 resumeWithMessage，否则 getConfig 解析有效模型、buildInitialContextMessages 注入 SOUL/AGENTS/RAG、startWorkflow 启动新 run，返回 runId 与 readable。

消息持久化语义值得单独说明。messages 表有 sessionId、uiMessageId（客户端幂等键，与 sessionId 联合唯一索引）、role（user/assistant/summary/tool/system）、stepNumber、payload（jsonb）、visibleInChat 等字段。一个带 `'use step'` 标注的 `persistStepDeltaAndUsageStep` 函数在每个 workflow step 结束时把 assistant 文本、工具调用、工具结果拆成多行写入，stepNumber 串起顺序——这就是"持久化每一步 delta"的字面含义。

跨通道访问控制由 `lib/chat/access.ts` 定义。SessionAccessResult 有 accessible、readOnly、forbidden 三态；channel 概念覆盖 web、`im:<adapter>`、`cli:<clientId>`、scheduled。CLI 会话对 Web 是只读的，避免两端并发改写冲突。

### 2.5 Workflow 编排：强异步的核心

Workflow DevKit（workflow npm 包加 `@workflow/ai`）把"LLM 调用加工具循环"建模为可恢复的 durable 步骤。Web 层的编排核心在 `lib/workflow/agent/`。

入口是 `chatWorkflow` 函数，函数体首行声明 `'use workflow'`，意味着这是 workflow 函数，由 DevKit 拦截、序列化、可暂停与恢复。元数据 `getWorkflowMetadata().workflowRunId`（形如 `wrun_...`）贯穿会话表、文件表、IM 回调、agentd 决策。模型解析由一个 `'use step'` 函数承担，由 DevKit 在主机执行（因此能用 fetch、读 config），给 OpenAI Responses API 注入 `store:false` 防止多步工具循环丢失上下文。

系统提示词由 buildSystemPrompt 组装：默认提示加内置记忆（SOUL/AGENTS/IDENTITY/USER，截断到上限）加 Skills 元信息加内置 MCP 工具清单加按 locale 的 follow-up 建议加沙箱路由段落。工具集由 buildAgentTools 注册九个内置工具（sandbox 执行、memory、skills、schedule、taskSummary、subAgent、agentdNodes、localCli、askQuestion），再叠加 MCP 工具。

Agent 循环用 `new DurableAgent({model, system, tools, ...})` 创建并 stream。关键回调包括：prepareStep（每步前消费指令队列，决策是否触发压缩），onStepFinish（调持久化函数落库、累计 token、检测 OpenAI Responses API 的兼容性故障），experimental_repairToolCall（修复工具名拼写），onError（记日志）。指令队列由 workflow hook 监听 user/system/control 事件，事件来源包括用户中途追发消息、`/compact`、`/cancel`——这让一个 run 跨多轮用户输入仍保持单 workflow run。

事件流回灌是关键。工具循环不直接写 HTTP response，而是写一个 WritableStream，chunk 类型涵盖用户消息标记、step 事件、工具审批请求、工具输出、token 用量、子代理批次、本地工具请求、流关闭等。dispatch 把 run 的 readable 流分两路：主路回 HTTP SSE，旁路用于检测流结束后触发回调与资源清理——因为 workflow 沙箱内无法 import `next/server` 的 `after()`（`__dirname` 缺失会导致 ua-parser-js 崩溃），改用自研的 afterResponse 与流关闭钩子。

可恢复机制是这套设计的灵魂。canResumeRun、pauseWorkflow、resumeWithMessage 都依赖 sessions 表的 workflowRunId 字段作为恢复锚点。任一执行端（agentd 或 CLI）宕机，workflow 暂停，等下一次回调续跑。

#### 沙箱限制与 'use step'

Workflow DevKit 把 workflow 函数体编译成 vm.Script 在隔离沙箱运行，没有 fetch、Buffer、`__dirname`、process、直连数据库的能力。所有需要主机能力的副作用必须放到 `'use step'` 标注的函数里——DevKit 把这种函数序列化为一个步骤，在主机重入执行，然后把结果传回沙箱。证据遍布持久化（写 messages 表）、模型解析（调 fetch）、agentd 节点调用（经 HTTP 调 daemon）、沙箱执行、读写文件、记忆、技能、任务摘要、子代理、调度、MCP、发送器等模块。

一个值得注意的反例：local_* 工具的 execute 故意不加 `'use step'`，因为它们靠 workflow hook（localToolResultHookBuilder）而非"再入 vm"；加 step 会让 DevKit 在 hook dispatch 上下文里报"只能在 workflow 函数内调用"。这是一个从历史教训中学到的边界——曾用 next/server 的 after() 因沙箱无 `__dirname` 导致崩溃，后改用自研机制。

### 2.6 安全流：L0、L1、L2

存在两套并行的 L0/L1/L2 实现，一套在 `lib/extra/security/`（面向独立部署的安全评估引擎，被 workflow 工具的 execute 前检查引用），一套在 `lib/security/`（Web 侧 L1 镜像加持久化 L2 队列）。

L0 是规则黑名单。规则带 pattern 与 patternType（regex 或 glob）、action（allow/block/escalate）、priority、enabled。匹配按 priority 降序，首条命中即决。block 可被 temporaryOverrides（限时放行，L2 通过后写入）。默认规则集覆盖 rm -rf /、mkfs、fork bomb、提权、curl 加管道等危险模式。glob 到 regex 的转换有专门工具函数。

L1 是 LLM 打分。scoreCommand 用 resolveLanguageModel 解析模型，调 generateObject（带 l1ScoreSchema）返回 score（0 到 1）、level（low/medium/high/critical）、reason。提示词明确告诉模型"沙箱内执行，rm -rf / 仅毁沙箱文件系统"，按十个维度评分（改宿主路径、提权、curl 加管道、逃逸等）。同文件还有 scoreOutput（输出侧泄露检测）和 scoreMemoryRelevance（记忆召回相关性二次过滤）。阈值方面，score 大于等于 85 视为 critical（TTL 5 分钟），否则 high（TTL 15 分钟）。

L2 是用户授权。决策队列是进程内热缓存加 Postgres `l2_decisions` 表持久化的双写设计。早期是纯内存 Map，Vercel 重部署会丢全部 pending L2；现在改为每次 enqueue、resolve、deny、expire 都同步写库，启动时从库重建缓存。状态机是 pending 到 sent 到 resolved/denied/expired/timeout。pending 与 sent 视为 active（UI 可见）。决策类型有 l2_auth、question、conflict、branch。并发上同 task 最多 3 个 sent，跨 task 默认串行。超时看门狗每 5 秒扫描，sent 状态超 timeoutAt 转 timeout。waitForResolution 函数给 Web TS agent 的 ask_question 工具用——阻塞 workflow step 直到 UI 回答。

路由协同上：daemon 侧 L1 高危会 POST 到 `/api/agentd/v1/l2/request` 入队（TTL 5 分钟）；UI 回答后 POST 到 `/api/agentd/v1/decisions/[id]/resolve`，按 decision.type 归一化 action（pass once/always、reject、answered 等），调 queue.resolve 或 queue.deny；对 l2_auth 调 forwardL2Confirm 把结果回传 daemon 解除阻塞；对带 nodeId 的 question 创建后续 task 把答案送回 daemon（因 daemon 的 ask_question 是 fire-and-forget）。Web 自身的 question 不经 daemon，靠 waitForResolution 解 Promise 解除阻塞。

### 2.7 多节点调度

多节点调度的核心代码在 `lib/workflow/agent/dispatch.ts`，配合 `agentd_nodes` 表。

节点注册是 `POST /api/agentd/v1/nodes/register`，接收 node_id、ip、port、sandboxes 数组、version，upsert 到 agentdNodes 表，返回 `{interval: 30}`（心跳间隔 30 秒）。

心跳是 `POST /api/agentd/v1/nodes/heartbeat`。字段含 cpu_model、cpu_usage、mem_avail、disk_avail、active_tasks、active_sandboxes 加每沙箱的 cgroup 统计数组。聚合函数把每沙箱的 cgroup v2 样本（memory.current/peak、cpu.usage_usec）求和，跳过 sentinel `-1`（cgroup v1 host），写回沙箱内存当前与峰值总量、CPU 微秒总量，并更新 lastHeartbeat 与 status。

选节点用 selectBestNode 函数。先查 status 为 online 且 lastHeartbeat 在近 2 分钟内的节点；无则返回 null。然后用 allowedNodes（每代理白名单）过滤，再用 requiredSandbox 类型过滤（节点 sandboxes 数组须包含）。资源打分跳过 cpu 大于 0.9 或 mem 小于 0.1 或 disk 小于 0.1 的过载节点；baseLoad 是活跃 task 加沙箱数取上限 10 除以 10，memPressure 是 cgroup 峰值除以 8GB 取上限 1，activeLoad 是 baseLoad 加 memPressure 乘 0.5 取上限 1；最终 score 是 CPU 空闲率乘 0.35 加内存空闲率乘 0.35 加磁盘空闲率乘 0.2 加（1 减 activeLoad）乘 0.1。同分按活跃 task 升序。返回 null 时调用方回退到 Vercel Sandbox。

健康探测 isAgentdAvailable 先查有节点，再实际 HTTP 探一下 daemon。工具执行 execToolOnAgentd（带 'use step'）未指定 nodeId 时自动 selectBestNode，然后 POST 给 daemon 的 `/api/v1/tools/exec`，带 mTLS 证书。这套机制让 Web 既能水平托管多个 daemon 节点，又能在节点全不可达时优雅降级到 Vercel 自带 Sandbox（执行工具有 backend 标识区分 agentd 与 vercel-fallback）。

### 2.8 数据访问层

数据访问层在 `lib/core/db`。db 是懒加载单例，用 Proxy 在首次访问时初始化：neon 驱动加 drizzle，Serverless HTTP 驱动无连接池开销。schema 索引重导出十余张表加决策类型。

KV 层用 Upstash Redis 封装，涵盖全局配置（AppConfig，含 providers/models/channels/agentd/skills）、通用 get/set、IM 配对状态标记（`pair:bound:<adapter>:<imUserId>`）、分布式锁（避免并发导入或同步重复）。Blob 层用 Vercel Blob 封装，存附件与技能仓库同步产物。Vercel Sandbox 管理器管理 Sandbox 生命周期加 runtime 元数据（patchWorkflowRuntime 写 phase 与 lastRunId）。

### 2.9 Provider 抽象

Provider 抽象在 `lib/ai`。parseProviderScopedModelId 把 `provider/model-id` 拆分，bare modelId 走首个配置的 provider。resolveLanguageModel 解析 provider entry 后 getProvider 按 format 分支：openaicompatible 用 createOpenAICompatible，anthropic 用 createAnthropic，openai 用 createOpenAI，google 用 createGoogleGenerativeAI。

关键的兼容性处理是 shouldUseChatAPI。`@ai-sdk/openai` 默认走 Responses API（`/v1/responses`），但第三方 OpenAI 兼容端点（GLM、DeepSeek 等）通常只实现 Chat Completions。决策顺序是：provider 配置的显式 openai_api 值优先，其次预设组合，最后 auto（检测 base_url 是否为官方 api.openai.com）。需走 Chat API 时用 provider.chat(model)。embedding 与 TTS（仅 OpenAI）分别用于 RAG 索引检索与语音。resolveModelContextLimit 在 Web 解析后经 `/api/cli/models` 下发给 CLI 与 IM，避免三层各自维护一份上下文表。

### 2.10 MCP、Skills、Soul

MCP 子系统在 `lib/mcp`。内置 MCP server 覆盖 web、firecrawl、github、context7 四个名字，每个自带 serverInfo、instructions、tools 数组、execute 函数，对外暴露为 MCPTransport，AI SDK 经 createMCPClient 拉取工具定义。远程 MCP server 配置存在 AppConfig 的 mcp.remote_servers，workflow 启动时加载，失败的 server 用 Promise.allSettled 容忍。工具调用经 withToolExecutionLogger 记入 agent_tool_activity_logs。

Skills 子系统在 `lib/core/kv/skills.ts` 加 `lib/core/blob/skills.ts` 加 workflow 的 tools/skills。存储上元数据存 KV，文件内容存 Blob。技能入口由 getSkillEntrypointPath 决定，优先 clawhub.json 的 entrypoint，回退 SKILL.md（类似 OpenCode 技能约定）。工具暴露 listSkills、getSkill、getSkillFile（支持行号切片）、getSkillEntrypoint、updateSkillFile、createSkill、deleteSkill——主 agent 可自主管理技能。委派给子 agent 时，buildSystemPrompt 注入技能清单，agent 决定调 subAgent 工具时 buildNestedTools 递归构建子工具集（可限制 delegation 深度），用独立 DurableAgent 跑（子代理最大步数 12，并发上限 3）。

Soul（人格）子系统在 builtin_memories 表，key 在 AGENTS/SOUL/IDENTITY/USER 中选，单行 content。注入由 buildSystemPrompt 调 getBuiltinMemorySection 把内容拼进系统提示（截断到上限）。会话级 soul 写在 sessions.soulContent。对外 GET `/api/soul` 返回全局 SOUL，GET `/api/soul/[sessionId]` 返回会话级，daemon 拉取后注入自己的系统提示。

### 2.11 Memory 与 RAG

三层记忆设计。第一层 builtin_memories 是 AGENTS/SOUL/IDENTITY/USER 四块内置人格记忆。第二层 session_memories 是每会话压缩摘要，summaryVersion 加 isCurrent 单版本指针。第三层 long_term_memories 加 long_term_memory_chunks 是长期事实/偏好/决策/对话，带 (userId, key) 唯一索引去重 upsert；chunks 持 embedding（vector）、tsv（tsvector，GIN 索引），支持向量加全文混合检索。

抽取在 workflow 结束后（finalizeRunStep）的 afterResponse 调度一次 LLM generateObject，产出 key、content、memoryType、importance、action（ADD/UPDATE/DELETE/NOOP），按 (userId, key) upsert。Best-effort，任何失败仅记日志。召回在 buildInitialContextMessages 按 recallUserId/recallQuery 检索；策略可选 scorer 用小模型对候选做相关性二次过滤，避免噪音注入。

知识库（RAG）独立于长期记忆，在 `lib/knowledge`。有 knowledge_bases、knowledge_documents、knowledge_connectors、knowledge_chunks 四张表。支持 team/private 可见性、local/remote 类型、url/mem0/http connector。searchKnowledge 做混合检索（embed 加 tsvector 加可选外部 provider），mergeKnowledgeCandidates 合并。`/api/knowledge/search` POST 查询，requireAuthAccess 鉴权并按 userId/isAdmin 过滤可见性。

### 2.12 审计、监控、日志、Vault

每次工具调用详细记入 agent_tool_activity_logs（taskId、sessionId、agentId、userId、roles、source、sandboxId、model、step、toolCallId、toolName、action 区分 read/write/execute/search/network/other、target、arguments、result、outputText、success、error、durationMs、startedAt、completedAt），四条索引。由 withToolExecutionLogger（workflow 工具包装）与 daemon 回调 `/api/agentd/v1/tool-activity-logs` 写入。安全决策审计记入 agent_review_logs（taskId、roles、command、level、score、decision、reason）。凭证库读写审计记入 vault_audit_logs。节点监控经 `/api/config/monitoring/{nodes,metrics}` 暴露给配置页 UI。日志规范统一用 `lib/utils/logger.ts` 的 createLogger('namespace')，AGENTS.md 强调禁 console.log。

Vault 子系统在 `lib/extra/vault`。vault_entries 表 key 唯一、encrypted_value 加 nonce（Libsodium/XChaCha20-Poly1305 风格）加 vault_audit_logs。给 daemon 配发的 provider API key、第三方 token 都经 vault 加密存储；`/api/vault/{list,read}` 与 `/api/agentd/v1/vault/list` 提供读取接口。

### 2.13 数据库 Schema 概览

所有表均 Postgres，主键多用 uuid 默认随机，时间戳带时区默认 now。核心表包括：sessions（会话，含 channel、externalThreadId、userId、model、systemPrompt、soulContent、status、workflowRunId、sandboxId、totalTokens、metadata、archived）；messages（消息，sessionId 外键级联删除、uiMessageId、role、stepNumber、payload jsonb、visibleInChat）；users（用户，username 唯一、passwordHash、roles、modelPreferences）；cli_devices（CLI 设备，tokenJti 唯一、pairedAt、lastSeenAt、revokedAt）；im_accounts（IM 账号，adapter、imUserId、双唯一索引）；files（附件，sessionId、runId、sandboxId、blobPath、blobUrl）；各类记忆表；各类 agent 任务与审查表；agentd_nodes（节点，nodeID 主键、sandboxes 数组、status、各类资源字段、lastHeartbeat）；l2_decisions（L2 决策，decisionId 唯一、type、status、payload、resolution、expiresAt）；notifications 与 notification_preferences 与 channel_health；vault_entries 与 vault_audit_logs；以及 scheduled_tasks、workspaces、task_summaries、archived_task_summaries。

pgvector 使用上，自定义 variableVector 类型把 number 数组序列化成 Postgres vector 字面量；自定义 tsvector 类型用于全文检索列。向量列在 long_term_memory_chunks.embedding 与 knowledge_chunks.embedding；全文列带 GIN 索引。ensure-vector-extension 脚本运行 `CREATE EXTENSION IF NOT EXISTS vector`，在 vercel-postbuild 与 yarn db:ensure-vector 中调用。embedding 元数据 embeddingModel 与 embeddingDimensions 配合索引以支持多模型共存查询。

### 2.14 IM 多渠道接入

入站（Webhook 到会话）的统一入口是 `app/api/bot/[authSecret]/[adapter]/callback/route.ts`。中间件放行 `/api/bot/*`，路由内 isValidBotSecret 校验 URL 段 authSecret 等于 AUTH_SECRET（常量时间）。maxDuration 设 300 秒。分支上，Chat SDK 适配器（slack/teams/gchat/telegram/discord）经 getBot 用 bot.webhooks 处理请求，after 把流式回复 drain 放后台；飞书走 handleFeishuWebhook 处理 challenge 验证与加密事件；QQ 走 handleQqWebhook。getBot 经 getBaseBot 与 createBotAdapters 按 channels 配置动态 import 适配器，飞书与 QQ 在 lib/extra/channels 自实现。状态存 Upstash Redis。

入站消息处理先把附件转消息部分，构造 ChatSource（含 type im、adapter、threadId、userId、locale、messageId），做配对校验（isImUserAuthorized；未授权且非 /pair、/start、6 位 pair-code 就写"拒绝访问"会话加拒绝文案；已授权清拒绝标记），解析 locale（thread 到 user 到全局到 auto），最后 routeAdapterMessage 把 IM source 喂给 chatMain，后续与 Web 同栈（命令解析、去重、会话、workflow）。

出站（回复）方面，workflow 写 chunk 到 writable，sender 的 bot-steps（带 'use step'）把结构化回复经 Chat.sendMessage 推回原 thread。统一通知机制由 ChannelManager 把 Discord/Slack/Telegram/Feishu 抽象成统一 IChannelAdapter，NotificationManager 按 notification_preferences 的 preferredChannel 加 fallbackChannels 投递，失败转 fallback，记 channel_health。notifications 表持久化每次投递（pending 到 sent 到 delivered/failed/fallback/expired），支持召回。

### 2.15 Web 到 agentd 的 mTLS 与 API Key

Web 到 agentd 的通信在 `lib/extra/agent`。getAgentdClientConfig（带 'use step'）从 appConfig.agentd.nodes[0].url 或 AGENTD_URL 取 baseUrl，叠加 AGENTD_API_KEY；若设了 AGENTD_CLIENT_CERT_PATH/KEY_PATH/CA_PATH，读文件作为 mTLS 凭证。高级 API（forwardL2Confirm、sendDecision、requestDaemon 等）封装在 agentd-client，全部走 requestAgentd（底层 fetch 加 mTLS）。鉴权双向：中间件用 AGENTD_API_KEY 校验入站 daemon 回调，出站叠加客户端证书；daemon 侧校验 Web 客户端证书。

---

## 三、agentd 架构（Go 守护进程）

agentd 是平台在用户 VPC 或裸机上的执行面。它是一个 Go 单二进制（Go 1.26.2，仅 Linux amd64），以 root 启动、完成特权操作后下放权限到非特权用户运行。本节详述其入口、配置、HTTP 服务、节点生命周期、沙箱、安全流、并发模型与 Agent 循环。

### 3.1 入口与启动流程

入口在 cmd/agentd/main.go，启动流程严格有序。先做 OS 校验，非 Linux 直接退出；解析 flag（config、gen-certs、cert-dir、tui）；若 -tui 走交互式安装向导（基于 charmbracelet 的 huh 表单）写入配置后返回，不需 root；否则校验 root（cgroup/namespace/沙箱创建需要 capability）；若是 -gen-certs 调证书生成；加载配置（含默认值、env 覆盖、校验）；检查系统依赖（默认沙箱类型所需）；切换自定义 slog 日志处理器（格式含 module、func:line、level、message、key=value）；获取单例锁；端口探测；解析节点身份（identity.Resolve）；创建指标收集器（10 秒采样，输出到 /tmp/agentd/metrics.json）；下放权限到 runAsUser；装配安全组件（L0 引擎、L1 客户端、L2 管理器、Gatekeeper）；创建 ClawLess 客户端（失败回退无 mTLS 的普通 HTTP）；异步注册节点（5 次重试）；启动 L0 规则热加载（每 5 分钟从 Web 拉取）；创建沙箱管理器（含 Restore 与 ReapOrphans 崩溃恢复加常驻 HealthChecker）；预检 Docker/LXC 可用性并预拉镜像；创建 Agent Manager（注入 bus 与 gatekeeper，挂载 agent 与 cgroup stats 回调）；启动心跳（回调读实时活跃 session/sandbox 数）；创建 Dispatcher 与 worker pool；启动后台任务存储与缓存管理器（周期性上游同步）；创建 HTTP server（gin ReleaseMode，按配置加载 mTLS）；在 goroutine 中监听；处理 SIGINT/SIGTERM（30 秒内清理沙箱：docker 销毁、LXC 停止保留 rootfs；10 秒内关 HTTP server）。

### 3.2 配置

配置用 Viper 加 TOML，文件名 agentd.toml，搜索路径含当前目录与 /etc/agentd。env 覆盖前缀 AGENTD_（如 AGENTD_SERVER_LISTEN）。默认值由结构体 default tag 反射注册。校验涵盖：version 必须为 1；l1_provider 仅认 web_callback 或 local_ollama；rootful docker 防误用（判定 /var/run/docker.sock、/run/docker.sock、tcp://、http(s):// 为特权端点，必须显式 allow_rootful_docker 才允许）。热重载钩子存在但 main.go 未启用。

配置项分多个 section。server section 含 listen（默认 :18732）、入站 mTLS 的 tls_cert_path/tls_key_path/ca_path（空则纯 HTTP）、clawless_api_key（双向共享密钥，X-API-Key 头）。clawless section 含 base_url、出站 mTLS 的 client_cert_path/client_key_path/ca_path（Vercel 部署必须留空，否则覆盖系统根 CA 破坏 Let's Encrypt 校验）、heartbeat_interval（默认 30s）、node_id_file（默认 /var/lib/agentd/node_id）。security section 含 l1_enabled、fail_open（L1 出错时是否放行，生产应 false）、l1_provider、l1_model/l1_api_key（可空，空则用 Web 配置的 scorer 模型）、run_as_user、l1_threshold 各档（实际决策走 Level 字符串而非数值门）。tools section 含 disabled 禁用名单。sandbox section 含 default（默认 docker）、docker_socket（推荐 rootless）、allow_rootful_docker、各档 CPU/内存默认、allowed_images（docker-strict 白名单）、os_enforce（是否启用 seccomp/cap-drop/masked-paths）、seccomp_profile_path（空则自动生成）、network_isolate（默认隔离网络）、lxc 的 init_commands（首启初始化）。cache section 含 path、session_max_size、sync_interval、retry_max_attempts。session section 含 max_count（默认 50）、timeout（默认 30m）、store_path。worker 与 worker_pool 与 exec_pool section 控制各池大小与伸缩参数。task_summary section 含 tidy_interval（默认 168h）、max_decisions。logging section 含 level、module、add_source。

单例锁用三层防御：socket lock /var/run/agentd.sock（net.Listen unix，OS 原子互斥，免疫 PID 复用与 TOCTOU）、PID 文件 /var/run/agentd.pid（格式 pid 加 unix 时间戳，原子写用 tmp 加 rename）、端口探测（绑 listen 后立即关，捕获 socket 文件被删但仍监听的边缘情况）。socket 被占时读 PID，通过 /proc/<pid>/exe 路径比对加 /proc/<pid>/cmdline basename 前缀 agentd 双重确认存活与身份。kill -9、OOM、断电后，下次启动发现 PID 死就清理 stale socket/pid 重新获取。

### 3.3 HTTP 服务与路由

框架用 gin ReleaseMode 加 Recovery 中间件。全局中间件是 CORS 加请求日志。响应统一封装为 success、data、error 三字段。公开端点（无鉴权）含 GET /health 与 GET /metrics。保护端点 /api/v1/* 的中间件顺序是 MTLSMiddleware 到 APIKeyMiddleware：mTLS 仅在请求带 TLS 时强制（纯 HTTP 部署只靠 API key）；API key 走 X-API-Key 或 Authorization: Bearer，用 subtle.ConstantTimeCompare 防时序侧信道；clawless_api_key 为空时直接拒绝所有请求。

路由清单覆盖：POST /tasks（Web 下发任务，发布 task.created 事件到 review pool 再过 Gatekeeper）；GET/PUT /tasks/:id；会话相关 GET/PUT/DELETE /sessions/:id、GET /sessions 与 /sessions/status、POST /sessions/switch 与 /sessions/close、POST /sessions/:id/abort 与 /sessions/:id/destroy；POST /review-logs 写审查日志到 Web；记忆 CRUD（透传 Web）；GET /agent-config/:id 拉取 agent 配置；GET /l0-rules/:id 拉取 L0 规则；POST /sandboxes、PUT /sandboxes/:id 上报沙箱元信息；POST /llm-proxy LLM 请求代理（支持 SSE）；POST /l2-confirm 接收 Web 回传的用户 L2 决策（action 在 pass_once/pass_until/reject_once/reject_until 中选，发布 l2.auth_approved 或 l2.auth_rejected 事件）；POST /tools/exec 同步单工具执行（Web 到 Daemon 主路径）；POST /tools/exec/stream SSE 流式 exec（只允许 exec 与 sandbox_install，15 分钟上限，500ms 轮询后台存储，15 秒心跳）；以及一组语义化便捷端点（read/write/edit/ls/grep/glob/patch/git/web-fetch/web-search/memory-search/memory-save/sandbox-install 等）全部转发到 handleToolExec。

值得注意：/nodes/register 与 /nodes/heartbeat 不在 agentd 侧——它们是 Web 侧 /api/agentd/v1/nodes/* 端点，agentd 作为客户端 POST 调用。

双向通信模型上，Daemon 到 Web 始终走 HTTPS（普通公网 TLS）加 X-API-Key 头，所有出站调用统一走 ClawLess 客户端的 doRequest，路径形如 /api/agentd/v1/<resource>。关键出站调用含注册、心跳、工具活动日志、审查日志、L1 打分、LLM 代理、L2 通知、任务回调、记忆、知识库、工作区、blob 上传、SOUL、能力查询。Web 到 Daemon 仅当 Daemon 网络可达（Pattern B）时走 HTTPS（若配了 tls_*）加 mTLS 客户端证书加 X-API-Key。

### 3.4 节点注册、心跳与身份

节点注册 RegisterNode 是异步 goroutine，5 次指数式重试（attempt 乘 3 秒）。payload 含 node_id、ip（本机非环回 IPv4）、port（解析自 listen）、sandboxes 数组（docker、docker-strict、lxc）、version。Web 返回 node_id 与 interval（interval 由 Web 决定心跳节奏，但实际心跳仍用本地 heartbeat_interval）。

节点身份持久化在 identity 包。Resolve 读 node_id_file（默认 /var/lib/agentd/node_id，持久化存储——早期默认 /var/run/agentd.node_id 是 tmpfs，主机重启即丢，会导致 Web 侧产生重复节点行），存在则复用，否则生成 `node-<hostname>-<unix_nano>` 并写盘。复用此文件即跨重启保持节点身份。

心跳默认 30 秒。每次先 metrics.Read 读取本地 metrics JSON（含 cpu_model、cpu_usage、mem_avail、disk_avail、每 agent 沙箱数、cgroup_stats）；countsFn 回调（由 main.go 注入）返回实时活跃 task 数与活跃 sandbox 数（从 AgentManager.GetAgentStats 去重 sandbox_id 统计）；payload 含 node_id、各项资源、per_agent、cgroup_stats、timestamp；Web 回 accepted（响应未使用）。失联后果在 agentd 侧不主动处理——由 Web 侧节点调度器基于心跳时延把节点标记 offline、不再派任务；agentd 不重连，只继续周期发（失败仅 slog.Warn）。

### 3.5 沙箱执行：三档提供者

沙箱管理器注册三个提供者。docker（docker light）用 DockerLightProvider，一次性命令、Alpine、`--rm`、低资源。docker-strict 用 DockerProvider，不可信或高风险代码、强隔离。lxc（LXC persistent）用 LXCPersistentProvider，长期会话、git、浏览器、多步开发。SandboxProvider 接口含 Create、Exec、Destroy、Status；LXC 额外实现 ForceDestroyer 的 DestroyForce。

沙箱选择 SelectSandbox 的优先级是：用户显式 SandboxType（非 auto）优先；高风险命令（rm -rf、mkfs、dd if=、curl 加管道、sudo 等）走 docker-strict；需持久化的操作（git clone、npm install、browser_*、web_fetch_rendered 等）走 lxc；否则 agent 配置默认；兜底 docker。Permission Profile（default/strict/network/package-install/browser/persistent）会强制改写 spec.Type（如 package-install 转 lxc 且 Persistent 为 true），并按 profile 调整 SecurityPolicy 的 NetworkNone。

三档隔离差异体现在多个维度。镜像方面，docker light 用 alpine:edge 可覆盖，docker-strict 用白名单（allowed_images）默认 ubuntu:22.04，LXC 用 lxc-create -t download（alpine 或任意 distro）。网络方面，docker light 受 network_isolate 控制（`--network none`），docker-strict 强制 `--network none`，LXC 默认 lxc.net.0.type 为 none。能力位方面，docker light 在 `--cap-drop ALL` 后按 BaselineKeep 加回，docker-strict 是 `--cap-drop ALL` 不加回（更强），LXC 用 lxc.cap.drop 丢弃约 30 个高危 cap（SYS_ADMIN、NET_ADMIN、NET_RAW、SYS_BOOT、SYS_MODULE 等）。根文件系统方面，docker light 是 `--read-only` 加 tmpfs /tmp 128m 加 /workspace 512m，docker-strict 类似但 /tmp 256m，LXC 是普通 rootfs 可写。seccomp 方面，docker light 用 DefaultHardened profile（当 os_enforce 为 true），docker-strict 始终带，LXC 用 lxc.seccomp.profile（LXC 文本格式）。资源限额方面，docker light 默认 CPU 0.25、内存 256m，docker-strict 默认 CPU 1.0、内存 512m、pids-limit 128，LXC 用 cgroup v2 的 cpu.max 与 memory.max 加 cgroup v1 fallback。masked paths 用 /dev/null 绑定覆盖 /etc/shadow 等。生命周期方面，docker light 带 `--rm`，docker-strict 不带 `--rm`（Destroy 是 stop 加 rm -f），LXC 默认 Persistent 时 lxc-stop 保留 rootfs，仅 DestroyForce 才 lxc-destroy -f。出站 egress 用 EgressAllowlist glob，经 DNS 解析后用 iptables 注入 netns；egressRefresher 周期重应用以防 CDN DNS 漂移。

DefaultHardened seccomp 默认 SCMP_ACT_ALLOW，ERRNO 拒绝 init_module/finit_module/delete_module、kexec_load、reboot、mount/umount2/pivot_root、ptrace/process_vm_*、swapon/swapoff、unshare/clone3、bpf/perf_event_open、keyctl/add_key/request_key、memfd_create、setns，以及带参数过滤的 ioctl(TIOCSTI)。

工具在沙箱内执行时，命令注入统一用 `sh -c <cmd>`（docker）或 `lxc-attach -- sh -c <cmd>`（LXC），由沙箱提供者构造。结果回收用 CombinedOutput 拿 stdout 加 stderr 合并，解析 exec.ExitError 得退出码，封装 ExecResult（Stdout、Stderr、ExitCode、Duration）。超时用 context.WithTimeout 包裹 exec.CommandContext，到点 kill（CodeAct 单块默认 30 秒）。一个有意思的细节：L0 命中后不是返回"被规则拦截"，而是用 formatOSError 伪造 shell 错误（如 `sh: rm: Operation not permitted`），让 LLM 误以为是 OS 层拒绝、保持沙箱抽象完整。

沙箱恢复与巡检方面，Restore 在重启后从 SandboxStore（磁盘 JSON）重填内存 map 与各 provider 内部 map。ReapOrphans 在启动时一次清扫（Docker 孤儿销毁、LXC 孤儿 stop 保留 rootfs）。HealthChecker 常驻周期探活，连续失败至少 2 次才 reap（避免 docker daemon 抖动误杀）。CleanupOnShutdown 在停机时 stopAllLXC 加 destroyAllDocker，30 秒预算。

### 3.6 三层安全在 agentd 侧的落地

编排入口是 Gatekeeper.Audit，由 Dispatcher 的 handleTaskCreated 在 task.created 事件中调用。流程是 L0 到 L1 到 L2，外加 output audit。

L0 是确定性规则黑名单。来源有二：内置预设 DefaultPresets 与 Web 下发（由 Loader 周期 5 分钟拉取并 Engine.Reload 热替换）。规则类型在 command、path、network 中选，目前 action 全为 block。匹配两步级联：glob（path.Match）到 regex（编译缓存在 sync.Map）。命令类预设覆盖 rm -rf /、rm -rf /*、mkfs.*、dd if=.* of=/dev/、fdisk、wipefs、curl.*\|.*bash、wget.*\|.*sh、sudo、su -、chmod 777、chown root、iptables -F、shutdown、reboot、killall、pkill、nc -l、ncat -l、python -m http.server。路径类预设覆盖 /etc/shadow、/etc/passwd、/etc/ssh/、/proc/、/sys/、/root/.ssh/、~/.ssh/。网络类预设覆盖 nmap、masscan、hydra。命中行为是直接 DecisionBlocked，不发 L1，发 EventSecurityAlert 事件，写 review log。注意没有 fork bomb 之类抽象语法检测，L0 全是字符串或正则模式匹配。输出审计用独立规则集 DefaultOutputRules，检 LLM 输出是否泄露系统提示（"## 安全规则"、"you are AgentBoster"）、越狱指令（"ignore previous instructions"、"DAN mode"）、API key 或 Bearer token 或私钥头、内部敏感路径。命中后 AuditOutput 返回 blocked，Agent loop 注入安全替换消息。

L1 是 LLM 风险打分，不本地推理，而是调 Web 的 /api/agentd/v1/l1-score 端点；模型 ID 由 l1_model 配置或 Web 侧默认。l1_provider 仅支持 web_callback 或 local_ollama（校验），但 local_ollama 实现未找到，实际可用路径只有 web_callback。可用性探测在启动时调 /l1-health；失败则 available 为 false，后续所有 Score 直接返回 score 0.8、level high 强制走 L2。批量打分 ScoreBatch 用单次 LLM 调用打分多条命令，LLM 词表 allow/low/medium/high/block 映射回 low/medium/high/critical；失败回退逐条 Score。硬化 hardenL1Result 处理：nil 结果转 0.8 high；未知 level 强制 high；确定性 L2 模式（deterministicL2Patterns）正则匹配 shred、find -exec ... rm/shred/dd、find -delete、xargs ... rm/shred/dd、perl/ruby/node -e ... unlink/rmtree、python -c ... shutil.rmtree 等，无论 L1 给多少分都抬到 high 强制 L2。决策门基于 Level 字符串：low 放行；medium 放行但发 EventSecurityAlert（非阻塞通知用户）；high 或 critical 转 L2。失败策略：L1 调用出错时 fail_open 为 false（默认）则 blocked，fail_open 为 true 则当作 medium 放行。关键：fail_open 仅对"调用失败"生效；L1 返回 high 或 critical 永远走 L2，不存在"被 L1 自动放行的高危"路径。

L2 是人工授权。触发时 Gatekeeper 进入 requestL2Auth，先查本地 L2 缓存（L2AuthManager.Check），命中即放行或拒绝；未命中发布 EventL2AuthRequired 事件，task 进入 pending_confirm。通知由 Dispatcher 的 handleL2AuthRequired 调 ClawLess.SendNotification 推 IM 决策卡，带 command_review（FormatCommandReview 把命令分段、风险段标 !、附 level/score/reason），options 在 pass_once、pass_until、reject_once、reject_until 中选，expiresAt 为 now 加 3 分钟。若 IM 平台支持 Delete（消息撤回），5 秒后自动撤回该决策卡。用户响应经 Web 收到按钮回调，POST agentd 的 /api/v1/l2-confirm，发布 l2.auth_approved 或 l2.auth_rejected 事件。Dispatcher 的 handleL2Auth 更新 L2 缓存（AuthorizeTask 或 RejectTask，duration 在 once/always/hhddmmyy 中选；once 不写缓存，always 写到 session 生命周期末，hhddmmyy 按 hh/dd/mm/yy 计算 TTL），写 L2 review log，pass 则重发 task.approved 让流程继续，reject 则 task.rejected。deny 后任务被拒绝、不再执行；L2 缓存记住该 pattern，后续命中直接 silent reject。过期清理后台 30 秒周期 ExpireStale 加写 expired review log。L2AuthManager 注释明确只做"本地快路径"，DecisionQueue 与 pending 任务持久化已移到 Web 层。

agentd 与 Web 安全职责分工清晰：L0 规则 agentd 为主、Web 仅下发规则源（快速确定性 deny，执行点在 agentd）；L1 打分 Web 推理、agentd 仅 HTTP 调用（模型与提示在 Web 维护，agentd 不持有 LLM key，除可选 l1_api_key）；L2 决策 Web 或 IM 触发、agentd 缓存与执行（Web 渲染按钮卡、记录决策、回调 l2-confirm；agentd 维护本地缓存避免重复打扰）；output audit 双侧（agentd 用 L0 output 规则本地拦，AuditOutput 还会再调 L1 ScoreOutput）；OS 强制仅 agentd（seccomp/cap-drop/mount/network，L0 规则到 OSPolicy 映射）。os_enforce.FromL0Rules 把 L0 规则按子类型分类（privesc、fileperms、syscontrol、diskops、netscan、pathblock 等），映射成 OSPolicy：dangerous caps 全丢、baseline 保留、masked/readonly paths、NetworkNone。

### 3.7 worker pool 与事件总线

事件总线是进程内 pub/sub，每个订阅者一个独立 goroutine 加 buffered channel（容量 100）。Publish 非阻塞：channel 满直接丢弃加 slog.Warn，防慢消费者背压。事件类型集涵盖 task 生命周期、sandbox、security（L0/L1/L2）、memory、session、decision、task_summary tick、exec。注意这不是 SSE 或 WebSocket：bus 纯进程内；对 Web 的"流式回传"靠 SSE 端点 /tools/exec/stream 与 ClawLess API 调用。断线重连不存在，bus 事件丢失即丢失。

Worker Pool 是动态 goroutine 池，6 个独立池：task、review、sandbox、memory、cleanup、exec。每池 tasks channel 容量为 maxWorkers 乘 4。自动伸缩由 adjustLoop 加 adjust 实现：周期 stats_interval（默认 30 秒，exec 池 5 秒）检查 len(tasks)/cap(tasks) 利用率；利用率大于等于 scale_up_pct（75%）且未达 max 就 spawnWorker；利用率小于等于 scale_down_pct（25%）且超 min 就 cancel 最后一个 worker；cooldown（30 秒，exec 10 秒）内不重复伸缩。worker 内 recover 防止单任务 panic 拖垮池。优雅停止时 Stop 关 stop channel，worker drain 残留任务后退出。

Dispatcher 路由把事件映射到池：task.created 到 review 池（handleTaskCreated：Gatekeeper.Audit 到 approved/rejected/pending_confirm）；task.approved 到 task 池（handleTaskApproved：建 session、选沙箱、建 workspace、agentManager.RunAgent）；task.completed 到 memory 池（handleTaskCompleted：抽记忆加发完成通知）；sandbox.created/destroyed 到 sandbox/cleanup 池（同步到 Web）；security.alert 到 review 池（写 review log 加发通知）；l2.auth_required 到 review 池（发 IM 决策卡）；l2.auth_approved/rejected 到 review 池（handleL2Auth：更新缓存加复跑或拒绝 task）；session.closed/archived 到 cleanup 池（清 L2 缓存、删 session store、force-destroy 沙箱）；task_summary.tidy_tick 到 memory 池（RunTaskTidy 周期 168h 默认）；exec.requested 到 exec 池（HandleExecCommand）。

### 3.8 多步 Agent 与 CodeAct 循环

agentd 同时存在两条执行路径，这是确认"执行端边界"的关键。

路径 A 是 Web 下发单步工具调用（主路径，同步）。入口 POST /api/v1/tools/exec 到 Manager.ExecuteTool。流程是获取或创建 session，拉取 SOUL 加 AgentConfig，构建工具注册表，直接执行单个工具（不经 Agent loop、不调 LLM），写 tool activity log，返回 success/data/error。LLM 推理在 Web 侧：Web 跑模型循环，每决定一个 tool call 就 HTTP 调 agentd 执行。agentd 在这条路径上只是"工具执行器"。工具家族覆盖 exec/exec_background/exec_batch、read/write/edit/ls/grep/glob/patch、git（clone/diff/status/push）、web_fetch/web_search/web_fetch_rendered/web_search_rendered、memory_search/save、knowledge_search、vault_list、task_summary/progress、deliver_files、sandbox_install、ask_question、sandbox_skills、sandbox_media、codeact、subagent/subagent_result、mcp_call（gated）、browser_*（v2，Playwright bridge）。工具活动通过 tool_activity-logs 上报 Web。

路径 B 是 agentd 自跑 Agent Loop（异步任务路径）。触发是 POST /api/v1/tasks 到 task.created 到 review 池到 Gatekeeper.Audit 到 approved 到 task 池到 Manager.RunAgent。AgentLoop.Run 是 think 到 act 到 observe 的经典循环，直到 LLM 不再调工具或达到 maxSteps（默认 30）。每步先压缩检查（消息大于等于 50 触发 compactContext），构建系统提示，通过 /llm-proxy 调 Web 代理的 LLM，output audit，执行 tool call（再过一次 Gatekeeper.Audit 对工具调用本身），观察结果回灌。LLM 仍由 Web 代理（LLMProxyRequest 到 /api/agentd/v1/llm-proxy）：agentd 不持有 LLM API key、不直连模型供应商，所有模型流量经 Web 中继。所以即便走路径 B，模型成本、路由、审计仍在 Web 侧。

CodeAct 作为工具 codeact 注册，被 Agent loop 当作一个工具调用。它内部又跑一个子循环：LLM 产 markdown 代码块（bash/js/python），executeCodeBlock 在沙箱执行（30 秒超时），观察回灌，直到 end_task 标记或 MaxTurns（默认 10）。失败时注入 generateDiagnosticHint 诊断提示。上下文压缩保留 system 加摘要加最近 10 条；saveTaskState 识别关键决策点（失败重试、文件改动、git commit）；generateCompactionSummary 显式要求保留"用户改需求节点"、"技术方案选择"、"失败换策略转折点"。子 Agent 是 goroutine runner，父 agent 调 subagent 工具后并行 spawn 子 agent，各自跑独立 loop，通过 subagent_result 回传摘要。

边界结论：agentd 的"执行端"边界是所有文件/exec/网络/git/浏览器动作必须在 agentd 沙箱内发生；LLM 推理与编排（model routing、prompt 模板、IM 适配、durable workflow）在 Web。两条路径区别在于循环主体放在哪一侧：路径 A 循环在 Web，agentd 是无状态工具 RPC 服务；路径 B 循环在 agentd（为长任务、子 agent、CodeAct 等场景），但 LLM 调用仍回 Web 代理——成本与策略不分散。

---

## 四、CLI 架构（终端编码 Agent）

CLI 是平台面向开发者本机终端场景的入口。它是 pi 框架的瘦客户端 fork，把原本"胖客户端"的 pi 改造成"所有 LLM 流量经 Web、所有会话持久化在 Web、本地仅保留 TUI 外壳与本机工具执行"的形态。本节详述其 monorepo 组织、pi 关系、命令、登录、瘦客户端边界、本地工具、TUI 与非交互模式、session 格式、打包分发。

### 4.1 monorepo 组织

cli/package.json 自称 agentboster-cli-monorepo，私有，用 Yarn Classic（packageManager yarn@1.22.22），workspaces 为 packages/*。运行环境 Node 不低于 22.19。全仓 ESM。顶层 scripts 含 clean（转发子包）、build（依次 tsgo 编译，顺序为 ai 到 agent 到 agentboster-adapter 到 coding-agent，最后 chmod 加 copy-assets）、bundle（node scripts/bundle.mjs 产出单文件 CJS）、package（产出 tarball）、check（biome check 加 tsgo --noEmit，注意会写盘且 warning 即失败）、prepare（husky）。

关键 dev 依赖各有角色。`@anthropic-ai/sandbox-runtime` 是 Anthropic 沙箱运行时类型，被引用作为开发期类型来源（实际沙箱执行在 agentd，CLI 本机不使用）。`@biomejs/biome` 2.3.5 是唯一 formatter/linter。`@typescript/native-preview` 提供原生 TypeScript 预览编译器 tsgo，被 build 与 check 调用。esbuild 用于把整个 workspace 打成单文件 CJS。jiti 用于运行时按需加载用户扩展或技能 JS/TS 文件。shx 是跨平台 shell 工具。tsx 用于开发期直接跑 TS 源。husky 是 Git 钩子。

子包实测四个（非 README 提到的五个，tui 通过 npm 别名引入）。`@agentboster-cli/ai` 是 LLM 类型面加事件流加 compat 兼容层，故意剔除所有 provider SDK。`@agentboster-cli/agent` 是 Agent 循环原语（agent-loop.ts/agent.ts/proxy.ts），是 pi-agent-core 的瘦身 fork。`@agentboster/adapter`（私有）把 pi 的 StreamFn 契约适配到 Web 后端：auth、models、stream、preferences、security。`@agentboster-cli/core` 是 agentboster 二进制本体：TUI、登录、session、本地工具执行、模式分发。依赖方向是 coding-agent 到 adapter/agent/ai/tui，adapter 到 agent/ai，agent 到 ai，形成自下而上的层次，与 build 顺序一致。tui 的引入方式是 npm 别名：`@agentboster-cli/tui` 在源码里被 import，实际解析为 pi 的 pi-tui。

### 4.2 与 pi 框架的关系

pi 是 earendil-works 的开放终端编码 agent 框架，本身由四个 npm 包组成（pi-coding-agent、pi-agent-core、pi-ai、pi-tui）。原 pi 设计为胖客户端：本地持有 provider SDK、本地 OAuth/API key、本地执行所有工具。

本仓库是 pi 的 thin-client fork。packages/ai 自我描述为 pi-ai 的 thin-client fork，仅保留类型面加 event-stream 加 models stub，provider 实现、auth、OAuth、image API、legacy compat dispatch hub 都被删除——所有 LLM 流量经 /api/cli/chat 路由。packages/agent 自我描述为 pi-agent-core 的 thin-client fork，仅保留 agent.ts、agent-loop.ts、proxy.ts、types.ts、uuid.ts，harness/compaction/session/skills 都被移除。packages/coding-agent 直接继承 pi-coding-agent 的源码结构，但 package.json 的 piConfig 把名字与配置目录改写为 agentboster 与 .agentboster，所以 APP_NAME 是 agentboster、CONFIG_DIR_NAME 是 .agentboster。packages/agentboster-adapter 是 AgentBoster 在 pi 之上新增的唯一一层——它的存在就是为了替换 pi 原本的本地 provider 调用，自述 adapts pi-coding-agent's StreamFn contract to the Agentboster web backend。

CLI 在 pi 之上加了一整套 adapter 模块（auth 存储、远程模型获取、SSE 到 pi 事件流转换、用户偏好同步、本地命令安全评估）；替换登录（pi 的 OAuth/API-key 流被 agentboster login 替代）；在 main.ts 里加 handleLocalToolRequest 与 postToolResult（pi 原本在本地工具注册表里执行工具，这里改成接收 Web 工作流的 local-tool-request SSE、本地执行后回 POST 结果）；加 SessionManager.fromRemote（从 Web UIMessage 数组重建本地 session）；并瘦身（--provider/--api-key 被删除，forkFrom 被强制抛错）。

### 4.3 命令分派

进程入口 packages/coding-agent/src/cli.ts 设置进程标题、PI_CODING_AGENT 环境变量，屏蔽警告，配置 undici 全局 dispatcher，然后调 main。RPC 入口 rpc-entry.ts 同样入口但调 main 时带 `["--mode", "rpc", ...]`，作为 ./rpc-entry 子导出，用于编辑器集成或 headless 自动化的 JSON-RPC 控制。

main 函数是主调度。流程是：解析 offline/proxy/dispatcher；handleLoginCommand（若 args[0] 是 login 则执行登录后退出）；handlePackageCommand/handleConfigCommand（agentboster update 等）；登录强制门（getStoredAuth 为空就报"未登录"并退出 1，所有主要模式都受此门控）；parseArgs 加清理旧 tmp session（cleanStaleTempSessions 删除上次崩溃残留）；--version/--export 短路退出；决定 appMode（resolveAppMode：rpc 优先，其次 json，再次 --print 或 stdin/stdout 非 TTY 则 print，否则 interactive）；创建 SessionManager（处理 --session/--resume/--continue/--session-id/--no-session）；构建 createRuntime 工厂（含 injectRemoteModels、buildSessionOptions、模型 catalog 校验、createAgentSessionFromServices、装配 streamFnOverride）；三模式分发（runRpcMode、InteractiveMode.run、runPrintMode）。

命令清单：agentboster login 与 Web 配对、写 config、退出；agentboster（无参或带 prompt 或 @file）进入交互 TUI；agentboster -p 或 --print 非交互，处理 prompt、把最终文本写 stdout、退出；agentboster --mode json 同 print 路径但以 JSONL 事件流输出；agentboster --mode rpc（或经 rpc-entry）JSON-RPC 模式；agentboster --continue/-c 拉取 Web 上当前 channel 最近 session 续聊；agentboster --resume/-r 列 Web sessions 选择器，选中后 fetchRemoteMessages 重建；agentboster --session 用指定 session id 加载远程消息；agentboster --session-id 用精确 id，不存在则新建；agentboster --fork 在瘦客户端模式下被禁用（强制抛错）；agentboster --no-session 内存 session 不落盘；agentboster --list-models 打印 Web 模型 catalog；agentboster --export 把 session 导出 HTML；agentboster --yolo 跳过 local_* 工具的安全评分与确认；agentboster --approve/-a 与 --no-approve/-na 控制是否信任项目内本地资源；agentboster --model 指定模型，不在 Web catalog 则快速失败；agentboster --thinking 指定级别（off/minimal/low/medium/high/xhigh）。

### 4.4 login 配对机制

handleLoginCommand 仅匹配 args[0] 是 login，其余参数交给 parseLoginArgs。runLogin 支持三条路径：--pair-code（或 --code）调 exchangePairCode 到 POST /api/auth/pair-exchange，body 含 pairCode 与 label，返回 token 与 username（配对码由 Web UI 在 /config/devices 一次性签发）；--username 加 --password 调 loginWithPassword 到 POST /api/auth/login，返回 token 与 user；交互式提示选 1（用户名密码）或 2（配对码）。默认设备标签 defaultClientLabel 生成 `agentboster-cli@<hostname>`，--label 可覆盖。runLogin 末尾把 config（url、token、username）writeStoredConfig 到 $AGENTBOSTER_HOME/config.json（默认 ~/.agentboster/config.json，AGENTBOSTER_HOME 环境变量可整体改写家目录）。

服务端吊销如何被 CLI 感知是关键设计。CLI 不在本地缓存校验 token 有效性：getStoredAuth 仅检查 url 与 token 字段非空，不解析 JWT、不查 jti。吊销的感知发生在每次 API 调用：所有发往 Web 的请求都把 token 同时放在 authorization: Bearer 与 cookie: clawless-auth（双携带）；Web 侧 withCliAuth 每次校验 token，若已被吊销则 401 或 403，CLI 侧表现为 getStoredAuth 仍非空但请求失败，用户需 agentboster login 重配。clearStoredAuth 只是把本地 token 字段抹掉（url 保留），供 /logout 类斜杠命令调用。

### 4.5 瘦客户端边界（核心）

LLM 调用全部经 Web 是整个设计的中心。injectRemoteModels 的注释直白：未登录时是 no-op（回落 pi 的本地 provider registry），登录状态下不存在本地 provider registry 通路。resolveStreamFnOverride 在 getStoredAuth 为空时返回 undefined（pi 回落本地 SDK），已登录时始终返回 createAgentbosterStreamFn，覆盖 Agent.streamFn——登录后 pi 自带的 stream 路径根本走不到。

createAgentbosterStreamFn 返回一个满足 pi StreamFn 契约的函数，其文档明确：忽略 pi 的 model 参数（Web 从 session 状态自选）、忽略 pi 的 context.tools（Web 拥有工具执行）、只转发最新一条 user 文本。openAgentbosterStream 到 driveStream：CLI 发 POST /api/cli/chat，headers 含 content-type、authorization、cookie，body 含 id（sessionId）、trigger（submit-message 或 regenerate-message）、input（parts 加 text）、clientId、label、model。lastUserText 从 context 反向找最后一条 role=user 的消息只取其文本——历史不上行，因为服务端自己持有完整对话。

Web 返回标准 Vercel AI SDK UI message stream 协议（SSE），chunk 类型涵盖 text-start/text-delta/text-end、reasoning-start/delta/end、tool-input-start/delta/end、tool-result（被吞掉，注释说明服务端工具执行结果已被服务端吸收进对话历史、无需 emit）、data-workflow（用于 local-tool-request、subagent-event、subagent-batch-event、token-usage）、error、finish、done。关键的 trick 是 mapFinishReason：Web 给出的 finishReason 为 tool-calls 被 CLI 映射为 stop。注释解释：工具在 Web 端执行，CLI 的 pi-agent loop 没有这些工具名，若回报 toolUse 会让 loop 尝试本地分派并报"Tool <name> not found"。映射成 stop 让 loop 干净结束本轮，Web 的 SSE 继续把后续轮的 assistant message 推下来。

会话持久化方面，真相是 ~/.agentboster/agent/sessions/ 在 README 被描述为本地 session 存放处，但实际 SessionManager 构造函数把 sessionDir 默认设为 OS tmpdir（join(tmpdir(), "agentboster-sessions")），构造函数注释明确：session 文件去 OS tmpdir 而非 ~/.agentboster/，是临时工作副本——Web 后端拥有持久状态。文件命名是 ISO 时间戳加 sessionId 的 jsonl。退出即清由 registerTempSessionCleanup 在 process.on exit/SIGINT/SIGTERM 中 unlinkSync 所有已注册文件，SIGINT/SIGTERM 还带相应 exit code（130/143）退出。崩溃残留清理 cleanStaleTempSessions 在 main 启动期调用，扫描 tmpdir/agentboster-sessions/ 中以 agentboster-session- 开头的文件全部删除。

--resume/--continue/--session 的远程重建：对这三种 flag 都走 loadRemoteSessionOrExit，调 fetchRemoteMessages 到 GET /api/cli/sessions/[id]/messages，返回 session 与 messages。然后 SessionManager.fromRemote 逐条把 UIMessage 转 SessionMessageEntry：user.parts 抽文本，assistant.parts 抽 text 加 dynamic-tool（把 toolCallId/toolName/input 转成 toolCall 块，让 TUI 能渲染历史工具调用），版本元数据被原样挂到 entry.remoteMetadata。

模型与工具编排归属：选择模型（每轮）归 Web（从 session 状态或用户偏好）；工具注册表归 Web（workflow runtime）；服务端工具执行归 Web workflow 加 agentd；local_* 工具执行归 CLI 本机；工具调用参数解析由 CLI 从 SSE 流重建 arguments；系统提示词组装 pi 本地仍参与但 prompt 通过 input 提交给 Web。一个细节是 buildSessionOptions 在 CLI 侧仍解析 --model/--thinking，但这只是让 TUI 显示"当前模型"并做 catalog 校验；最终发到 Web 的 model 字段只是建议，Web 可采用亦可忽略。

压缩的协作：CLI 包装 session.compact，本地先调 pi 原生压缩逻辑（因 LLM context window 镜像在本地），压缩完再 POST /api/cli/sessions/[id]/compact（body 含 summary 与 firstKeptUiMessageId），让 Web DB 同步。这样两端上下文一致。

### 4.6 local_* 工具

触发链是：Web workflow 在需要本机执行时，通过 SSE 推 data-workflow chunk，其 data.type 是 local-tool-request；handleChunk 把它转交 options.onLocalToolRequest（含 runId、toolCallId、toolName、toolInput）；runId 来自 HTTP 响应头 x-workflow-run-id；回调最终绑定到 handleLocalToolRequest。

支持的工具含 local_read_file（fs.readFile utf8）、local_write_file（递归 mkdir 加 fs.writeFile utf8）、local_exec（spawn 用 $SHELL 或 /bin/sh，cwd、env 用 process.env，stdout/stderr 各 100KB 截断，exit code 非 0 返回 ok:false）、local_ask_question（TTY 交互问答，支持单选/多选/自由文本，无 TTY 时拒绝）。未知工具名返回 ok:false 加 Unknown local tool。执行结果通过 postToolResult 到 POST /api/ai/[runId]/tool-result，body 含 toolCallId、ok、output、error，Bearer 加 cookie 双携带。Web 工作流的 localToolResultHookBuilder 会阻塞等待此结果。

安全边界与 --yolo 由 evaluateLocalCommand 实现两层（L1 是占位，需 AGENTBOSTER_SCORER_URL 才生效）。L0 block 模式覆盖 rm -rf /、mkfs、dd、/etc/shadow、chmod 777，命中即 ok:false。L0 escalate 模式覆盖 git reset --hard、curl/wget/nc/nmap、npm/pip/apt/yum/brew install，命中则 ok:true、autoApprove:false（进 L2）。其他 ok:true、autoApprove:true。handleLocalToolRequest 的门控：local_ask_question 直接跳过门控；--yolo 走 ok:true、autoApprove:true 全自动；L0 block 立即 POST ok:false 加 Security blocked；L2 需确认时若 process.stdin.isTTY 不为 true（headless 或 -p 模式）拒绝而非放行，有 TTY 则 readline 问 y/N，非 y 即拒绝。

为何必须在 CLI 本机执行：local_* 的语义就是"用户机器上的 shell/文件"。Web 后端运行在 Vercel 或容器里，无法访问用户的 $HOME、git 仓库、本地工具链。local_exec 用 process.env.SHELL 与 process.env——这些只在用户机器上有意义。Web workflow 编排时显式选择 local_* 来"借用"用户机器。

与 agentd 工具的对比：需要 Docker/LXC/browser 沙箱、长任务的服务端工具由 Web 派发到 agentd 节点，在那里走 agentd 的三层安全。--yolo 只对发回到 CLI 的 local_* 生效（仅作用于 handleLocalToolRequest）；经 Web 派发到 agentd 的工具仍按 agentd 自己的安全策略评估，CLI 完全不参与。

### 4.7 TUI 与 --print 模式

TUI 渲染层完全来自 pi-tui（经 npm 别名 import），提供 TUI、Container、Markdown、OverlayOptions、Keybinding、EditorComponent、ProcessTerminal 等原语。InteractiveMode 类负责装配 Footer、组件树（assistant-message、user-message、bash-execution、tool-execution、tree-selector、model-selector、session-selector 等 30 多个组件）、斜杠命令、剪贴板、键位管理器。流式渲染上，AssistantMessageComponent 订阅 AgentSession 事件，事件流由 agent-loop 通过 EventStream 推送，最终由 web-stream 把 SSE chunk 转成 pi 的 AssistantMessageEvent（text_delta/thinking_delta/toolcall_delta/done 等）。

编辑与 regenerate 的统一机制很优雅。AgentSession 持有 _pendingRegenerateIntent，setPendingRegenerateIntent 一次性设置，consumeRegenerateIntent 一次性消费。main 把 consumeRegenerateIntent 透传给 createAgentbosterStreamFn，进而到 driveStream：若存在 pending intent，则 POST 时 trigger 从 submit-message 改为 regenerate-message，并附带 messageId 与 metadata。Web 侧 chatMain 收到 regenerate-message 后执行 deleteMessagesAfterUiMessageId 截断下游消息并重跑——CLI 不需要新接口。consumeRegenerateIntent 也注入到扩展的 RPC 上下文，让扩展可以触发。版本模型上，SessionMessageEntry.remoteMetadata.versions 数组加 currentVersionIndex。Web 与 CLI 用同一套字段。在 TUI 树选择器中按左中括号或右中括号在两个以上版本间循环，会 PATCH /api/cli/messages/[id]/metadata。

--print 非交互模式 runPrintMode 注册 SIGTERM/SIGHUP（非 Windows）清理钩子；subscribe 事件，json 模式每事件写一行 JSON.stringify，text 模式不订阅；发送 initialMessage 与所有 messages；text 模式取最后一条 assistant 消息，若 stopReason 是 error 或 aborted 则 exitCode 为 1 并 console.error，否则把所有 text content 输出到 stdout；写穿用 writeRawStdout/flushRawStdout 绕开 TUI 接管。典型 CI 用法是 agentboster -p "fix the failing test" 退出码即成败信号，或 agentboster --mode json 喂给下游解析器。

### 4.8 session 文件格式与版本

文件是 jsonl（每行一个 JSON）。首行是 SessionHeader（type session、version 3、id、timestamp、cwd、可选 parentSession）。CURRENT_SESSION_VERSION 是 3，v1 文件没有 version 字段，通过 migrateToCurrentVersion 升级。后续行是 SessionEntry（type message/thinking_level_change/model_change/compaction/branch_summary/custom/custom_message/label/session_info）。message 类型含 message: AgentMessage 加可选 remoteMetadata（versions/currentVersionIndex，仅由 fromRemote 注入）。buildSessionContext 把 message 加 custom_message 折成 LLM context；custom/label 等不进 LLM 上下文。

版本字段的意义：versions[i] 含 parts（该版本的 user 输入）、createdAt、可选 response（配对的 assistant 回复快照，编辑历史场景下旧版本被替换前先把它的回复快照进来）。currentVersionIndex 指向当前生效版本。fromRemote 时优先用 versions[idx].parts 而非 msg.parts。

调试变量含 AGENTBOSTER_SESSION_ID（覆盖 SessionManager 的 id，使本地 jsonl 与 Web DB 行强关联，调试或重放）、AGENTBOSTER_CLIENT_ID（覆盖 createAgentbosterStreamFn 的 clientId 字段，默认 local-cli，Web 用它区分多个并发客户端）、AGENTBOSTER_HOME（整个家目录）、AGENTBOSTER_CODING_AGENT_DIR（agent 配置目录）、AGENTBOSTER_CODING_AGENT_SESSION_DIR（session 目录）、PI_PACKAGE_DIR（资产根，适配 Nix/Guix）、PI_OFFLINE（跳过启动期网络操作）、AGENTBOSTER_MODEL（默认模型 override）。

### 4.9 打包与分发

bundle 用 esbuild 单文件。入口是 packages/coding-agent/src/cli.ts，产物 packages/coding-agent/dist/agentboster.cjs。选项 platform node、format cjs、target node22、bundle true、keepNames true、sourcemap false、minify false。CJS 的 import.meta.url shim 在 banner 注入一个常量，define 把 import.meta.url 重写到该常量（因 config.ts 用 fileURLToPath(import.meta.url)，CJS bundle 里 import.meta.url 是 undefined 会抛错）。loader 把 .json/.html/.css/.base64 内联为 text/json 模块，使 import templateHtml from "./template.html" 被打包吸收。vendored JS 作为 text 的自定义插件把 template.js/marked.min.js/highlight.min.js 当字符串读入（这些字符串在生成导出 HTML 时被注入，不应污染 bundle 作用域）。external 含 node:* 内建、原生 addon（node-pty/zlib-sync/sharp/canvas/fsevents）、playwright、iconv-lite、bun 等，保留到运行时从 node_modules 解析。

package 产出 tarball。输入 packages/coding-agent/dist/agentboster.cjs，读取其 package.json 的 version，产出目录 agentboster-cli-<version>，含 agentboster.cjs（从 dist 拷贝，chmod 0755）与 agentboster（shell wrapper，内容是 #!/bin/sh 加 exec node "$(dirname "$0")/agentboster.cjs" "$@"，exec 让信号直达 Node 进程）。用 GNU tar 打包，--owner=0 --group=0 --mtime=@0 --format=ustar 实现可复现字节级一致的 tarball。输出 agentboster-cli-<version>.tar.gz，打印安装指引。目标机仅需 Node.js 不低于 22 在 PATH。补充：build 脚本含 copy-assets，把 theme/*.json、assets/*.png、export-html/template.{html,css,js} 与 vendor/*.js 拷到 dist——bundle 之所以能 inline 它们，前提是 npm run build 已先跑过。没有独立平台包：agentboster.cjs 是纯 JS，运行时依赖只有 Node 与（可选的）原生 addon，所以单 tarball 跨平台。

---

## 五、横切关注点

本节讨论贯穿三层的关注点：鉴权与契约、可观测性、定时任务、国际化、错误处理与降级。

### 5.1 鉴权体系

平台有四套并行的鉴权机制，每套对应一条信任边界。

浏览器与 Web 之间用自签 HMAC token（无 JWT 第三方库）。createAuthToken 生成 base64url(payload).base64url(hmac)，payload 含 userId、username、issuedAt、expiresAt、可选 jti；verifyAuthToken 同步校验签名加过期。AUTH_TTL_SECONDS 控制有效期。token 存 cookie clawless-auth 或 Authorization Bearer。

CLI 与 Web 之间复用同一 token 格式，但通过设备配对颁发。CLI agentboster login --pair-code 调 /api/auth/pair-generate 生成短期 pair-code（由 Web UI 在 /config/devices 一次性签发），再用 /api/auth/pair-exchange 换 token，写 cli_devices 表（tokenJti 唯一）。/api/auth/pair-revoke 吊销。withCliAuth 每次请求查 cli_devices.revokedAt 验活——吊销是实时的，不依赖本地缓存。CLI 请求双携带 token（Authorization Bearer 加 cookie clawless-auth）。

agentd 与 Web 之间用共享 API Key 加可选 mTLS。AGENTD_API_KEY 作 X-API-Key 或 Authorization Bearer，middleware 用 subtle.ConstantTimeCompare 防时序侧信道。Web 主动访问 agentd 时叠 mTLS 客户端证书（AGENTD_CLIENT_CERT_PATH/KEY_PATH/CA_PATH），agentd 侧校验 Web 客户端证书。clawless_api_key 为空时 agentd 直接拒绝所有请求。Vercel 部署下 Web 只用公网证书，agentd 出站方向不能设 client_cert_path/ca_path——NewClientFromConfig 用 x509.SystemCertPool 然后 AppendCertsFromPEM 来"增强"而非"替换"系统根，但若用户强行配了自定义 CA，公网证书仍可能误判。

Bot webhook 用 URL 段 authSecret。/api/bot/[authSecret]/[adapter]/callback 的 authSecret 与 AUTH_SECRET 常量时间比较。maxDuration 300 秒。IM 用户配对用 isImUserAuthorized，未授权且非 /pair、/start、6 位 pair-code 就拒绝；已授权清拒绝标记。

密码与初始用户：validateCredentials 用 bcrypt（bcryptjs）；seedInitialUser 在 0 用户时按 USERNAME/PASSWORD env 初始化。requireAuthAccess 是 route handler 鉴权快捷方法，返回 session 与 isAdmin。

### 5.2 三层契约清单

CLI 到 Web 的契约含：POST /api/auth/login（用户名密码登录）、POST /api/auth/pair-exchange（配对码换 token）、POST /api/cli/chat（发起对话，SSE 流回）、POST /api/ai/[runId]/tool-result（回传 local_* 结果）、GET /api/cli/models（拉模型 catalog）、GET /api/cli/preferences（用户偏好）、PATCH /api/cli/preferences（改偏好，Web/IM 同步）、GET /api/cli/sessions（session 列表）、GET /api/cli/sessions/[id]（单 session 元数据）、PATCH /api/cli/sessions/[id]（改标题/模型）、DELETE /api/cli/sessions/[id]（删 session）、GET /api/cli/sessions/[id]/messages（拉消息供 resume）、POST /api/cli/sessions/[id]/compact（回传压缩结果）、PATCH /api/cli/messages/[id]/metadata（切换版本）。

agentd 到 Web 的契约（作为客户端 POST）含：注册 nodes/register、心跳 nodes/heartbeat、工具活动日志 tool-activity-logs、审查日志 review-logs、L1 打分 l1-score/l1-score-batch/l1-health、LLM 代理 llm-proxy、L2 通知 notifications/send/notifications/notifications/recall、任务回调、记忆、知识库、工作区、blob 上传、SOUL、能力查询。

Web 到 agentd 的契约（Pattern B，mTLS 加 API Key）含：POST /tasks（下发任务）、GET/PUT /tasks/:id、会话相关 GET/PUT/DELETE /sessions/:id、POST /sessions/:id/abort、POST /review-logs、记忆 CRUD、GET /agent-config/:id、GET /l0-rules/:id、POST /sandboxes、POST /llm-proxy、POST /l2-confirm（回传 L2 决策）、POST /tools/exec（同步单工具）、POST /tools/exec/stream（SSE 流式）、各语义化工具端点。

### 5.3 可观测性

agent_tool_activity_logs 是工具执行的权威审计，每次工具调用详细记录（taskId、sessionId、agentId、userId、roles、source、sandboxId、model、step、toolCallId、toolName、action、target、arguments、result、outputText、success、error、durationMs、startedAt、completedAt），四条索引。由 withToolExecutionLogger（workflow 工具包装）与 daemon 回调写入。agent_review_logs 记 L0/L1/L2 安全决策审计（taskId、roles、command、level、score、decision、reason）。vault_audit_logs 记凭证库读写审计。

节点监控由 agentd 每 10 秒采样 metrics（cpu_model、cpu_usage、mem_avail、disk_avail、每 agent 沙箱数、cgroup_stats），心跳上报 Web，Web 经 /api/config/monitoring/{nodes,metrics} 暴露给配置页 UI。agentd 自身 GET /metrics 与 GET /health 是公开端点（无鉴权）。

日志规范统一用 lib/utils/logger.ts 的 createLogger('namespace')，AGENTS.md 强调禁 console.log（webhook 等历史代码有遗留）。agentd 用自定义 slog 处理器，格式含 module、func:line、level、message、key=value。next.config.ts 生产环境移除 console（仅保留 error/warn）。

### 5.4 定时任务

两套定时任务机制并存。lib/extra/cron 是通用框架：TaskScheduler 基于 cron 包的 CronJob，DynamicPoller 是动态 worker pool（2 到 8 worker，setInterval 轮询 DB 任务）。lib/workflow/scheduled/dispatch 的 deliverScheduledTask 在定时器到期时调用，sameInstant 幂等保护（防同一触发时刻重复派发），最终 chatMain 带 trigger route-message 与 source scheduled 复用完整 chat 路由栈。派发后回写 lastTriggeredAt/lastFiredFor/lastChatRunId，delay 类型派发后置 active 为 false，daily 类型保留并更新 nextRunAt。scheduled_tasks 表含 type（delay/daily）、timezone、dailyTime、nextRunAt、lastFiredFor（幂等键）、scheduleWorkflowRunId、lastChatRunId、active。

agentd 侧重也有周期任务：task_summary tidy_tick 周期默认 168 小时（一周）触发 RunTaskTidy 整理任务摘要。

### 5.5 国际化

lib/i18n/locales 含多语言包。lib/chat/user-locale 解析 locale 链：会话级到用户级到全局到 auto。buildSystemPrompt 按 locale 注入 follow-up 建议。agentd 用 go-i18n 做 L2 通知文案本地化。Web 与 IM 渠道共享同一 locale 解析，确保跨端体验一致。

### 5.6 错误处理与降级

多层降级是平台的韧性设计。多节点调度 selectBestNode 返回 null 时，工具执行自动回退到 Vercel Sandbox（backend 标识 vercel-fallback），开发者无感。L1 打分失败时，fail_open 为 false（默认）则 blocked，fail_open 为 true 则当作 medium 放行；但 L1 不可用时 Score 直接返回 0.8 high 强制走 L2，不存在"被自动放行的高危"。MCP 远程 server 加载失败用 Promise.allSettled 容忍。IM 消息处理有相似度去重（checkDuplicate）避免重复会话。Workflow 沙箱内的副作用失败靠 'use step' 的重试与 DevKit 的可恢复机制兜底。agentd 沙箱 HealthChecker 连续失败至少 2 次才 reap（避免 docker daemon 抖动误杀）。

---

## 六、部署拓扑

平台支持多种部署拓扑，核心区别在于 agentd 节点的网络可达性。

### 6.1 最小部署：纯 Web

最简单的部署只有 Web，部署到 Vercel（或自托管 Next.js）。配置 AUTH_SECRET、USERNAME、PASSWORD、DATABASE_URL（如 Neon）、BLOB_ACCESS。工具执行回退到 Vercel Sandbox（@vercel/sandbox），不依赖 agentd。IM 渠道可选配置（Telegram/Discord/Slack/飞书/Teams）。CLI 可配对使用，local_* 工具在 CLI 本机执行，服务端工具走 Vercel Sandbox。这种拓扑适合个人或小团队，无需运维 Linux 主机。

### 6.2 Pattern A：纯出站 agentd

agentd 部署在 NAT 后的 Linux 主机（如家庭服务器、办公内网、云主机无公网）。agentd 仅靠心跳存在——它主动 POST 给 Web 注册与心跳，Web 知道节点在线但无法主动推工具 RPC。这条路径上，工具执行只能走路径 B（agentd 自跑 Agent Loop，LLM 经 Web llm-proxy 代理）或轮询回调，能力受限。优点是 agentd 无需公网暴露，部署门槛低；缺点是同步工具 RPC 不可用，延迟与体验略差。

### 6.3 Pattern B：入站工具 agentd

通过 frp、反代或公网 IP 让 Web 能直接 mTLS 调用 agentd。agentd 配置入站 mTLS（server.tls_cert_path/tls_key_path/ca_path），Web 配置出站 mTLS（AGENTD_CLIENT_CERT_PATH/KEY_PATH/CA_PATH）。这条路径支持路径 A（Web 下发单步工具调用，同步返回），工具执行延迟低、体验好。适合 agentd 能暴露公网或经隧道可达的场景。注意 Vercel 部署下 Web 出站方向不能设自定义 CA，否则覆盖系统根 CA 破坏 Let's Encrypt 校验。

### 6.4 多节点部署

多个 agentd 节点注册到同一 Web 后端。selectBestNode 按资源打分（CPU 空闲、内存空闲、磁盘空闲、activeLoad）选最优节点；allowedNodes 支持 per-agent 白名单（限制某 agent 只在某子集节点执行）。节点失联（lastHeartbeat 超过 2 分钟）自动标 offline 不再派任务。节点全不可达时回退 Vercel Sandbox。这种拓扑适合团队或企业，工具执行可水平扩缩，单节点宕机不影响整体可用性。

### 6.5 IM 多渠道部署

Web 配置 channels.{telegram,discord,slack,teams}.enabled，动态 import 对应 @chat-adapter 适配器；飞书与 QQ 在 lib/extra/channels 自实现。状态存 Upstash Redis（@chat-adapter/state-redis）。入站 webhook 走 /api/bot/[authSecret]/[adapter]/callback，maxDuration 300 秒。出站统一通知由 ChannelManager 加 NotificationManager 按 notification_preferences 投递，失败转 fallback。IM 用户配对用 /pair 命令加 6 位 pair-code 绑定到 clawless user。

### 6.6 环境变量与配置

Web 环境变量含 AUTH_SECRET/USERNAME/PASSWORD（登录与 Cookie）、DATABASE_URL（生产必填）、BLOB_ACCESS/BLOB_READ_WRITE_TOKEN（附件存储）、AGENTD_API_KEY（与 daemon clawless_api_key 一致，支持逗号分隔多个值用于多 daemon 或密钥轮换）、AGENTD_CLIENT_CERT_PATH 等（仅 Web 主动访问 daemon 时需要）、TAVILY_API_KEY（可选联网搜索）。CLI 端无需 env 变量，登录信息写 ~/.agentboster/config.json。调试可设 AGENTBOSTER_SESSION_ID、AGENTBOSTER_CLIENT_ID。agentd 端配置走 agentd.toml 加 AGENTD_ env 覆盖。

postbuild 行为是关键的部署细节：只在 VERCEL=1 且 VERCEL_ENV=production 时执行 ensure-vector-extension 到 drizzle-kit push 到 migrate-message-versions；本地 build 不动数据库。这意味着首次部署到 Vercel 生产会自动建表与迁移，但开发环境需手动 yarn db:push。

---

## 七、关键数据流

本节用文字描述几条端到端的关键数据流，串联三层。

### 7.1 浏览器聊天流

用户在浏览器输入消息。前端 useChat 经自定义 transport POST /api/ai，body 含 id、trigger submit-message、input。middleware 校验 cookie clawless-auth，注入 x-user-id。route handler 调 chatMain：normalizeSource 归一为 web source；parseChatInputEnvelope 区分命令或消息；消息走 ensureMessageSession 取或建 session；upsertUserMessage 写库；若无可恢复 workflowRunId 则 getConfig 解析有效模型、buildInitialContextMessages 注入 SOUL/AGENTS/RAG、startWorkflow 启动新 run，返回 runId 与 readable。chatWorkflow（带 'use workflow'）在 DevKit 沙箱内跑：resolve-model（'use step' 在主机解析 provider）、buildSystemPrompt 组装系统提示、buildAgentTools 注册工具、DurableAgent.stream 跑工具循环。每步 onStepFinish 调 persistStepDeltaAndUsageStep（'use step' 写 messages 表）。工具调用经 L0/L1/L2 安全流：若需在 agentd 执行，execToolOnAgentd（'use step'）selectBestNode 后 POST agentd 的 /tools/exec（mTLS）；若需在 CLI 本机执行，发 local-tool-request SSE；若可用 Vercel Sandbox 则直接执行。结果回灌 writable 流，dispatch 把 readable tee：主路回 HTTP SSE 给浏览器，旁路检测流结束触发 afterResponse 与 cleanupWorkflowResources。浏览器流式渲染 assistant 消息、工具调用、工具结果。

### 7.2 CLI 聊天流

开发者在终端运行 agentboster（带 prompt）。getStoredAuth 检查 config.json，未登录报错退出。parseArgs 解析参数。createSessionManager 建 SessionManager（sessionDir 在 OS tmpdir）。createRuntime 装配 createAgentbosterStreamFn（覆盖 Agent.streamFn）。InteractiveMode.run 启动 TUI。用户输入消息后，driveStream POST /api/cli/chat（Bearer 加 cookie 双携带），body 含 id、trigger submit-message、input、clientId、label、model。Web 走与浏览器相同的 chatMain 流程，区别仅在 source 类型 cli（channel 写 cli:<clientId>，触发 local_* 工具注册）。Web 返回 SSE 流，web-stream 把 chunk 转成 pi 事件：text-delta 渲染到 Markdown 组件、tool-input 渲染到 tool-execution 组件、tool-result 被吞掉（服务端执行）、data-workflow 的 local-tool-request 触发 handleLocalToolRequest。local_* 工具在 CLI 本机执行（fs 或 spawn），结果 POST /api/ai/[runId]/tool-result 回 Web，Web 工作流 localToolResultHookBuilder 阻塞等待后继续。工具调用 finishReason tool-calls 被 mapFinishReason 映射为 stop，让 pi-agent loop 干净结束本轮。退出时 registerTempSessionCleanup 清理 tmpdir session 文件。

### 7.3 IM 聊天流

用户在 Telegram（或其他 IM）发消息给 Bot。Telegram 推 webhook 到 /api/bot/[authSecret]/[adapter]/callback。middleware 放行，route handler 经 isValidBotSecret 校验 authSecret。getBot 经 Chat SDK 处理 webhook，handleIncomingMessage 构造 ChatSource（type im、adapter、threadId、userId、locale）。isImUserAuthorized 校验配对：未授权且非 /pair、/start、6 位 pair-code 就拒绝；已授权清拒绝标记。routeAdapterMessage 把 IM source 喂给 chatMain，后续与 Web 同栈。Web 启动 workflow run，工具执行经 L0/L1/L2。回复经 sender 的 bot-steps（'use step'）把结构化回复经 Chat.sendMessage 推回原 thread。完成通知由 NotificationManager 按 preferredChannel 投递。maxDuration 300 秒确保 IM 流不被 Vercel 函数超时杀掉。

### 7.4 L2 授权流

agentd 执行工具时，Gatekeeper.Audit 走 L0（规则黑名单）到 L1（LLM 打分）。L1 返回 high 或 critical 转 L2：requestL2Auth 先查本地 L2AuthManager.Check 缓存，未命中发布 EventL2AuthRequired，task 进入 pending_confirm。Dispatcher 的 handleL2AuthRequired 调 ClawLess.SendNotification 推 IM 决策卡（带 command_review、options、expiresAt now+3m）。同时 Web 侧 DecisionQueue 入队（写 l2_decisions 表，TTL 5 分钟）。用户在 IM 点按钮或 Web UI 操作，POST /api/agentd/v1/decisions/[id]/resolve。Web 按 decision.type 归一化 action，调 queue.resolve 或 deny，对 l2_auth 调 forwardL2Confirm 把结果 POST 给 agentd 的 /api/v1/l2-confirm。agentd 发布 l2.auth_approved 或 l2.auth_rejected 事件，Dispatcher 的 handleL2Auth 更新本地 L2 缓存（AuthorizeTask 或 RejectTask，duration once/always/hhddmmyy），pass 则重发 task.approved 继续流程，reject 则 task.rejected。超时看门狗每 5 秒扫描，sent 状态超 timeoutAt 转 timeout。这套设计确保 L2 决策跨 Web 重部署持久（l2_decisions 表），跨 agentd 重启可恢复（启动时 rehydrateFromDb）。

### 7.5 定时任务流

用户在 Web 或经 IM 命令创建定时任务（delay 类型如"10 分钟后提醒"，daily 类型如"每日 9 点"）。scheduled_tasks 表记录 type、timezone、dailyTime、nextRunAt、prompt、active。DynamicPoller 周期轮询到期任务，deliverScheduledTask 触发，sameInstant 幂等保护（防同一触发时刻重复派发，用 lastFiredFor 键）。chatMain 带 trigger route-message 与 source scheduled 复用完整 chat 路由栈（命令解析、去重、session、workflow）。派发后回写 lastTriggeredAt/lastFiredFor/lastChatRunId，delay 类型派发后置 active 为 false，daily 类型保留并更新 nextRunAt。任务结果经统一通知机制投递。

---

## 八、设计取舍与边界

本节讨论平台设计中的关键取舍与边界，以及未解决或演进中的问题。

### 8.1 为何硬分层

硬分层的核心收益是执行端可丢弃。Web 是唯一权威，agentd 与 CLI 都无本地权威状态，这意味着 agentd 节点可随时重启、扩缩、迁移，CLI 进程可随意杀掉重开，都不影响会话连续性。会话状态、模型编排、工具路由、Workflow 运行时、凭证、审计全在 Web，恢复时从 Web 重新拉取即可。代价是三层都要部署与运维，门槛比单二进制（如 manboster、picoclaw）高，且三层间的 HTTP 往返引入延迟。这种取舍适合需要规模化、多端协作、企业级审计的场景，不适合个人单机使用。

### 8.2 为何 Workflow DevKit

强异步的核心收益是可恢复。所有 LLM 调用、工具循环、子代理编排都落地为 durable step，每步 delta 持久化到 messages 表。任一执行端宕机，workflow 暂停，等下一次回调续跑，而非重头开始。这对长任务（如复杂编码、多步研究）至关重要。代价是 workflow 沙箱的限制（无 fetch、Buffer、__dirname、process、直连 DB）增加了开发复杂度，所有副作用必须显式标 'use step'。历史教训：曾用 next/server 的 after() 因沙箱无 __dirname 导致 ua-parser-js 崩，后改用自研 afterResponse 与流关闭钩子。这种取舍适合需要长任务韧性的场景，不适合纯请求-响应的简单 chat。

### 8.3 为何三层安全

强安全的核心收益是纵深防御。L0 规则黑名单快速确定性 deny 已知危险模式（成本极低，正则匹配）；L1 LLM 风险评分对未知命令做语义评估（成本中等，一次 LLM 调用）；L2 用户授权对高危操作人工 approve/deny（成本最高，人工干预）。任一层可独立否决，避免单点失效。CLI 的 --yolo 跳过三层仅对本机 local_* 工具生效，经 Web 派发到 agentd 的工具仍走完整流程。代价是安全链路对延迟与体验有影响（所以提供 --yolo 逃生阀），且 L1 依赖 LLM 可用性（不可用时强制走 L2 或 blocked，取决于 fail_open）。这种取舍适合不可信工具执行（如用户上传的代码、IM 触发的命令），不适合完全可信的 CI 场景。

### 8.4 LLM 成本与路由的集中

所有 LLM 流量经 Web 是关键设计。即使 agentd 自跑 Agent Loop（路径 B），LLM 调用仍经 /llm-proxy 回 Web 代理——agentd 不持有 LLM API key、不直连模型供应商。这确保模型成本、路由策略、审计统一在 Web 侧，不分散到 agentd 节点。Provider API key 经 vault 加密存储，配发时解密。resolveModelContextLimit 在 Web 一处解析后经 /api/cli/models 下发给 CLI 与 IM，避免三层各自维护一份上下文表。代价是 agentd 节点的 LLM 调用多一跳 HTTP（到 Web 再到 provider），延迟略增；但换来集中管控与审计。L1 打分也借此集中：`/api/agentd/v1/l1-score` 在 Web 侧用 KV 缓存 low/medium 结果（`lib/security/l1-cache.ts`），同一命令+上下文短期内复用，跨 serverless 实例命中，high/critical 永不缓存。

### 8.5 沙箱抽象的一致性

L0 命中后伪造 OS 错误（formatOSError）而非返回"被规则拦截"，让 LLM 误以为是 OS 层拒绝——这保持沙箱抽象完整，避免 LLM 学到"规则系统"的存在进而绕过。这是一个有意思的安全设计细节。类似地，三档沙箱（docker/docker-strict/lxc）的选择对 LLM 透明，SelectSandbox 按风险与持久化需求自动选档。

### 8.6 已解决的文档/契约不一致与剩余演进项

此前版本在此节列了若干"未解决"问题，现已逐条核实并修复，记录如下：

- **MULTI-NODE-SCHEDULING.md 悬空引用（已修复）**：该文件被 README.md、README.EN.md、subpackage/agentd/README.md 引用但仓库内从未存在，属于计划文档未提交。已将三处引用改指向真实代码位置——`lib/workflow/scheduled/dispatch.ts` 与 `app/api/agentd/v1/nodes/*`（含 `register`/`heartbeat`/`status` 三个端点），即多节点调度的实际落点。多节点调度的核心逻辑即在此，不再依赖外部计划文档。
- **local_ollama L1 provider（已决定不做）**：此前 config 校验在 `internal/config/config.go` 认 `web_callback` 与 `local_ollama` 两种取值，但全仓库（Go 与 TS）除此之外没有任何实现——既无 provider 适配，也无调用分支，是"声明了却未兑现"的死契约。已从 `Validate()` 的合法 case 中移除 `local_ollama`，如今 L1 provider 仅认 `web_callback`（以及历史别名 `web` → `web_callback`）。经评估后决定**不再补 local_ollama 实现**：web_callback 路径下 LLM 流量统一经 Web 代理（见 8.5），模型成本、路由、审计集中管控；若 agentd 本地直连 Ollama 则破坏这一原则（节点本地持有模型/key），若仍走 Web 代理则与 web_callback 重复。两头不讨好，故彻底放弃，配置层也不再保留取值。
- **resolveModelContextLimit 定义点（已核实，非问题）**：定义在 `lib/workflow/agent/utils/model-context.ts:48`，被同目录 `agent-config.ts` 与 `app/api/cli/models/route.ts` 经 `/api/cli/models` 下发给 CLI/IM。即在 Web 侧一处解析、一处下发，与 8.5 节正文（行 169、507）描述一致，本就不是悬案。
- **yarn publish 失效（已修复）**：`package.json` 的 `publish` 原为 `yarn run check && yarn run build && git push`，而 `check` 并未在 scripts 中定义（yarn 报 "Command check not found"），脚本整体不可执行。已将 `check` 改为已定义的 `lint:check`（即 `tsc --noEmit && biome check ...`），发版前质量门现在能真正跑通；AGENTS.md 中"publish 失效"的提示也已同步更正。

剩余仍处于演进中的问题（已核实，记于此供后续跟进）：

- **lib/extra/security 影子目录（已清除）**：此前版本说"该目录的 scorer/l1_scorer/l2_auth 子目录的具体 provider 适配未在本文档逐文件展开"，这次核实后发现整个判断方向错了——`lib/extra/security/` 是一套**从未被任何路由或模块引用的影子实现**（与 `lib/security/` 同名但完全不同的一套早期英文/裸机版本，prompt 甚至不知命令跑在沙箱里）。真正的 L0 在 agentd 的 Go 侧（`internal/security/l0_rules/`），真正的 L1 在 `lib/security/l1-scorer.ts`（被 `/api/agentd/v1/l1-score` 调用），真正的 L2 决策队列在 `lib/security/l2-decision-queue.ts`（DB 持久化，agentd 的 `internal/security/l2_auth/` 消费授权窗口）。影子目录已整体删除，`lib/extra/index.ts` 中对应 re-export 一并清理。取长补短只搬了一样有价值的东西（见下条 L1 缓存），其余要么生产侧已有更强实现，要么概念上不该放 Web 侧。
- **L1 打分无缓存（已补）**：生产侧 `/api/agentd/v1/l1-score` 每次都 `generateObject` 实打 LLM，而 agent 会话内同一安全命令（`git status`、`ls`、`cat` 等）反复打分是纯浪费。新增 `lib/security/l1-cache.ts`，以 KV（Upstash Redis）缓存 low/medium 结果，key 含 command+workDir+contextSummary+resolved modelId 的 sha256 截断（换模型自然失效），默认 TTL 5 分钟（经 `security.l1_cache_ttl_seconds` 可配，0 关闭，上限 1 小时），high/critical 永不缓存。跨 serverless 实例命中，KV 读写错误静默降级为 miss。`l1-score-batch` 不加缓存——其输入是 agentd 拼好的整段聚合 prompt，key 难定且收益低。
- **l2-confirm IM 回调链断裂（已修复）**：`app/api/agentd/v1/l2-confirm/route.ts` 此前只更新 task 状态并写一个 `l2:auth:{taskId}:{chatId}` KV，但**从不调用 `forwardL2Confirm()` 把结果转发回 agentd**，也**从不 `resolve()`/`deny()` Web 侧的 DecisionQueue 条目**。后果有三：(1) Web decision 停在 PENDING 直到 5 分钟超时；(2) agentd 的 agent loop 一直在等 `EventL2AuthApproved/Rejected`，最终自己 L2 超时失败；(3) 那个 KV 用 taskId 做 key（taskId 每次请求都不同），即便有人读也匹配不上后续请求，是纯写而忘。根因更深一层：**IM 的 pass_until/reject_until 路径从未真正生效**——agentd 的 pattern-based L2 缓存（`internal/security/l2_auth/manager.go` 的 `AuthorizeTask`）本就支持"未来同类自动放行"，但它要靠 `handleL2Auth` 消费 `EventL2AuthApproved` 来喂入，而那个事件只有 agentd 的 `/api/v1/l2-confirm` 端点会发，Web 的 l2-confirm 偏偏没转发过去。已修复：四个 action（pass_once/reject_once/pass_until/reject_until）现在都先 `resolve`/`deny` Web 侧 decision，再 `forwardL2Confirm` 转发给 agentd（带 `pattern=command`、`duration`），由 agentd 的 `handleL2Confirm` 发事件解除当前任务等待并写 pattern 缓存（这才是 pass_until 真正落地的位置）。那条无用的 `l2:auth:*` KV 已删除——它既没人读，key 维度也错，agentd 本地 pattern 缓存已覆盖该职责。10 个路由测试覆盖四个 action 的 forward 调用、resolve/deny 配对、dedup 与 decision 过期兜底。

项目处于 WIP 状态，1.0 前接口与 schema 仍可能变化，升级兼容性不作保证。

### 8.7 与外部项目对比下的定位

在同类项目中，AgentBoster 的独特性在于"硬分层权威中心加可丢弃执行端加 Workflow 沙箱加三层安全加多节点调度"的组合。memoh 走"每 agent 一容器"的横向隔离路线，agentboster 走"纵向分层权威"路线；manboster 走"单二进制加本地守护模型"路线，agentboster 走"三层加云端编排"路线；picoclaw 走"边缘单进程极致轻量"路线，agentboster 走"服务器优先多层解耦"路线；astrbot 走"IM 框架加插件生态"路线，agentboster 走"多端协作平台加工作流编排"路线。隔离哲学的根本分野是：横向隔离（每实例一沙箱）vs 纵向分层（权威中心加可丢弃执行端）vs 进程内守护（本地判官模型）——agentboster 是纵向分层的代表。

---

## 九、扩展与二次开发

### 9.1 Web 侧扩展点

Web 侧的扩展点是 Skills、Provider、工具、MCP、Soul、多渠道 Bot adapter。Skills 是模块化提示词包（带 YAML frontmatter），装在 bot 工作区，主 agent 可自主管理（listSkills/createSkill/updateSkill/deleteSkill），可委派给子 agent（subAgent 工具加 buildNestedTools 递归构建子工具集）。Provider 通过 AppConfig 配置多模型供应商（openaicompatible/anthropic/openai/google），支持 BYO Key。MCP 内置四个（web/firecrawl/github/context7）加远程 server（AppConfig mcp.remote_servers）。Soul 是人格设定（builtin_memories 的 AGENTS/SOUL/IDENTITY/USER），影响 system prompt。多渠道 Bot adapter 通过 channels 配置动态启用。

### 9.2 agentd 侧扩展点

agentd 侧的扩展点是工具、沙箱提供者、L0 规则。工具家族在 tools_register 注册，覆盖 exec/文件/git/web/memory/knowledge/browser 等。沙箱提供者实现 SandboxProvider 接口（Create/Exec/Destroy/Status），当前三个（DockerLightProvider/DockerProvider/LXCPersistentProvider）。L0 规则可由 Web 下发（Loader 周期拉取并热替换）或内置预设（DefaultPresets）。

### 9.3 CLI 侧扩展点

CLI 侧的扩展点是 local_* 工具、扩展（经 RPC 上下文）。local_* 工具在 handleLocalToolRequest 的 switch 中添加（local_read_file/local_write_file/local_exec/local_ask_question）。扩展经 RPC 上下文触发 regenerate（consumeRegenerateIntent）。jiti 运行时按需加载用户扩展或技能 JS/TS 文件。

---

## 十、总结

AgentBoster 是一个工程严谨的多端协作 AI 平台，其架构围绕硬分层、强异步、低耦合、强安全四个主轴展开。Web（Next.js 15）是唯一权威中心，承担体验与编排；agentd（Go）是无状态执行端，承担沙箱隔离与安全边界；CLI（pi 瘦客户端）是本机终端外壳，承担 TUI 与 local_* 工具执行。三者经窄 HTTP 契约协作，无共享代码、无共享 schema、无共享进程状态。Workflow DevKit 把 LLM 调用与工具循环落地为可恢复的 durable step，每步 delta 持久化，任一执行端宕机可从中断点续跑。三层安全（L0 规则黑名单、L1 LLM 风险评分、L2 用户授权）提供纵深防御，任一层可独立否决。多节点调度按资源打分选最优 agentd 节点，全不可达时回退 Vercel Sandbox。

这套设计的代价是三层部署的运维门槛、HTTP 往返的延迟、workflow 沙箱的开发复杂度、安全链路对体验的影响。收益是规模化的水平扩缩、长任务的韧性、企业级审计、不可信工具执行的安全边界。定位上，agentboster 适合需要多端协作、可恢复工作流、多层安全、多节点调度的团队或企业场景，不适合个人单机或边缘嵌入式场景。项目处于 WIP 状态，1.0 前接口与 schema 仍可能变化。

---

*本文档基于 AgentBoster 仓库（Web / agentd / CLI 三部分）实际源码的逐行阅读撰写，关键结论可在引用的源码文件中复核。文档生成时项目处于 WIP 状态。*

## 十一、Web 层内部协作的深层细节

本节展开 Web 层内几个易被忽略但至关重要的子系统协作，作为对前文 §二 的补充。

### 11.1 chatMain 的分支与状态机

chatMain 不只是一条线性流程，它在多个决策点分叉，每个分叉对应不同的会话生命周期事件。理解这些分叉是理解整个平台行为的关键。

第一分叉是命令与消息。parseChatInputEnvelope 把输入归一为两种：若是斜杠命令（如 /compact、/cancel、/model、/retry、/new、/session、/stop、/approve、/reject、/memory、/help 等），走 executeCommand 路径，命令在 Web 侧直接处理（多数情况）或转发到 workflow 内（少数情况如 /init-agents-md 走专用 workflow runInitAgentsMdWorkflow）。命令路径不启动新 workflow run，而是操作现有 session 状态或返回元数据。

第二分叉是 trigger 类型。submit-message 是正常新消息；regenerate-message 是编辑或重新生成已有消息，此时尝试 canResumeRun 加 pauseWorkflow——若现有 workflow run 仍可恢复，暂停它后续步骤，截断下游消息（deleteMessagesAfterUiMessageId）后用新输入恢复；若不可恢复（如 run 已完成或归档），则新建 run。route-message 是路由消息（定时任务或 IM 转发触发），复用现有 session 不新建。这三种 trigger 共享同一 chatMain，但走不同的会话状态变更路径。

第三分叉是会话存在性。ensureMessageSession 取或建 session：若有 sessionId 取现有；若无（如 IM 新对话、Web 点新对话）建新 session，channel 决定后续工具注册与跨通道访问策略。assertSessionWritable 校验跨通道读写：CLI 会话对 Web 只读（避免两端并发改写冲突），IM 会话只能从对应 adapter 写。

第四分叉是上下文构建。buildInitialContextMessages 注入 SOUL（builtin_memories SOUL 加会话级 soulContent）、AGENTS（builtin_memories AGENTS）、RAG（recallUserId/recallQuery 检索 long_term_memories 与 knowledge_bases）、技能清单、follow-up 建议（按 locale）。若会话有 session_memories 摘要，注入摘要而非完整历史以节省 token。

### 11.2 消息版本与会话摘要

消息版本（versions）是支持编辑与重新生成的数据结构。每条 user 消息可有多个版本（versions 数组），每个版本含 parts（该版本的用户输入）、createdAt、可选 response（配对的 assistant 回复快照）。currentVersionIndex 指向当前生效版本。编辑消息时，旧版本被保留（response 字段快照当时的回复），新版本追加；regenerate-message 走 deleteMessagesAfterUiMessageId 截断下游后用新版本重跑。Web 侧 scripts/migrate-message-versions.ts 把 legacy editHistory/generationHistory 转成统一的 versions 格式。CLI 与 Web 共享同一套字段，在 TUI 树选择器中按左中括号或右中括号在版本间循环，会 PATCH /api/cli/messages/[id]/metadata。

会话摘要（session_memories）是上下文压缩的持久化形式。当消息超过 contextLimit 或阈值时，prepareStep 决策触发 compactAndPersistSummaryStep（'use step'）：调 LLM 压缩历史为摘要，写 session_memories 表（summaryVersion 加 isCurrent 单版本指针，使旧摘要失效），后续 buildInitialContextMessages 注入摘要而非完整历史。CLI 侧也参与压缩协作：本地先调 pi 原生压缩逻辑（因 LLM context window 镜像在本地），压缩完 POST /api/cli/sessions/[id]/compact 让 Web DB 同步，两端上下文一致。

### 11.3 工具执行的路由决策

buildAgentTools 注册的九个内置工具加上 MCP 工具，每个工具的执行路由不同。sandbox（execute）工具经 selectBestNode 决策：有可用 agentd 节点则 execToolOnAgentd（'use step'）POST 到 agentd 的 /tools/exec（mTLS）；无则回退 Vercel Sandbox（backend vercel-fallback）。memory 工具操作 builtin_memories 或 long_term_memories（本地 'use step'）。skills（local）工具操作技能文件（本地 'use step' 或 Blob/KV）。schedule 工具创建/查询定时任务（'use step' 写 scheduled_tasks 表）。taskSummary 工具操作 task_summaries（'use step'）。subAgent 工具递归构建子工具集（buildNestedTools）跑独立 DurableAgent（最大步数 12，并发上限 3）。agentdNodes 工具查询节点状态（'use step' execToolOnAgentd 不带工具执行）。localCli 工具触发 local-tool-request SSE 发给 CLI。askQuestion 工具调 waitForResolution 阻塞 workflow step 等 UI 回答。MCP 工具经 dynamicTool 绑定执行体，调用时经 withToolExecutionLogger 记 agent_tool_activity_logs。

### 11.4 Workflow DevKit 的 step 编译

Workflow DevKit 在构建期把 workflow 函数编译成可序列化、可恢复的步骤图。next.config.ts 的 withWorkflow 包裹把 .well-known/workflow/* 路由与构建期 step 编译注入 Next。tsconfig.json 的 plugins 含 workflow（Workflow DevKit 的 TS 语言服务插件，提供 'use step' 与 'use workflow' 的类型检查）。workflow 函数体首行 'use workflow' 声明这是 workflow 函数，由 DevKit 拦截、序列化、可暂停/恢复；'use step' 标注的函数被序列化为一个步骤，在主机重入执行，结果传回沙箱。

这种编译模型的深层含义是：workflow 函数的执行不是传统意义上的"从头跑到尾"，而是 DevKit 在每个 step 边界持久化执行状态（locals、closure、pending promises），暂停时序列化到持久存储，恢复时反序列化重建执行上下文。这就是可恢复的机制基础。代价是 workflow 函数内的副作用必须显式标 'use step'（否则在沙箱内无法执行），且某些 host-only API（如 next/server 的 after）不能在 workflow 树内直接调用（因沙箱无 __dirname）。

### 11.5 IM 的双轨：会话触发与通知投递

IM 接入有两条独立的轨道。第一条是会话触发（入站消息到会话）：/api/bot/[authSecret]/[adapter]/callback 收 webhook，handleIncomingMessage 构造 ChatSource，routeAdapterMessage 喂给 chatMain，后续与 Web 同栈。这条轨道支持完整对话（多轮、工具调用、L2 决策）。maxDuration 300 秒确保 IM 流不被 Vercel 函数超时杀掉。

第二条是通知投递（决策卡、完成通知、整理报告）：当 L2 决策触发或任务完成时，NotificationManager 按 notification_preferences 的 preferredChannel 加 fallbackChannels 投递。决策卡带 command_review（命令分段、风险段标 !、附 level/score/reason）与 options（pass_once/pass_until/reject_once/reject_until），expiresAt 为 now 加 3 分钟。若 IM 平台支持 Delete（消息撤回），5 秒后自动撤回该决策卡（避免污染群聊）。通知状态记 notifications 表（pending 到 sent 到 delivered/failed/fallback/expired），支持召回。channel_health 记录每个通道的健康状态（consecutiveFailures、lastError、lastSuccessAt），失败转 fallback。

### 11.6 KV、Blob 与 Sandbox 的存储分工

Web 的存储有三层分工。Postgres（加 pgvector）是权威关系存储，存会话、消息、节点、决策、通知、vault、知识库、长期记忆等。Upstash Redis 是 KV 缓存与协调，存全局配置（AppConfig）、IM 适配器状态（@chat-adapter/state-redis）、配对状态标记（pair:bound:<adapter>:<imUserId>）、分布式锁（避免并发导入或同步重复）。Vercel Blob 是对象存储，存附件与技能仓库同步产物。

Vercel Sandbox（@vercel/sandbox）是另一种"存储"——它是 agentd 不可达时的工具执行回退。lib/core/sandbox 的 manager、runtime、session-runtime、actions 管理 Sandbox 生命周期与 runtime 元数据（patchWorkflowRuntime 写 phase 与 lastRunId）。工具执行时 backend 标识区分 agentd 与 vercel-fallback，开发者无感。

---

## 十二、agentd 层内部协作的深层细节

本节展开 agentd 内几个易被忽略但至关重要的子系统协作，作为对前文 §三 的补充。

### 12.1 Agent Manager 与会话运行时

Agent Manager（internal/agent/manager.go）是 agentd 侧的会话运行时管理者。RunAgent 在 task.approved 后被调用：建 session（拉取 SOUL 加 AgentConfig）、选沙箱（SelectSandbox）、建 workspace、跑 AgentLoop.Run。AgentLoop.Run 是 think 到 act 到 observe 的经典循环：每步先压缩检查（消息大于等于 50 触发 compactContext），构建系统提示，通过 /llm-proxy 调 Web 代理的 LLM，output audit，执行 tool call（再过一次 Gatekeeper.Audit 对工具调用本身），观察结果回灌，直到 LLM 不再调工具或达到 maxSteps（默认 30）。

GetAgentStats 提供实时活跃统计（活跃 task 数与活跃 sandbox 数，去重 sandbox_id），供心跳 countsFn 回调上报。agent 与 cgroup stats 回调挂载到 Agent Manager，周期采样写入 metrics 文件。

### 12.2 CodeAct 子循环与诊断

CodeAct（internal/agent/codeact.go）作为工具 codeact 注册，被 Agent loop 当作一个工具调用。它内部又跑一个子循环：LLM 产 markdown 代码块（标记 bash/js/python），executeCodeBlock 在沙箱执行（SbMgr.Exec，30 秒超时），观察回灌，直到 end_task 标记或 MaxTurns（默认 10）。失败时注入 generateDiagnosticHint 诊断提示——这是 agentd 的一个工程细节，主动给 LLM 提供失败原因的诊断线索（如"该错误通常由 X 引起，建议检查 Y"），帮助 LLM 自我修复。

### 12.3 上下文压缩的关键决策点识别

saveTaskState（loop.go）识别关键决策点，显式要求压缩摘要保留这些节点。三类关键决策点是：失败重试（LLM 尝试某方案失败后换策略）、文件改动（重要文件的创建/修改/删除）、git commit（代码版本节点）。generateCompactionSummary 显式要求保留"用户改需求节点"、"技术方案选择"、"失败换策略转折点"——这是对编码 agent 场景的特化，避免压缩丢失关键上下文导致 agent 重复犯错。

### 12.4 沙箱的崩溃恢复与孤儿清理

沙箱管理器的崩溃恢复设计有三层。Restore 在 agentd 重启后从 SandboxStore（磁盘 JSON）重填内存 map 与各 provider 内部 map——这确保重启不丢失已存在的沙箱。ReapOrphans 在启动时一次清扫：Docker 孤儿（重启前创建但未被清理的容器）销毁，LXC 孤儿 stop 保留 rootfs（因 LXC 可能持有关键数据）。HealthChecker 常驻周期探活，连续失败至少 2 次才 reap（避免 docker daemon 抖动误杀）。CleanupOnShutdown 在停机时 stopAllLXC 加 destroyAllDocker，30 秒预算（SIGTERM 优雅停机窗口）。

### 12.5 缓存与 session 存储的本地策略

agentd 虽"无状态"，但仍保留两类本地存储以提高性能。cache（internal/cache）是本地 session blob，gzip 压缩，周期 sync_interval 上游同步到 Web，retry_max_attempts 重试——这是 Web 数据的本地缓存，避免每次工具执行都跨网络拉取。session（internal/session）是 LRU 会话存储，max_count 默认 50、timeout 默认 30m——这是活跃会话的运行时镜像，超时或超容量时 LRU 淘汰。这两类存储都是"可丢弃的本地加速层"，丢失后从 Web 重建不影响正确性。

### 12.6 L1 打分的批量化与硬化

L1 打分的工程优化有两条线。批量化是 ScoreBatch：单次 LLM 调用打分多条命令，LLM 词表 allow/low/medium/high/block 映射回 low/medium/high/critical（mapBatchLevelToL1），失败回退逐条 Score。这大幅降低 L1 的 LLM 成本（一次调用评多条而非每条一次）。

硬化是 hardenL1Result，处理三类异常：nil 结果转 0.8 high（保守）；未知 level 强制 high（保守）；确定性 L2 模式（deterministicL2Patterns）正则匹配 shred、find -exec ... rm/shred/dd、find -delete、xargs ... rm/shred/dd、perl/ruby/node -e ... unlink/rmtree、python -c ... shutil.rmtree 等，无论 L1 给多少分都抬到 high 强制 L2。这是对 L1 误判的工程防御——某些命令的危险性是确定的（如 shred 文件），不应依赖 LLM 主观判断。

---

## 十三、CLI 层内部协作的深层细节

本节展开 CLI 内几个易被忽略但至关重要的子系统协作，作为对前文 §四 的补充。

### 13.1 streamFn 覆盖与 pi 的接管

resolveStreamFnOverride 是 CLI 瘦客户端化的核心。getStoredAuth 为空时返回 undefined，pi 回落本地 SDK（开发调试用）；已登录时始终返回 createAgentbosterStreamFn，覆盖 Agent.streamFn。这意味着登录后 pi 自带的 stream 路径根本走不到——所有 LLM 流量经 createAgentbosterStreamFn 到 Web。

createAgentbosterStreamFn 返回的函数满足 pi StreamFn 契约，但其行为与 pi 原生完全不同：忽略 pi 的 model 参数（Web 从 session 状态自选）、忽略 pi 的 context.tools（Web 拥有工具执行）、只转发最新一条 user 文本（历史不上行，服务端自持）。openAgentbosterStream 到 driveStream 完成 SSE 流到 pi 事件流的转换。

### 13.2 SSE chunk 到 pi 事件的翻译

web-stream 的 driveStream 是协议翻译层。Web 返回的标准 Vercel AI SDK UI message stream（SSE）有特定 chunk 类型，pi 的 AgentSession 期望另一组事件类型，driveStream 在两者间翻译。text-start/text-delta/text-end 翻译为 AssistantMessageEvent 的 text_delta；reasoning-start/delta/end 翻译为 thinking_delta；tool-input-start/delta/end 翻译为 toolcall_delta；tool-result 被吞掉（注释说明服务端工具执行结果已被服务端吸收进对话历史、无需 emit）；data-workflow 翻译为 subagent-event/subagent-batch-event/token-usage/local-tool-request；error 翻译为 error 事件；finish 翻译为 done。

关键的 trick 是 mapFinishReason：Web 给出的 finishReason 为 tool-calls 被 CLI 映射为 stop。原因如前述：工具在 Web 端执行，CLI 的 pi-agent loop 没有这些工具名，若回报 toolUse 会让 loop 尝试本地分派并报"Tool <name> not found"。映射成 stop 让 loop 干净结束本轮，Web 的 SSE 继续把后续轮的 assistant message 推下来。这是协议适配的精妙之处——CLI 假装"本轮已结束"，实则 Web 在后台继续多轮工具循环。

### 13.3 SessionManager.fromRemote 的重建逻辑

SessionManager.fromRemote 是从 Web UIMessage 数组重建本地 session 的关键。逐条把 UIMessage 转 SessionMessageEntry：user.parts 抽文本；assistant.parts 抽 text 加 dynamic-tool（把 toolCallId/toolName/input 转成 toolCall 块，让 TUI 能渲染历史工具调用）；版本元数据 metadata.versions/currentVersionIndex 原样挂到 entry.remoteMetadata。

重建后的本地 session 有两个用途：一是 TUI 渲染历史消息（让用户看到之前的对话与工具调用），二是作为 LLM context window 的镜像（供 pi 原生压缩逻辑使用）。但本地 session 是临时工作副本——Web 后端拥有持久状态——退出即清（registerTempSessionCleanup 在 exit/SIGINT/SIGTERM 时 unlinkSync）。

### 13.4 local-tool-request 的生命周期

local-tool-request 是 Web 借用 CLI 本机的协议。Web workflow 在需要本机执行时，经 SSE 推 data-workflow chunk（data.type 是 local-tool-request），含 runId、toolCallId、toolName、toolInput。runId 来自 HTTP 响应头 x-workflow-run-id。handleChunk 转交 options.onLocalToolRequest，回调绑定到 handleLocalToolRequest。

handleLocalToolRequest 的 switch 分发：local_read_file/local_write_file/local_exec/local_ask_question 各自执行，结果经 postToolResult POST /api/ai/[runId]/tool-result 回 Web（body 含 toolCallId、ok、output、error，Bearer 加 cookie 双携带）。Web 工作流的 localToolResultHookBuilder 阻塞等待此结果——workflow step 在 Web 侧暂停，直到 CLI 回 POST 结果或超时。

安全门控的边界情形：local_ask_question 直接跳过门控（问答无副作用）；--yolo 全自动放行；L0 block 立即返回失败；L2 需确认时若 headless（stdin 非 TTY）拒绝而非放行（避免在 CI 中无提示执行危险命令）。这是对 CI 场景的安全考量——--print 模式下不应有交互确认，但也不应静默执行危险命令，拒绝是最安全的折中。

---

## 十四、性能特征与资源占用

### 14.1 Web 性能特征

Web 部署到 Vercel 函数，性能受 Vercel 函数限制约束。maxDuration 默认 10 秒，IM webhook 显式设 300 秒。Serverless HTTP 驱动（@neondatabase/serverless）无连接池开销，适配 Vercel 函数的短生命周期。Workflow DevKit 的 durable step 持久化到 Postgres，函数重启不丢失执行状态（从 sessions.workflowRunId 恢复）。

冷启动方面，Next.js 15 加 React 19 加众多依赖（AI SDK、Chat SDK、drizzle、Radix 全家桶）的 bundle 较大，首次函数冷启动可能数秒。next.config.ts 的 experimental.optimizePackageImports 对 Radix、lucide、react-markdown、framer-motion 做按需加载优化，缓解 bundle 体积。serverExternalPackages 把原生或 WebSocket 依赖外部化，避免 webpack 打包破坏。

### 14.2 agentd 性能特征

agentd 是常驻进程，无冷启动问题。指标每 10 秒采样，心跳每 30 秒上报。沙箱执行的开销主要在容器创建（docker light 用 `--rm` 一次性、docker-strict 复用、LXC persistent 长期复用）。CodeAct 单块默认 30 秒超时，task 默认 300 秒超时。worker pool 动态伸缩（min/max/scale_up_pct/scale_down_pct/cooldown），exec 池 stats 5 秒、cooldown 10 秒（更快响应 exec_batch 并行需求）。

内存占用方面，agentd 自身是 Go 二进制，开销小；主要内存消耗在沙箱（docker light 默认 256m、docker-strict 默认 512m、LXC 按 cgroup2 限额）。cgroup stats 上报让 Web 知道每节点沙箱总内存压力（memPressure = min(peak/8GB, 1)），用于调度决策。

### 14.3 CLI 性能特征

CLI 是 Node.js 进程，启动开销在 Node 启动加 bundle 加载。bundle（esbuild 单文件 CJS）减小 require 开销。TUI 渲染靠 pi-tui，流式更新靠 EventStream。local_exec 的 stdout/stderr 各 100KB 截断（避免大输出拖垮 TUI）。CLI 不做模型推理（经 Web），不做持久化（临时镜像），所以本地资源占用主要是 TUI 渲染加 local_* 工具执行。

---

## 十五、安全攻防考量

### 15.1 提示注入与输出审计

平台对提示注入（prompt injection）的防御主要在 output audit。L0 output 规则集 DefaultOutputRules 检 LLM 输出是否泄露系统提示（"## 安全规则"、"you are AgentBoster"）、越狱指令（"ignore previous instructions"、"DAN mode"）、API key 或 Bearer token 或私钥头、内部敏感路径。命中后 AuditOutput 返回 blocked，Agent loop 注入安全替换消息。AuditOutput 还会再调 L1 ScoreOutput 做输出侧泄露检测。

这种防御是双向的：既防 LLM 被注入后泄露系统提示（保护平台信息），也防 LLM 输出敏感凭据（保护用户数据）。但这是启发式的（正则加 LLM 评分），不能完全防御高级攻击——AGENTS 与 README 都强调安全是纵深防御，不依赖单一层。

### 15.2 沙箱逃逸的防御

沙箱逃逸的防御在 OS 强制层。三档沙箱都用 cap-drop ALL（docker-strict 不加回，docker light 加回 BaselineKeep 共 10 个，LXC 丢弃约 30 个 DangerousCaps）。seccomp DefaultHardened 拒绝 init_module/finit_module/delete_module、kexec_load、reboot、mount/umount2/pivot_root、ptrace/process_vm_*、swapon/swapoff、unshare/clone3、bpf/perf_event_open、keyctl/add_key/request_key、memfd_create、setns 等。masked paths 用 /dev/null 绑定覆盖 /etc/shadow 等。网络隔离（docker-strict 强制 `--network none`，其他档受 network_isolate 控制）。出站 egress 用 EgressAllowlist glob 经 DNS 解析后用 iptables 注入 netns。

### 15.3 凭据隔离

凭据隔离有三层。第一层是 vault（vault_entries 表，encrypted_value 加 nonce，Libsodium/XChaCha20-Poly1305 风格），给 daemon 配发的 provider API key、第三方 token 都经 vault 加密存储。第二层是 LLM 不接触原始凭据——Web 解密 vault 后注入到 LLM 调用，凭据不出现在 prompt 或工具参数中。第三层是 vault_audit_logs 记录所有 vault 读写，供审计追踪。

CLI 侧的凭据隔离是 config.json 中的 token（Bearer）。token 不缓存校验结果（每次 API 调用都经 Web withCliAuth 校验），吊销是实时的。token 经 cookie 加 Authorization 双携带，但仅用于与 Web 的通信，不暴露给 LLM 或工具。

### 15.4 不可信工具执行的边界

不可信工具执行（如用户上传的代码、IM 触发的命令）走完整三层安全。L0 规则黑名单快速 deny 已知危险模式；L1 LLM 评分对未知命令做语义评估；L2 用户授权对高危操作人工 approve/deny。任一层可独立否决。沙箱选择 SelectSandbox 按风险自动选档（高风险走 docker-strict，需持久化走 lxc）。OS 强制层（cap/seccomp/mount/network）提供执行时隔离。

关键设计是 fail_open 的默认值。L1 调用失败时，fail_open 为 false（默认）则 blocked，fail_open 为 true 则当作 medium 放行。但 L1 不可用时（health 探测失败）Score 直接返回 0.8 high 强制走 L2，不存在"被自动放行的高危"路径。这是保守的安全默认——宁可误报拦死，不可漏放高危。

---

## 十六、运维与升级

### 16.1 三层独立发版

三层各有独立发版周期。Web 是 yarn（package.json 无 engines 字段，跟随 Next.js 与 Node 主线）。agentd 是 Go（go 1.26.2，独立 module，yarn build:agentd 从仓库根调用）。CLI 是 npm（packageManager yarn@1.22.22，Node 不低于 22.19，独立 Yarn monorepo）。三层各有自己的 AGENTS.md 与工具链。升级兼容性不作保证（1.0 前接口与 schema 仍可能变化）。

### 16.2 数据库迁移

数据库迁移用 drizzle-kit。db:generate 生成迁移文件到 lib/core/db/migrations；db:push 推送 schema 到数据库；db:studio 可视化。postbuild 脚本只在 Vercel 生产（VERCEL=1 且 VERCEL_ENV=production）执行 ensure-vector-extension 到 drizzle-kit push 到 migrate-message-versions——本地 build 不动数据库。这意味着首次部署到 Vercel 生产会自动建表与迁移，但开发环境需手动 yarn db:push。

schema 变更需谨慎：sessions、messages、agentd_nodes、l2_decisions 等表是运行时权威数据，迁移要保证向后兼容。drizzle 的 PRAGMA table_info 加 ALTER TABLE 做"软迁移"（如 astrbot 的实践），agentd 侧的 SandboxStore 磁盘 JSON 也需考虑版本兼容。

### 16.3 agentd 的升级与兼容

agentd 升级需考虑：节点身份持久化（node_id_file 跨重启复用）、沙箱恢复（Restore 从 SandboxStore 重填）、缓存同步（cache 周期上游同步）、L0 规则热加载（Loader 周期拉取）。version 字段（main.go 的 version = "0.1.0"）变更 HTTP 契约或缓存格式时需手动 bump。

### 16.4 CLI 的升级与兼容

CLI 升级用 agentboster update（handlePackageCommand）。session 文件格式 CURRENT_SESSION_VERSION = 3，v1 文件通过 migrateToCurrentVersion 升级。Web 侧的 versions 格式（scripts/migrate-message-versions.ts）与 CLI 共享，需同步迁移。token 格式（base64url(payload).base64url(hmac)）与 Web 共享，变更需两端协调。

---

## 十七、术语索引

为便于检索，本节汇总平台特有术语。CodeAct 是以代码或工具调用为动作单元的 Agent 循环范式。Workflow DevKit 是 Vercel 出品的可恢复或可重试 step 编排框架，agentboster 用作 LLM 与工具循环的持久化层。'use step' 是 agentboster 中标注"仅在工作流步骤内可用"的 host helper 指令，确保不被 sandbox 直接调用。'use workflow' 是标注 workflow 函数体的指令，由 DevKit 拦截、序列化、可暂停或恢复。L0/L1/L2 是 agentboster 三层安全：L0 规则黑名单、L1 LLM 风险评分、L2 用户授权。agentd 是 agentboster 的 Go 守护进程，沙箱执行端，无状态、可水平扩缩。clawless-auth 是 Web 与 CLI 共享的鉴权 cookie 名，token 格式为 base64url(payload).base64url(hmac)。AGENTD_API_KEY 是 agentd 与 Web 的共享 API Key，作 X-API-Key 或 Authorization Bearer。Pattern A 是纯出站 agentd 部署（NAT 后，仅心跳）。Pattern B 是入站工具 agentd 部署（mTLS，支持同步工具 RPC）。chatMain 是 Web 与 CLI 与 IM 与定时任务共享的消息派发总闸。persistStepDeltaAndUsageStep 是带 'use step' 的持久化函数，每步把 assistant 文本、工具调用、工具结果拆成多行写入 messages 表。local_* 是 CLI 本机执行的工具家族（local_read_file/local_write_file/local_exec/local_ask_question）。SOUL 是人格设定（builtin_memories 的 SOUL key），影响 system prompt。SandboxProvider 是 agentd 沙箱提供者接口（Create/Exec/Destroy/Status），当前三个实现（DockerLightProvider/DockerProvider/LXCPersistentProvider）。Permission Profile 是沙箱权限档（default/strict/network/package-install/browser/persistent），强制改写 spec.Type 与 SecurityPolicy。DangerousCaps 是 LXC 丢弃的约 30 个高危 capability（SYS_ADMIN/NET_ADMIN/NET_RAW 等）。BaselineKeep 是 docker light 加回的 10 个 baseline capability（CHOWN/DAC_OVERRIDE/FOWNER/SETUID 等）。DefaultHardened 是 seccomp profile，默认 ALLOW，ERRNO 拒绝高危 syscall。EgressAllowlist 是出站 egress 的 glob 白名单，经 DNS 解析后用 iptables 注入 netns。Gatekeeper 是 agentd 的安全编排器，Audit 方法走 L0 到 L1 到 L2 加 output audit。L2AuthManager 是 agentd 的本地 L2 缓存（快路径），持久化在 Web 的 DecisionQueue。DecisionQueue 是 Web 的 L2 决策队列，进程内热缓存加 Postgres l2_decisions 表持久化双写。EventBus 是 agentd 的进程内 pub/sub（每订阅者一个 goroutine 加 buffered channel 容量 100）。Dispatcher 是 agentd 的事件到池映射器（task.created 到 review 池，task.approved 到 task 池等）。DynamicPoller 是 Web 的动态 worker pool（2 到 8 worker，轮询 DB 定时任务）。ChannelManager 是 Web 的统一 IM 适配器抽象（Discord/Slack/Telegram/Feishu 为 IChannelAdapter）。NotificationManager 是 Web 的通知投递器（按 preferredChannel 加 fallbackChannels）。UMOP 是 unified_msg_origin（astrbot 概念，agentboster 类似用 channel 加 externalThreadId）。streamFnOverride 是 CLI 覆盖 pi 的 Agent.streamFn 的机制（createAgentbosterStreamFn）。mapFinishReason 是 CLI 把 Web 的 finishReason tool-calls 映射为 stop 的 trick。SessionManager.fromRemote 是 CLI 从 Web UIMessage 数组重建本地 session 的方法。registerTempSessionCleanup 是 CLI 退出时清理 tmpdir session 文件的钩子。

---

*本文档基于 AgentBoster 仓库（Web / agentd / CLI 三部分）实际源码的逐行阅读撰写。文档生成时项目处于 WIP 状态，1.0 前接口与 schema 仍可能变化。*

## 十八、端到端场景演练

本节通过几个具体的端到端场景，展示三层如何协作完成真实任务。这些场景基于前文描述的机制推演，帮助理解平台在实战中的行为。

### 18.1 场景一：浏览器中让 agent 修复 failing test

开发者在浏览器聊天框输入"修复失败的测试"。前端 useChat 经 transport POST /api/ai，trigger 是 submit-message。middleware 校验 cookie clawless-auth，注入 x-user-id。route handler 调 chatMain：归一 source 为 web；归一输入为 message；ensureMessageSession 取现有 session（或建新）；upsertUserMessage 写用户消息；无 workflowRunId 则 startWorkflow。chatWorkflow 在 DevKit 沙箱跑：resolve-model 选默认模型；buildSystemPrompt 注入 SOUL 与 AGENTS；buildAgentTools 注册工具；DurableAgent.stream 跑循环。LLM 决定调 sandbox 工具执行 `npm test`。selectBestNode 找到在线 agentd 节点（假设已部署），execToolOnAgentd POST 到 agentd 的 /tools/exec（mTLS）。agentd 的 handleToolExec 获取 session，拉 SOUL，选沙箱（npm test 需持久化走 lxc），在 LXC 沙箱内 `lxc-attach -- sh -c "npm test"`。Gatekeeper.Audit 走 L0（无命中）到 L1（web_callback 打分返回 low），放行。结果（测试失败详情）回 Web，Web 写 agent_tool_activity_logs，工具结果回灌 writable 流。LLM 看到失败，决定调 read 工具读测试文件，再调 edit 工具改源文件，再调 sandbox 工具重跑测试。如此循环直到测试通过或达到 maxSteps。每步 onStepFinish 调 persistStepDeltaAndUsageStep 写 messages 表。最终 LLM 不再调工具，workflow run 完成，afterResponse 调 extractMemoriesFromSession 抽取长期记忆（如"该项目的测试用 vitest"）。浏览器流式渲染全部过程，用户看到 agent 的思考、工具调用、工具结果。

### 18.2 场景二：CLI 中让 agent 重构本机代码

开发者在终端运行 `agentboster "把 utils.js 重构成 TypeScript"`。getStoredAuth 检查 config.json 已登录。createSessionManager 建 SessionManager（sessionDir 在 tmpdir）。createRuntime 装配 createAgentbosterStreamFn 覆盖 Agent.streamFn。InteractiveMode.run 启动 TUI。用户输入后，driveStream POST /api/cli/chat（Bearer 加 cookie 双携带），trigger 是 submit-message，clientId 是 local-cli。Web 走 chatMain，source 类型 cli，channel 写 `cli:local-cli`，触发 local_* 工具注册。Web 返回 SSE 流。LLM 决定调 local_read_file 读本机 utils.js——Web 经 local-tool-request SSE 推给 CLI，handleLocalToolRequest 在本机 fs.readFile utf8，结果 POST /api/ai/[runId]/tool-result 回 Web。LLM 看到文件内容，决定调 local_write_file 写 utils.ts——同样经 local-tool-request，evaluateLocalCommand 检查（write_file 不在 block 或 escalate 模式），若未带 --yolo 且有 TTY，readline 问 y/N 确认；用户 y 后执行，结果回 Web。LLM 继续调 local_exec 跑 `tsc --noEmit` 验证——evaluateLocalCommand 检查 tsc 不在危险模式，放行；结果（可能有类型错误）回 Web。LLM 根据错误继续改文件，循环直到通过。退出时 registerTempSessionCleanup 清理 tmpdir session 文件——但 Web DB 持久化了完整对话，下次 `agentboster --resume` 从 Web 拉取重建。

### 18.3 场景三：IM 中触发需要 L2 授权的危险命令

用户在 Telegram 发消息"清理一下 /tmp 目录"。/api/bot/[authSecret]/telegram/callback 收 webhook，isValidBotSecret 校验。handleIncomingMessage 构造 ChatSource（type im、adapter telegram、threadId、userId）。isImUserAuthorized 校验配对（已配对）。routeAdapterMessage 喂给 chatMain，trigger route-message，source im。Web 启动 workflow run（若 IM 新对话则建 session，channel 写 im:telegram）。LLM 决定调 sandbox 工具执行 `rm -rf /tmp/*`。execToolOnAgentd POST 到 agentd 的 /tools/exec。agentd 的 Gatekeeper.Audit 走 L0——`rm -rf /*` 模式接近 `rm -rf /` 预设但 `*` 后缀可能不精确命中（取决于预设正则）；假设不命中 L0，走 L1——L1 web_callback 打分返回 high（rm -rf 是高危）。hardenL1Result 检查 deterministicL2Patterns（rm -rf 不在确定性列表但 L1 已 high）。转 L2：requestL2Auth 查本地 L2AuthManager.Check（首次无缓存），发布 EventL2AuthRequired，task 进入 pending_confirm。Dispatcher 的 handleL2AuthRequired 调 SendNotification 推 Telegram 决策卡（带 command_review "rm -rf /tmp/*"、options pass_once/pass_until/reject_once/reject_until、expiresAt now+3m）。同时 Web 侧 DecisionQueue 入队（写 l2_decisions 表，TTL 5 分钟）。用户在 Telegram 点 "Reject once"——Web 收到按钮回调，POST /api/agentd/v1/decisions/[id]/resolve，归一化 action 为 reject，调 queue.deny，对 l2_auth 调 forwardL2Confirm POST 给 agentd 的 /l2-confirm（action reject_once）。agentd 发布 l2.auth_rejected，Dispatcher 的 handleL2Auth 更新本地 L2 缓存（RejectTask，duration once 不写缓存），发 task.rejected。任务被拒绝，agentd 回 Web 工具执行失败，LLM 看到拒绝结果，向用户解释"该命令需要授权被拒绝，是否指定具体文件"。5 秒后 Telegram 决策卡被自动撤回（Delete）避免污染群聊。

### 18.4 场景四：定时任务触发每日报告

用户在 Web 配置页创建 daily 定时任务"每日 9 点生成本周工作总结"，timezone Asia/Shanghai，dailyTime 09:00。scheduled_tasks 表记录 type daily、nextRunAt 算到下一个 9 点。DynamicPoller 周期轮询，到期时 deliverScheduledTask 触发（sameInstant 幂等保护）。chatMain 带 trigger route-message 与 source scheduled，复用完整 chat 路由栈。Web 启动 workflow run，LLM 决定调 memory 工具检索本周的 long_term_memories（如工作决策、文件改动），调 knowledge_search 工具查知识库，调 sandbox 工具生成 markdown 报告。完成后 NotificationManager 按 preferredChannel（假设 telegram）投递报告到用户 Telegram。派发后回写 lastTriggeredAt/lastFiredFor/lastChatRunId，daily 类型保留并更新 nextRunAt 到次日 9 点。次日同一时刻重复。

### 18.5 场景五：多节点故障切换

团队部署了 3 个 agentd 节点（node-a、node-b、node-c）。用户在浏览器让 agent 跑长任务（如 `git clone 大仓库 && npm install && npm build`）。LLM 决定调 sandbox 工具。selectBestNode 查 status online 且 lastHeartbeat 在近 2 分钟内的节点，假设三个都在线，按资源打分选最优（如 node-a cpu 空闲最高、memPressure 最低）。execToolOnAgentd POST 到 node-a。任务执行到一半，node-a 网络抖动失联——node-a 的心跳停发，Web 侧 2 分钟后把 node-a 标 offline。此时 workflow run 在 node-a 上的工具执行若已发出但未返回，workflow step 暂停等待（durable step）。用户在 Web 看到任务卡住，点 abort。Web 标 session aborted，workflow run 暂停。用户重新触发（regenerate-message），chatMain 尝试 canResumeRun 失败（run 已 abort），新建 run。新 run 的工具执行 selectBestNode 现在只考虑 node-b 与 node-c（node-a offline），选 node-b。任务在 node-b 重新跑（git clone 重来，因 node-a 的 LXC 沙箱数据不可达）。node-a 恢复后重新发心跳，Web 标 online，下次任务又可调度到 node-a。整个过程中用户无需关心节点故障，平台自动切换。

---

## 十九、反模式与陷阱

本节列举使用与开发平台时常见的反模式与陷阱，帮助避免踩坑。

### 19.1 在 workflow 函数内直接调 host-only API

反模式：在 chatWorkflow 函数体内直接 import 并调用 next/server 的 after()，或直接访问 process.env、__dirname、Buffer。陷阱：workflow 函数在 DevKit 沙箱内运行，没有这些 host 能力。历史教训：曾用 next/server 的 after() 因沙箱无 __dirname 导致 ua-parser-js 崩。正确做法：所有需要 host 能力的副作用标 'use step'，由 DevKit 在主机重入执行；流结束后的清理用自研 afterResponse 与流关闭钩子（dispatch.ts 的 tee 旁路）。

### 19.2 忘记给 host helper 标 'use step'

反模式：在 workflow 树内定义一个写数据库或调 fetch 的函数，忘记在函数体首行加 'use step'。陷阱：DevKit 会在沙箱内调用它，但沙箱无 fetch 或 DB 访问能力，运行时报错。正确做法：所有访问网络、文件系统、数据库、process 的函数都标 'use step'。例外是 local_* 工具的 execute（故意不加，靠 workflow hook 而非再入 vm）。

### 19.3 误用 fail_open

反模式：在生产环境配 agentd 的 security.fail_open 为 true。陷阱：L1 调用失败（如 Web 临时不可达）时当作 medium 放行，可能让高危命令漏过。正确做法：生产环境 fail_open 为 false（默认），让 L1 失败时 blocked 而非放行。注意 L1 不可用时（health 探测失败）Score 直接返回 0.8 high 强制走 L2，与 fail_open 无关——fail_open 仅对"调用失败"生效。

### 19.4 Vercel 部署下设 agentd 出站 mTLS CA

反模式：在 Vercel 部署下设 AGENTD_CLIENT_CA_PATH 指向自定义 CA。陷阱：NewClientFromConfig 用 x509.SystemCertPool 然后 AppendCertsFromPEM 来"增强"而非"替换"系统根，但若用户强行配了自定义 CA，公网证书（Let's Encrypt）仍可能误判，导致 Web 到 agentd 的 mTLS 调用失败。正确做法：Vercel 部署下 Web 出站方向不设 client_cert_path/ca_path，让 Web 用系统根 CA 校验 agentd 的服务端证书；agentd 侧配入站 mTLS（server.tls_cert_path 等），Web 侧仅配 AGENTD_API_KEY。

### 19.5 期望 local_* 工具在 agentd 沙箱执行

反模式：期望 local_exec 在 agentd 节点的沙箱内执行。陷阱：local_* 工具的语义是"用户机器"，仅在 CLI 本机执行；需在 agentd 沙箱执行的工具用 sandbox 工具（exec 等）。--yolo 仅对 local_* 生效，经 Web 派发到 agentd 的工具仍走三层安全。正确做法：区分工具家族——local_* 是 CLI 本机，sandbox/exec 是 agentd 节点，memory/skills 是 Web 本地或 Blob/KV。

### 19.6 忽略 IM webhook 的 maxDuration

反模式：在非 Vercel 部署或自托管 Next.js 时，忽略 IM webhook 的 maxDuration 300 秒配置。陷阱：默认 Next.js 函数超时 10 秒，IM 触发的长任务（如多轮工具循环）会被杀掉，用户在 IM 看不到回复。正确做法：自托管时确保函数超时配置足够长（至少 300 秒），或改用 IM 通知投递（NotificationManager）异步告知用户任务完成。

### 19.7 依赖 rootful docker 而不开 allow_rootful_docker

反模式：agentd 配 docker_socket 指向 /var/run/docker.sock 但不开 allow_rootful_docker。陷阱：config 校验会拒绝启动（isPrivilegedDockerEndpoint 判定特权端点，必须显式 allow）。这是防误用设计——rootful docker 有沙箱逃逸风险。正确做法：用 rootless docker（推荐 unix:///run/user/<uid>/docker.sock），或显式 allow_rootful_docker=true 并理解风险。

### 19.8 在 CLI --print 模式期望交互确认

反模式：在 CI 中用 `agentboster -p "run dangerous cmd"` 期望 L2 交互确认。陷阱：--print 模式 stdin 非 TTY，L2 需确认时直接拒绝而非放行（避免静默执行危险命令）。正确做法：CI 场景用 --yolo（明确信任），或确保命令不在 escalate 模式（如避免 git reset --hard、curl|bash）。

---

## 二十、与生态的集成点

### 20.1 Chat SDK（chat 包）

Web 用 Chat SDK（chat 4.29.0）加 @chat-adapter/{telegram,discord,slack,teams,gchat,state-redis} 接入 IM。getBot 经 getBaseBot 与 createBotAdapters 按 channels 配置动态 import 适配器。new Chat({adapters, state: redisState, userName}) 实例化，状态存 Upstash Redis。入站 webhook 经 bot.webhooks 处理，出站经 Chat.sendMessage 推回。next.config.ts 的 serverExternalPackages 把 @chat-adapter/discord、@discordjs/ws、discord.js、zlib-sync 外部化（原生或 WS 依赖）。

### 20.2 Vercel Workflow DevKit

Web 用 Vercel Workflow DevKit（workflow 4.3.1 加 @workflow/ai 加 workflow/next 加 workflow/api）做 durable 编排。next.config.ts 的 withWorkflow 包裹注入 .well-known/workflow/* 路由与构建期 step 编译。tsconfig.json 的 plugins 含 workflow（TS 语言服务插件）。workflow:inspect 脚本打开 Workflow 运行可视化（workflow inspect runs --web）。

### 20.3 Vercel Sandbox

Web 用 @vercel/sandbox 作为 agentd 不可达时的工具执行回退。lib/core/sandbox 的 manager/runtime/session-runtime/actions 管理 Sandbox 生命周期。backend 标识区分 agentd 与 vercel-fallback，开发者无感。

### 20.4 Neon Postgres 与 pgvector

Web 用 @neondatabase/serverless（Serverless HTTP 驱动）加 drizzle-orm 访问 Postgres。pgvector 扩展支持向量检索（long_term_memory_chunks.embedding、knowledge_chunks.embedding）。ensure-vector-extension 脚本运行 CREATE EXTENSION。drizzle.config.ts 指向 schema 源，db:generate/db:push 管理迁移。

### 20.5 Upstash Redis 与 Vercel Blob

Web 用 @upstash/redis 存 IM 适配器状态（@chat-adapter/state-redis）、全局配置（AppConfig）、配对状态标记、分布式锁。用 @vercel/blob 存附件与技能仓库同步产物。

### 20.6 Anthropic Sandbox Runtime 类型

CLI 用 @anthropic-ai/sandbox-runtime 作为开发期类型来源（实际沙箱执行在 agentd，CLI 本机不使用）。这是类型层面的依赖，不引入运行时沙箱。

### 20.7 pi 框架

CLI 基于pi 框架（@earendil-works/pi-*）的瘦客户端 fork。pi 提供 pi-coding-agent（CLI 结构）、pi-agent-core（Agent 循环原语）、pi-ai（LLM 类型面）、pi-tui（TUI 渲染）。AgentBoster CLI 在 pi 之上新增 @agentboster/adapter（StreamFn 契约适配）。

### 20.8 MCP 生态

Web 与 agentd 都支持 MCP（Model Context Protocol）。Web 内置四个 MCP server（web/firecrawl/github/context7），支持远程 MCP server（AppConfig mcp.remote_servers）。agentd 的 mcp_call 工具（gated）可调 MCP。CLI 经 Web 间接用 MCP（不本地解析）。

---

## 二十一、版本与兼容性策略

项目处于 WIP 状态（1.0 前），README 与 AGENTS.md 都明确：在 1.0 发布前，功能与接口仍可能变化，升级兼容性不作保证。这意味着 schema、HTTP 契约、CLI 命令、配置格式都可能在版本间 breaking change。

具体兼容性边界：Web 的数据库 schema（drizzle）变更需 db:push，向后兼容性不保证；agentd 的 HTTP 契约（version 字段）变更需手动 bump，agentd 与 Web 版本需匹配；CLI 的 session 文件格式（CURRENT_SESSION_VERSION = 3）有 migrateToCurrentVersion 升级路径，但跨大版本不保证；token 格式（base64url(payload).base64url(hmac)）与 Web 共享，变更需两端协调；L0 规则格式（pattern/patternType/action）可能扩展，向后兼容性不保证。

升级建议：1.0 前不要在生产依赖单一版本，关注 release notes，三层版本保持一致（Web 的 version、agentd 的 version、CLI 的 package.json version）。`yarn publish` 现在会先跑 `yarn lint:check`（`tsc --noEmit && biome check ...`）再 build 与 push，发版前质量门已能跑通。

---

## 二十二、文档导航

仓库内文档分工。README.md（中文）与 README.EN.md（英文）是高层地图，介绍平台架构、核心能力、快速部署、环境变量、常用命令、IM 命令、相关文档。AGENTS.md 是 OpenCode 会话的紧凑指南，补充 README 易遗漏的仓库形态、命令、Web 陷阱、风格与基础设施、有用指针。subpackage/agentd/README.md 与 subpackage/agentd/AGENTS.md 是 daemon 的边界文档（部署、配置、运行模式、构建）。subpackage/cli/README.md 与 subpackage/cli/AGENTS.md 是 CLI 的边界文档（monorepo 组织、pi 关系、命令、瘦客户端边界、打包分发）。多节点调度无独立计划文档，逻辑直接落在 `lib/workflow/scheduled/dispatch.ts` 与 `app/api/agentd/v1/nodes/*`。

本文档（architecture.md）补充上述文档的空白，提供三层架构的端到端深度剖析，基于实际源码而非 README 的描述性段落。如需更细节，可对照引用的源码文件复核。

---

*本文档基于 AgentBoster 仓库（Web / agentd / CLI 三部分）实际源码的逐行阅读撰写，覆盖平台总览、Web 层、agentd 层、CLI 层、横切关注点、部署拓扑、关键数据流、设计取舍、内部协作深层细节、端到端场景、反模式与陷阱、生态集成、版本策略等二十余个章节。文档生成时项目处于 WIP 状态，1.0 前接口与 schema 仍可能变化。*

## 附录 A：仓库目录速查

本附录提供仓库目录的速查表，便于定位源码。

仓库根刻意把三个独立模块并列，而非 yarn workspace。根的 tsconfig.json 与 vitest.config.ts 都显式排除 cli 与 agentd，所以根的 tsc --noEmit 不会触及子项目。根目录含 Next.js 配置（next.config.ts、tsconfig.json、postcss.config.mjs、tailwind.config.ts）、Drizzle 配置（drizzle.config.ts）、Vitest 配置（vitest.config.ts）、Biome 配置（biome.jsonc）、中间件（middleware.ts）、全局类型声明（global.d.ts）、Workflow DevKit 上下文（context7.json）、技能锁文件（skills-lock.json）、脚本目录（scripts，含 vercel-postbuild.ts、ensure-vector-extension.ts、migrate-message-versions.ts 等）、推送脚本（push.py）。

app 目录是 Next.js App Router。页面分路由组：(auth) 含登录页；(chat) 含主聊天域（根聊天页、chat/[id] 会话页、schedule 定时任务、files 附件，有 layout 与 error 边界）；(config) 含配置域（分页签 [section]、tasks、notifications，有 loading 与 error 边界）；(skill) 含技能管理；(memory) 含长期记忆与 builtin memory 管理。app/api 含约 90 个 route.ts，按职责分组（详见 §2.3）。

lib 目录按业务域划分。ai（Provider 抽象）、audio（TTS）、auth（自签 token、设备配对、密码、访问控制）、bot（IM 接入，含 webhook 校验、getBot、handleIncomingMessage、reply）、chat（会话与消息持久化，含 chatMain、persistence、access、message-utils、stream、stream-guard、use-chat-transport、use-stream-recovery、use-token-usage、use-pending-decisions、commands 子目录、dedup、user-locale）、cli（CLI 共享常量与类型）、core（含 blob、db、kv、sandbox）、extra（含 agent、auth、channels、config、cron、db、memory、sandbox、security，多数是 daemon 风格子系统的 TS 镜像）、i18n（含 locales）、knowledge（RAG 知识库）、mcp（含 builtin 四个 server）、memory（含 extract）、security（Web 侧 L1 镜像与 L2 决策队列）、utils（含 logger）、vault（凭据库）、workflow（含 agent 与 scheduled）。

agentd 目录是独立 Go module。cmd 含 agentd（main 入口、tui 安装向导）。internal 含 config（Viper 加载）、server（gin 路由、middleware、exec_stream）、lifecycle（单例锁、注册、心跳）、identity（节点身份）、clawless（Web 客户端、l1_client）、security（gatekeeper、l0_rules、l2_auth、os_enforce、privilege）、sandbox（manager、registry、docker_light、docker、lxc_persistent、health_check、egress、reaper）、agent（loop、codeact、manager、tools_register、subagent_runner）、worker（pool、dispatcher）、eventbus（bus、types）、metrics、cache、session、persistence、i18n 等。agentd.toml.example 是配置模板。build.py 是构建脚本。

cli 目录是独立 Yarn Classic monorepo。packages 含 ai（thin-client fork of pi-ai，类型面加事件流）、agent（thin-client fork of pi-agent-core，agent-loop/agent/proxy）、agentboster-adapter（私有，StreamFn 契约适配，含 auth、models、stream-fn、web-stream、remote-sessions、preferences、security）、coding-agent（agentboster 二进制本体，含 cli 入口、main 调度、args 解析、login、config、core/session-manager、core/sdk、core/system-prompt、modes/interactive、modes/print-mode、modes/rpc 等子目录）。scripts 含 bundle.mjs（esbuild 单文件）、package.mjs（tarball 打包）。

## 附录 B：关键配置项速查

### Web 环境变量

AUTH_SECRET（鉴权 HMAC 密钥，必填）、USERNAME 与 PASSWORD（初始用户，0 用户时初始化）、DATABASE_URL（Postgres 连接串，生产必填，建议带 pgvector）、BLOB_ACCESS 与 BLOB_READ_WRITE_TOKEN（Vercel Blob 附件存储）、AGENTD_API_KEY（与 daemon clawless_api_key 一致，支持逗号分隔多值用于多 daemon 或密钥轮换）、AGENTD_CLIENT_CERT_PATH/KEY_PATH/CA_PATH（仅 Web 主动访问 daemon 时需要，Vercel 部署应留空）、TAVILY_API_KEY（可选联网搜索）、VERCEL 与 VERCEL_ENV（控制 postbuild 行为，仅生产才迁移数据库）。

### agentd 配置（agentd.toml）

server.listen（监听地址，默认 :18732）、server.tls_cert_path/tls_key_path/ca_path（入站 mTLS，空则纯 HTTP）、server.clawless_api_key（双向共享密钥）。clawless.base_url（Web 后端基址）、clawless.client_cert_path/client_key_path/ca_path（出站 mTLS，Vercel 部署留空）、clawless.heartbeat_interval（默认 30s）、clawless.node_id_file（默认 /var/lib/agentd/node_id）。security.l1_enabled、security.fail_open（生产应 false）、security.l1_provider（web_callback 或 local_ollama）、security.l1_model/l1_api_key（可空）、security.run_as_user。tools.disabled（工具禁用名单）。sandbox.default（docker/docker-strict/lxc）、sandbox.docker_socket（推荐 rootless）、sandbox.allow_rootful_docker（rootful 显式开关）、sandbox.docker_image、各档 CPU/内存默认、sandbox.allowed_images（docker-strict 白名单）、sandbox.os_enforce、sandbox.seccomp_profile_path、sandbox.network_isolate、sandbox.lxc.init_commands。cache.path/session_max_size/sync_interval/retry_max_attempts。session.max_count（默认 50）/timeout（默认 30m）。worker 与 worker_pool 与 exec_pool 各参数。task_summary.tidy_interval（默认 168h）。logging.level/module/add_source。

### CLI 配置

登录信息写 ~/.agentboster/config.json（含 url、token、username）。无需 env 变量。调试可设 AGENTBOSTER_SESSION_ID（覆盖 SessionManager id）、AGENTBOSTER_CLIENT_ID（覆盖 clientId，默认 local-cli）、AGENTBOSTER_HOME（整个家目录）、AGENTBOSTER_CODING_AGENT_DIR（agent 配置目录）、AGENTBOSTER_CODING_AGENT_SESSION_DIR（session 目录）、PI_PACKAGE_DIR（资产根）、PI_OFFLINE（跳过启动期网络操作）、AGENTBOSTER_MODEL（默认模型 override）。

## 附录 C：常用命令速查

### Web（yarn）

yarn dev（启动 Next 开发）、yarn build（next build，不强制类型或 lint）、yarn lint:check（tsc --noEmit 加 biome check，真正发版门）、yarn test 或 yarn test <path> 或 yarn test:watch <path>（Vitest）、yarn format（Biome 格式化）、yarn lint:fix（Biome 自动修复）、yarn db:generate（drizzle-kit 生成迁移）、yarn db:push（推送 schema）、yarn db:studio（可视化）、yarn db:ensure-vector（确保 pgvector 扩展）、yarn workflow:inspect（Workflow 运行可视化）、yarn build:agentd（编译 Go daemon）、yarn check:sh（shellcheck daemon 安装脚本）。

### agentd（go，在 agentd/ 目录）

go test ./...（测试）、go build -o agentd ./cmd/agentd/（构建）。运行：sudo ./agentd -config agentd.toml（普通模式）、sudo ./agentd -gen-certs -cert-dir <dir>（证书生成）、sudo ./agentd -tui（交互式安装向导，不需 root）。

### CLI（npm 或 yarn，在 cli/ 目录）

npm install 或 yarn（安装依赖，AGENTS.md 与 packageManager 规定 Yarn Classic）。npm run build 或 yarn build（tsgo 编译，顺序 ai 到 agent 到 adapter 到 coding-agent）。npm run bundle 或 yarn bundle（esbuild 单文件 CJS）。npm run package 或 yarn package（tarball 打包）。npm run check 或 yarn check（biome check 加 tsgo --noEmit，会写盘且 warning 即失败）。运行：node packages/coding-agent/dist/cli.js --help 或 ./agentboster（bundle 后）。

### IM 斜杠命令（节选）

/start（开始/配对）、/new（新会话）、/session（会话切换）、/stop（停止）、/cancel（取消当前任务）、/retry（重试）、/model（切换模型）、/approve（批准 L2）、/reject（拒绝 L2）、/compact（压缩上下文）、/help（帮助）、/memory（记忆管理）。

---

*本文档（architecture.md）完。基于 AgentBoster 仓库（Web / agentd / CLI 三部分）实际源码的逐行阅读撰写，覆盖平台总览、设计哲学、Web 层、agentd 层、CLI 层、横切关注点、部署拓扑、关键数据流、设计取舍、内部协作深层细节、端到端场景、反模式与陷阱、生态集成、版本策略、附录速查等章节。文档生成时项目处于 WIP 状态，1.0 前接口与 schema 仍可能变化。*
