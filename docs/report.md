# Agentboster vs Memoh：架构对照白皮书

> 本文基于对两个仓库实际源码的逐行核实撰写，所有结论可在引用的源码文件中复核。Agentboster 侧引用本仓库根目录（下文以 `<repo>/` 表示仓库根相对路径）；Memoh 侧引用工作区内的 `memoh/` 参考项目。本文不包含代码片段，仅以文字描述结构、归属、数据流与设计取舍。
>
> 核实基准：Agentboster 为 commit `cb19c8e`（chore(db): drop stale 0036 snapshot）对应的 working tree；Memoh 为 `memoh/` 子目录快照——该快照不带 VCS 元数据（非 git 检出），无法记录对应 commit/tag，且在本文撰写后已从工作区移除，引用其内容时以本文描述为准。代码持续演进，引用的行号与文件结构会随 commit 变化；若引用失效，按模块名/函数名/表名搜索即可重新定位。
>
> 本文不是竞品分析。Memoh 是工作区内的参考项目（`tsconfig.json` 将其 exclude），不是 Agentboster 要对线的竞品。本文目的是通过对照，把 Agentboster 自身架构选择的第一性原理讲清楚。

## 导读

本文的核心论点只有一句：**两个项目共用了一整套"AI agent 基础设施"的零件清单（沙箱、记忆、渠道、MCP、subagent、Computer Use），但因为核心抽象不同——Agentboster 是 session，Memoh 是 bot——从这一个根决策出发，在每一个工程维度上都长出了完全不同的下游结构。** 表层相似度极高，坐标系反转。

阅读路径建议：先读 §1 结论摘要和 §2 第一性原理，建立全局认识；再按需读 §3–§8 的六个维度详述（核心抽象、记忆、沙箱、工具/技能、通道与身份、对话编排）；最后读 §9 取舍总表与 §10 常见误解。若只读一节，读 §2。

术语约定：本文用"核心抽象"指 schema 中被外键引用最多、运营数据围绕它组织的实体；用"一等公民"指有独立 identity、独立生命周期、被业务模型当成主体的实体；用"连续性主语"指跨 session/重启后保持身份连续的那个对象。

---

## 1. 结论摘要

| 维度 | Agentboster | Memoh |
|---|---|---|
| 核心抽象 | **session**（一次任务/一段对话） | **bot**（一个常驻的、有人格的实体） |
| schema 引力中心 | `sessions`（6 张子表 FK） | `bots`（24 处 `REFERENCES bots(id)`） |
| 连续性主语 | **user**（跨 session 连续） | **bot**（跨 session 连续） |
| 沙箱 | per-session，**耗材**（任务结束销毁） | per-bot，**身体**（bot 一辈子一台容器） |
| 记忆归属 | `user_id` + `project_id`（关于用户的事实） | `team_id` + `bot_id`（bot 自己的阅历） |
| 工具 | **临时装配**（每次 run 重建 ToolSet） | **持久装备**（bot 拥有 MCP/plugin/skill） |
| 渠道归属 | session 的属性（`sessions.channel`） | bot 的属性（`bot_channel_configs.bot_id`） |
| 跨平台身份 | 无统一表，`/pair` 码手工绑定 | `channel_identities` 统一入站身份 |
| 部署偏好 | Vercel serverless 优先 | 自托管 / Cloud 常驻进程优先 |
| turn 持久化 | **run 重放**（Workflow DevKit `'use step'`） | **准入 + fencing**（admitTurnRun） |
| 多 agent 协作 | 重（barrier/handoff/orchestration DAG） | 轻（朴素 fan-out，上限 3 并发） |

一句话定位反差：**Agentboster 在组装"放大个人生产力的任务工作站"，Memoh 在组装"托管一群有人格的常驻 agent 的舰队平台"。**

---

## 2. 第一性原理：核心抽象反转

### 2.1 什么是"核心抽象"

在一个数据驱动的系统里，schema 的引力中心——那张被最多表外键引用、最多业务逻辑围绕它转的表——通常就是这个系统的核心抽象。它决定了"谁是主体""数据归属给谁""连续性由谁承载"。其他所有维度（记忆、沙箱、工具、身份、编排）的形态，几乎都是这个根选择的下游推论。

### 2.2 Agentboster 的引力中心：sessions

核实 `lib/core/db/schema/` 下所有 schema 文件，至少 6 张表通过外键引用 `sessions.id`，且大多是 `onDelete: 'cascade'`：

- `messages.session_id` → `sessions.id`（`lib/core/db/schema/chat.ts:48`）
- `files.session_id` → `sessions.id`（`lib/core/db/schema/files.ts:17`）
- `scheduled.session_id` → `sessions.id`（`lib/core/db/schema/scheduled.ts:15`）
- `session_memories.session_id` → `sessions.id`（`lib/core/db/schema/memory.ts:62`）
- `agent_orchestration_plans.session_id` → `sessions.id`（`lib/core/db/schema/agent-orchestration-plans.ts:47`）
- `agentd.ts` 内多张表（tasks/sandboxes/agent_memories 等）通过 `sessionId` 关联（`lib/core/db/schema/agentd.ts:209`）

**session 是所有运营数据的锚点。** 一个 session 代表"一次任务"或"一段对话"，它有起点和终点（`status: active|completed|stopped|error`），它的子表全部 cascade 删除——session 结束，它带来的消息、文件、调度、临时记忆全部清场。

### 2.3 Memoh 的引力中心：bots

核实 `db/postgres/migrations/0001_init.up.sql`，`REFERENCES bots(id)` 出现 **24 处**（grep 计数），分布在 sessions、messages、acl_rules、channel_configs、channel_routes、plugin_installations、workdir、grants、mcp_connections、storage_bindings、email_bindings、workspace_resource_limits 等十几张子表上。

**bot 是所有运营数据的锚点。** 一个 bot 代表"一个常驻实体"——它有 owner、模型、工作区、ACL、渠道绑定、插件、记忆。session（`bot_sessions`）只是 bot 跟人对话时的一个切片，挂在 bot 下面。

### 2.4 反转的后果

这个引力中心的反转，不是"两个产品想做不同的事"，而是**从不同的第一性原理出发，用同一堆零件推不出同一套架构**。下表是本文其余章节的骨架：

| 连续性由谁承载 | Agentboster：**user** | Memoh：**bot** |
|---|---|---|
| 记忆跟着谁走 | user | bot |
| 容器跟着谁走 | session（临时） | bot（终身） |
| 工具归属给谁 | session 装配 | bot 装备 |
| 渠道是谁的属性 | session | bot |
| 身份由谁识别 | session 内认领 | 跨平台统一到 bot 视角 |

每一行的"为什么"，在对应维度的章节里有展开。但在读那些细节之前，先记住这张表的左列与右列：**它们的差异不是程度，是坐标原点。**

---

## 3. 维度一：长期记忆——"跨会话的我是谁"

### 3.1 归属主语的反转

**Agentboster 的主力记忆表是 `long_term_memories`**（`lib/core/db/schema/memory.ts:81`），归属列为 `user_id`（默认 `'system'`，行 85）+ `project_id`（默认 `'__global__'` 哨兵，行 92）。记忆是**关于用户的事实**——主体是用户，记忆是"用户告诉过什么、偏好什么、决定过什么"。`memory_type` 区分 fact/preference/decision/conversation，`(user_id, project_id, key)` 三元组唯一去重（行 225）。

**Memoh 的记忆在 pgvector 独立库**（`db/pgvector/migrations/0001_init.up.sql` + `0002_team_isolation.up.sql`），主键是 `(team_id, bot_id, node_id, model_id)`，开 `FORCE ROW LEVEL SECURITY`，GUC `memoh.team_id` 既是 PK 列又是 RLS 边界。记忆是**bot 自己的阅历**——主体是 bot，记忆是"它经历过什么、学到什么"。`memory_providers.id` 由 `bots.memory_provider_id` 引用，记忆跟着 bot 走。

### 3.2 写入权限的反转

**Agentboster 允许 agent 主动写记忆**：`writeMemory` 工具（`lib/workflow/agent/tools/memories/local.ts`）支持 `stableKey` upsert；此外会话结束或 agentd 任务完成后，`lib/memory/extract.ts` 跑 LLM `generateObject` 自动判定 ADD/UPDATE/DELETE/NOOP。两条路径并存。

**Memoh 的 agent 只能 search，不能写**：`BuiltinProvider.ListTools` 仅暴露 `search_memory`，写入只发生在 `OnAfterChat` 钩子里由系统自动抽取（`internal/memory/adapters/builtin/builtin.go`）。

这个反差不是偶然，是核心抽象的必然推论：

- Agentboster 的主体是 user，agent 是 user 的工具，工具当然可以帮 user 记事。
- Memoh 的主体是 bot，bot 的记忆是"它自己的阅历"，不能让临时 spawn 出来的子 agent（`spawn_agent`）污染——所以写入权限被锁死在系统侧。

### 3.3 遗忘机制的反转

**Agentboster 有 Dream 周期**：`dream_status` 状态机（active/tentative/superseded/contradicted，`lib/core/db/schema/memory.ts`），Dream 阶段（consolidate/recombine/ratify）把被取代的事实标 `superseded` 而非删除，`recall_count`/`recall_query_hashes` 跟踪命中频率，不被 recall 的行降权。这是**模拟一个主体在整理自己的记忆**。

**Memoh 没有时间驱动的遗忘**：只有显式的 `Compact`/`DeleteAll`/`DeleteBatch`/`Rebuild` API，以及 `bot_history_message_compacts` 表——但后者是 **context-window compaction 的归档**（per-session 摘要，存 `coverage`/`anchor_start/end`/`parent_ids`/`superseded_by`，`compaction_epoch` 在历史改写时递增），跟长期记忆是两套独立机制。注意 compaction 不等于遗忘，它是"为了塞进上下文窗口而对近期对话做的摘要"，长期记忆库本身不会因 compaction 而丢条目。

### 3.4 检索

- Agentboster：混合检索（RRF 融合向量 + tsvector 关键词），叠时间衰减 `e^(-0.05×days/importance)`，再沿 `memory_edges` 图 BFS 跳 1 跳。隔离靠 `WHERE user_id = ?`（`lib/memory/search.ts`、`lib/core/db/memory/long-term.ts`）。
- Memoh：pgvector 语义 seed + 词法打分 → BFS depth-2 → fallback file-lexical。隔离靠 pgvector RLS `team_id` + 请求硬塞 `bot_id`/`scopeId`（`internal/memory/adapters/builtin/graph_runtime.go`）。`memory_providers` 支持 builtin / mem0 / openviking 三后端。

### 3.5 Agentboster 视角的取舍

Agentboster 的记忆系统有个值得注意的张力：**它的 Dream 机制（整理/遗忘/recall 衰减）是拟人化的，但这个"被拟人的主体"（user）在架构里并没有被当成一个常驻实体对待**——user 没有专属 workspace、没有 user 级连续状态机、user 的连续性只靠 `long_term_memories.user_id` 这一列隐式承载。换句话说，Agentboster 的记忆系统比它的核心抽象（session）更像"一个有人格的主体"，但没给这个主体安排对应的壳。

这是否需要修正取决于产品定位：如果坚持"个人/小团队工作站"，这个张力是无害的（user 的连续性由记忆库隐式提供就够了）；如果想往"跨设备个人助理"演进，就需要把 user 从隐式主语升格为显式实体（user 级 workspace、user 级连续状态）。**Memoh 用 bot 承载主体的做法值得借鉴的不是 RLS，而是"给连续性主语一个显式的壳"这个思路**——但 Agentboster 若要借鉴，主体应该是 user 而不是 bot，否则就背离了自己的第一性原理。

Memoh 的两个机制 Agentboster **不需要学**：(a) RLS 行级安全——Agentboster 的 user 不是互不信任的租户，WHERE 过滤足够；(b) agent 不能写记忆的限制——Agentboster 的 agent 是 user 的工具，工具帮主人记事是合理的。

---

## 4. 维度二：沙箱——"耗材 vs 身体"

### 4.1 两种世界观

这是两个项目最直观的世界观对撞：

**Agentboster 的沙箱是工具/耗材**：`Manager.CreateSession`（`subpackage/agentd/internal/agent/manager.go:172` 附近）无条件调 `m.sbManager.CreateSandbox(sbSpec)` 给这个 session 建沙箱；`CloseSession`（行 335 附近）调 `DestroySandboxForce`；worker dispatcher 在 session close/archive 时强制销毁（`subpackage/agentd/internal/worker/dispatcher.go`）。docker 类型直接 `docker rm -f`。有 `sandbox/reaper.go` 专门清 kill -9 残留的孤儿容器。**沙箱是为这次任务服务的临时工位，任务结束工位回收。**

**Memoh 的沙箱是住所/身体**：`ContainerPrefix = "workspace-"`（`internal/workspace/manager.go:38`），`resolveContainerID` 返回 `"workspace-" + botID`（行 174），同一 bot 所有 session/对话复用同一容器 ID。**只在删 bot 时才销毁**（`bots.Service.Delete` → `CleanupBotContainer`）。session 结束容器继续活；甚至容器被销毁，只要 bot 还在，`recoverOrphanedSnapshot`/`restorePreservedIntoSnapshot` 会把 `/data` 找回来重建。启动时 `ReconcileContainers` 不是清理而是**唤醒**——把所有 `auto_start` 的容器拉起来。这就是 README "always on, even when your laptop is closed" 的工程实现。

### 4.2 持久化的默认值相反

| | Agentboster | Memoh |
|---|---|---|
| 默认沙箱类型 | `docker`（非持久，`docker rm -f`） | 持久（容器可写层 + 可 `preserveData` 导出 `/data`） |
| 持久是特例吗 | **是**，需显式 `persistent=true` 升级到 LXC | **不是**，持久是默认 |
| rootfs 跨会话保留 | 仅 LXC 模式 | 默认保留，可 snapshot/restore |

Agentboster 的 `agent_sandboxes.persistent` 字段（`lib/core/db/schema/agentd.ts`）+ spec 的 `Persistent` 标记，控制是否用 LXC 保留 rootfs 跨会话/重启；高风险命令路由到 `docker-strict`，需持久的 profile（git/npm/browser_）路由到 `lxc`。**持久是例外，由工具 profile 显式触发。** Memoh 反过来，持久是默认，销毁才是例外。

### 4.3 与核心抽象的咬合

这不是两个团队碰巧做了不同选择，而是核心抽象的强制要求：

- session-centric：session 是临时工位 → 工位里的沙箱自然也是临时的 → 持久是需特殊声明的例外。
- bot-centric：bot 是常驻居民 → 居民的住所自然也是常驻的 → 销毁是需显式 bot 删除才触发的例外。

### 4.4 Agentboster 视角的取舍

Agentboster 的"沙箱即耗材"模型有一个已落地的优点和一个潜在缺口：

- **优点：沙箱泄漏面小**。每次任务起干净环境、结束即销毁，意味着前一个任务的副作用（残留文件、浏览器 cookie、装过的包）不会污染下一个任务。这对编码/自动化场景（每次任务可能在不同 repo / 不同项目）是正确的默认。
- **缺口：跨会话连续工作流受损**。如果一个用户希望"我的 agent 一直在同一个工作环境里接着干"（比如长期运行的项目仓库、需要保持登录态的浏览器会话），Agentboster 目前只能靠 LXC persistent 模式或 `workspaces.project_id` 绑定来近似，不如 Memoh 的 per-bot 容器自然。

**取舍建议**：不需要照搬 Memoh 的 per-bot 模型（那是 bot-centric 的产物），但 `workspaces.project_id`（`lib/core/db/schema/agentd.ts`）这个"项目级持久工作区"概念是被低估的——它已经在 schema 里了，只是在 session-centric 的叙事里被埋没。如果要在不放弃 session-centric 的前提下补"连续工作流"这个缺口，**把 workspace（而不是 bot）升格为可选的连续性载体**，比引入 bot 概念更符合 Agentboster 的第一性原理。`project_id` 在记忆表里已经是二级作用域，让沙箱也跟着 `project_id` 走，是一个低成本的对齐。

---

## 5. 维度三：工具/技能——"装配 vs 装备"

### 5.1 两种 ownership 模型

**Agentboster = 装配（assemble）**：`buildAgentTools(config, sessionId, options)`（`lib/workflow/agent/tools/index.ts`）每次 workflow run 重建一遍 ToolSet，叠加 MCP 工具，包一层 `createResilientToolSet`。工具定义是 `defineBuildInTool({...})`（`lib/workflow/agent/tools/define.ts`），factory 返回 AI SDK 的 `tool({description, inputSchema, execute})`。**工具不属于任何人，是按需取用的零件，每次任务临时组装。**

**Memoh = 装备（equip）**：所有 `ToolProvider` 在 fx 启动时全局注册一次（`cmd/internal/core/providers.go` 的 `provideToolProviders`），per-session 选择发生在每次模型调用时的 `assembleTools`——provider 内部根据 `SessionContext`（`IsSubagent`/`CanRequestUserInput`/`WorkspaceTargetID`/`Skills` 等）自行过滤。但"这个 bot 装了哪些能力"是 bot 的一生产权：MCP 连接 per-bot（`mcp_connections.bot_id`），plugin 安装 per-bot（`bot_plugin_installations.bot_id`），skill 落在 bot workspace 的 `/data/skills`。

### 5.2 MCP 连接归属

这是工具维度最锐利的反差：

- Agentboster：MCP 连接由 **Web 进程**持有，agentd 侧只有一个 `mcp_call` 工具，daemon 通过 HTTP POST 反向调 Web 的 `/api/agentd/v1/tools/mcp-exec` 执行。MCP 连接是实例级配置（`config.mcp`），不归属任何 session/bot/user。
- Memoh：MCP 连接 **per-bot**（`mcp_connections.bot_id NOT NULL`，UNIQUE(bot_id, name)），三种 type（stdio/http/sse），`tools_cache` 缓存探测到的工具，OAuth token 走 `mcp_oauth_tokens`。Plugin 创建的连接还带 `managed_by_plugin_installation_id` 反向关联。

### 5.3 Plugin / Skill 系统

- Agentboster 有两层"skills"：`.agents/skills/`（ai-sdk/workflow/bug-hunter 等）是**给开发者用的提示词包**，不被运行时加载；运行时 skill 在 Blob+KV（`types/skills/` + `lib/core/blob/skills`），由 `runSkill`/`listSkills` 工具操作，是"可执行插件"。**没有 plugin 市场概念。**
- Memoh 有 **Supermarket**（`apps/web/src/pages/supermarket/`，远端 `[supermarket] base_url`），plugin manifest 描述 `MCPResource`/`SkillResource`/`AuthRequirement`，安装落地为 `bot_plugin_installations` 行，并自动创建对应的 `mcp_connections`。skill 是 workspace 容器内 `/data/skills` 下的文件，通过 `list_skills`/`use_skill` 懒加载给模型。

### 5.4 执行位置分布

- Agentboster：**三平面**——Web workflow sandbox（`'use step'` 上下文，跑 read/write/bash 的 TS 实现、memory、MCP builtin、subAgent 内层循环）/ agentd 沙箱（exec/read/write/edit/grep/glob/git/browser/desktop/lsp/codeact）/ CLI host（`local_*` 工具，仅 `source.type==='cli'` 注册）。
- Memoh：**两平面**——Go server 进程内（message/contacts/schedule/memory/web/email/spawn/federation/history/tts/transcribe/ask_user）/ workspace 容器内通过 bridge gRPC（read/write/edit/exec/browser/computer/skill/image_gen/video_gen，落盘到 `/data`）。

### 5.5 Agentboster 视角的取舍

"装配 vs 装备"这一节最值得 Agentboster 团队想清楚的一点是：**Supermarket 这种"给某个主体装插件"的市场，在 Agentboster 里做不出来——因为没有一个"持久拥有装备的主体"让插件挂上去。** 工具是每次 run 临时装配的零件，不是某个主体的装备。这本身不是缺陷，是第一性原理的必然结果。

但是否需要某种形式的"能力持久化"是另一个问题。当前 Agentboster 的 MCP 连接是实例级（`config.mcp`），所有 session 共享同一套 MCP 配置；如果未来需要"不同项目/不同用户接不同 MCP"，需要一个归属层。两个选项：

1. **沿用 session-centric**：MCP 配置按 `(user_id, project_id)` 分片（跟 `long_term_memories` 的归属对齐），不引入新主体。**推荐**，因为它跟核心抽象自洽。
2. **引入类 bot 概念**：不建议。会复制 Memoh 的模型但缺少 bot-centric 的其他配套（per-bot 容器、per-bot ACL），结果是四不像。

`workspaces.project_id` 再次成为自然的归属键——`project_id` 已经是记忆和沙箱的二级作用域，让 MCP 配置也跟着它走，体系就一致了。

---

## 6. 维度四：通道与身份——"谁在跟谁说话"

### 6.1 渠道是谁的属性

- **Agentboster：渠道是 session 的属性**（`sessions.channel`，`lib/core/db/schema/chat.ts`，值为 web / adapter 名 / `cli:<clientId>` / scheduled）。`externalThreadId` 用 `buildExternalThreadId(source)` = `<adapter>:<threadId>` 跟外部对话 1:1。渠道配置（bot token、`allowed_author_ids`）是**全局 KV config**（`types/config/channels.ts`），不是任何实体的属性。
- **Memoh：渠道是 bot 的属性**（`bot_channel_configs(bot_id, channel_type)` UNIQUE，存 credentials/external_identity/routing/capabilities）。webhook 按 `config_id` 路由到对应 bot 的配置。`bot_channel_routes` 把 `(bot_id, channel_type, external_conversation_id, external_thread_id)` upsert 成一行，`active_session_id` 反向指向当前 session（route↔session 是 N:1，同一外部对话历史可有多个 session，但任一时刻只 active 一个）。

### 6.2 进程拓扑

- Agentboster：**adapter 是 Web 进程内的库**。9 个 adapter（telegram/discord/slack/teams/gchat/feishu/qq/wecom/dingtalk），前 5 个用 `@chat-adapter/*` v4.33 npm 库，后 4 个是手写 shim。全部跑在 Web 进程内，无独立服务。webhook 入口 `/api/bot/[authSecret]/[adapter]/callback`，`AUTH_SECRET` 嵌路径是唯一鉴权（常量时间比对，等价于 unguessable URL）。
- Memoh：**Channel 是独立进程**（`cmd/channel`），与 Server 双向 gRPC，靠 `internal_rpc.shared_secret` 鉴权（`x-memoh-internal-token` metadata，常量时间比较）。Channel 进程跑 webhook/IM 收发 + Runtime RPC server；Agent turn 在 Server 进程跑，通过 RPC 回调。13 个 adapter（多了 matrix/line/misskey/weixin/wechatoa/local）。Server 也可嵌入 channel runtime 跑 all-in-one（secret 为空时）。

### 6.3 跨平台身份

这是身份维度最根本的反差：

- **Agentboster 没有统一身份表**。schema 下无 `channel_identities`/`user_channel_bindings`。`im_accounts` 表按 `(adapter, imUserId)` + `(clawlessUserId, adapter)` 唯一索引——一个用户每个 adapter 只能绑一个 IM 账号，但同一个人在 discord 和 slack **不会被自动识别为同一身份**，除非两边都 `/pair <code>` 到同一 `clawlessUserId`（`lib/chat/commands/pair.ts`，6 位码 KV 存 15min）。配对靠手工。
- **Memoh 有 `channel_identities` 统一入站身份**（`(channel_type, channel_subject_id)` UNIQUE，`user_id` 可空）+ `user_channel_identity_bindings`（user ↔ channel_identity）做账户级绑定 + `user_channel_bindings`（`(user_id, channel_type)` UNIQUE，config JSONB）做出站投递配置。三者职责正交：identity 管收信主体，binding 管发信通道，账户绑定管跨平台权限流动。

### 6.4 ACL

- Agentboster：`allowed_author_ids` 白名单 + `im_accounts` 配对，两者皆空时 open mode 全放。简单二元判断。
- Memoh：`bot_acl_rules.action='chat.trigger'` 是 **source-aware** ACL，规则可按 `channel_identity_id`/`subject_channel_type`/source scope（conversation_type/conversation_id/thread_id）收窄，effect allow/deny；无匹配回退 `bots.acl_default_effect`（黑/白名单 mode）。owner 直接 bypass ACL。

### 6.5 Agentboster 视角的取舍

为什么 Memoh 必须有跨平台身份而 Agentboster 不需要？还是回到核心抽象：

- Memoh 的 bot 是"一个有人格的常驻实体，多个渠道都是它的嘴"——所以"谁在跟这个 bot 说话"必须跨平台统一识别，否则 bot 记不住"昨天在 telegram 跟我聊的人今天在 discord 又来了"。统一身份是 bot-centric 的刚需。
- Agentboster 的 session 是"一次任务"，谁发起的就是谁，session 内认领身份足够；跨平台追身份对"做完即走"的任务模型价值不大。

**这是 Agentboster 可以理直气壮不补的一块。** 但有两个边界情形要注意：

1. 若 Agentboster 想做"长期个人助理"（跨 session 记住"这个人"），目前的 `long_term_memories.user_id` 隐式承载了跨 session 身份——只要 IM 用户都 `/pair` 到同一 user_id，记忆就连续。这套机制已经够用，不需要再加 `channel_identities` 表。
2. 若要给"谁能用哪个渠道"做细粒度控制（比如某个 IM 群只能触发特定 agent），Memoh 的 `bot_acl_rules` source-aware 模型比 Agentboster 的 `allowed_author_ids` 白名单表达力强很多。但这是 ACL 表达力问题，不是身份模型问题——Agentboster 可以在 session 层加 source-aware 规则，不需要引入 bot。

进程拓扑上，Memoh 的独立 Channel 进程（`cmd/channel`）是为了 IM 长连接密集场景做水平扩展——Agentboster 的 Web 进程内 adapter 在 IM 渠道少时更简单，但若 IM 渠道数或并发上涨，Web 进程会承载 webhook 解密/验签 + IM 流排空的压力。这是一个容量触发的演进方向，不是定位问题。

---

## 7. 维度五：对话轮次编排——"durable run vs durable admission"

### 7.1 入口与实例

- Agentboster：Web/CLI/IM 三路消息最终汇入 `chatMain`（`lib/chat/index.ts`）。`chatMain` 二选一：session 有 active run 则 `resumeWithMessage`（往 instructionHook 推消息）；否则 `startWorkflow` → `chatWorkflow`。每个 run `new DurableAgent({...})`（`lib/workflow/agent/index.ts`），**DurableAgent 是 per-run 的**，不是 per-session——一个 session 串多个 run（`sessions.workflowRunId` 指向当前活跃 run），run 结束实例即弃。
- Memoh：IM/Web 入口在 `ChannelInboundProcessor.HandleInbound`（身份解析 → ACL → slash 拦截 → route 解析 → session 解析 → 构造 `turn.StartTurnCommand`），调 `turnSvc.StartTurn`。`application.Service` 是**实现 `turn.Service` 接口的单例**（`var _ turn.Service = (*Service)(nil)`），在 Go server 进程里跑，多 bot 多 session 并发由 `sessionruntime.Manager` 做单飞准入（同一 thread 同时只一个 run，后到拿 `ErrSessionBusy`，靠平台 webhook 重投 + IdempotencyKey 重新入场）。

### 7.2 持久化哲学的精致反差

这是编排维度最值得细看的一对：

- **Agentboster = 持久化 run 本身**：关键写库函数都标 `'use step'`（`lib/workflow/agent/steps/persist.ts`），由 Workflow DevKit 当作可重放、重启可恢复的 durable step：`initializeRunSessionStep`、`persistStepDeltaAndUsageStep`、`compactAndPersistSummaryStep`、`finalizeRunStep`。流式 chunk 也 durable（`sender/writers.ts` 全是 `'use step'` + `getWritable`）。**重启后 Queue Service 重放 step 恢复**，chunk 历史也存存储层，`getReadable({startIndex:0})` 全量回放。durable 的单位是 **run**。
- **Memoh = 持久化准入 + 进程内运行**：`admitTurnRun`（`internal/agent/application/turn_admission.go`）做 durable admission + fencing token，保证"同一 thread 同时只一个 run"。但 **run 本身是进程内 goroutine，不重放**。durable 的单位是 **准入决策**，不是 run 内部。fencing token 防止"失主租约的 run 写库"。

### 7.3 这两种选择咬合各自的部署模型

不是两个团队碰巧选了不同方案，是部署模型强制要求的：

- Agentboster 假设 **run 会中断**（Vercel serverless，函数实例可能蒸发 mid-run），所以必须把 run 做成可重放的——否则一次 Vercel 冷启动就丢一次任务。
- Memoh 假设 **Server 进程常驻**（自托管 Docker / Memoh Cloud VM），run 中断 = 进程崩，重启后靠 fencing token 防双写就够了，不需要重放 run 内部。

### 7.4 工具循环

- Agentboster：工具循环在 `DurableAgent.stream(...)` 内部（AI SDK step 机制），不是手写 for 循环；`maxSteps = max(1, config.autonomy.max_steps ?? DEFAULT_MAIN_MAX_STEPS)`；额外 `ToolLoopGuard`（`lib/workflow/agent/tool-loop-guard.ts`）在 `onStepFinish` 观察四类异常（malformed/failure/all_error/cycle），阈值默认 3/3/8/3。
- Memoh：委托给 `twilight-ai/sdk` 的 `GenerateTextResult`/`StreamText`，配 `sdk.WithMaxSteps(-1)`（无内置上限），由 memoh 自己的 loop guard 终止——`TextLoopGuard`（streak 阈值 3，最少新 gram 8）+ `ToolLoopGuard`（repeat 阈值 5，先警告 `ToolLoopWarningsBeforeAbort` 次再 abort）。

### 7.5 后台/异步任务

- Agentboster：原 `after-response.ts` 已废弃（fire-and-forget 化后没有 host 可靠排空），现替代是 `chatWorkflow` 在 `writeStreamClose()` 之后 `start(postRunCleanupWorkflow, [...])` 另起一个独立 workflow run（只等 runId 解析），跑 `extractMemoriesFromSession` + `maybeDistillSkillFromSession` + `cleanupResourcesStep`（`lib/workflow/agent/post-run-cleanup.ts`）。
- Memoh：每轮结束 `go maybeCompact`（异步 goroutine，soft 50% 阈值后台压缩）；同步压缩在 `resolve` 里 `syncCompactionShouldRun`（compactable tokens ≥ 75% context window）触发 `RunCompactionSync` 阻塞本轮。

### 7.6 审批/插话

- Agentboster：`ask_question`（L2 阻塞问用户）。
- Memoh：`decision` 包把"运行中需要外界裁决"抽象成可暂停/恢复的控制点——`approval`（PreToolUse 类工具批准，`ToolApprovalHandler` 在每次 tool call 前调 `toolApproval.EvaluatePolicy`，必要时 `CreatePending` 写 pending 行返回 `DecisionDeferred`，SDK 暂停 step；用户 `RespondToolApproval` 恢复，默认 10min 超时自动 reject）+ `input`（ask_user 问答，`userinput.CreatePending` 发 `EventUserInputRequest`，非交互 session 直接 reject）。

### 7.7 Agentboster 视角的取舍

这是 Agentboster **不需要焦虑的一块**——它的 durable run 模型在 serverless 部署下是正确的，`'use step'` + Workflow DevKit 是对 Vercel 环境的诚实回应。Memoh 的 durable admission 模型在常驻进程下也是正确的，两边各自自洽。

唯一值得借鉴的是 Memoh 的 `decision` 包抽象：把"工具批准"和"问用户"统一成"可暂停/恢复的控制点 + pending 行 + waiter"这套机制，表达力比 Agentboster 当前的 L2 单点阻塞强。如果 Agentboster 未来要扩展更多类型的"运行中插话"（比如等待外部 webhook 回调、等待定时器、等待另一个 session 的结果），把 `ask_question` 抽象成统一的 decision 控制点是合理的演进方向——这跟核心抽象无关，是编排层的局部改进。

---

## 8. 维度六：多 agent 协作——"临时社会 vs 简单 fan-out"

### 8.1 协作复杂度的反差

这一维度有一个反直觉的发现：**没有 bot 这个常驻锚点的 Agentboster，反而把多 agent 协作做得比 Memoh 重得多。**

- Agentboster：三类持久化协作原语——`agentBarriers`（all/quorum/first_ok/first_fail 屏障，跨进程同步）、`agentHandoffs`（跨 session 命名邮箱，put/take/peek）、`agentOrchestrationPlans`（用户编排的 DAG → 主 agent 转成 wave 顺序 spawn）。主 agent（leader）通过 `subAgent` 工具 `run`/`spawn_async`/`spawn` 扇出，子 agent 无 `subAgent`（单向不递归）。`autonomy.team_leader` 是 prompt 层提示。
- Memoh：朴素 leader-worker fan-out，`spawn_agent` 派生子 agent，上限 3 并发/会话（`MaxRunningSpawnTasks=3`），子 agent 不能再 spawn，不跨 bot，**没有 barrier/handoff/DAG**。

### 8.2 为什么重的反而没有常驻主体

这个反差的原因正是核心抽象：

- Agentboster 没有 bot 这个常驻实体来承载"谁是谁"，所以**它必须在 session 内部重建一个临时社会**——用 barrier/handoff/DAG 让 agent 们在那几十秒/几分钟里假装是一个团队。协作复杂度被下沉到任务内部，因为没有外部（bot 级）的稳定身份可以依托。
- Memoh 有 bot 这个稳定锚点，bot 本身就是"社会的一员"（一个 fleet 里的常驻公民），它的 subagent 只需要是最朴素的 fan-out——因为"身份"和"记忆"已经由 bot 这个稳定壳提供了，不需要在任务内部临时搭建。

### 8.3 Agentboster 视角的取舍

Agentboster 的 barrier/handoff/orchestration plan 是它在 session-centric 约束下做出的**精巧补偿**——用任务内的临时结构弥补任务外的常驻主体缺失。这套机制的工程价值是真实的（它是 memoh 做不到的能力），但有一个风险要注意：**别把"任务内协作"误当成"团队级协作"来营销或演进。**

- 任务内协作（barrier/handoff）：解决"一个复杂任务怎么拆给多个 agent 同时干"。✅ Agentboster 强项。
- 团队级协作（多用户/多 agent 长期协同）：解决"几个人和几个 agent 怎么在一个项目里持续协作"。这不是 barrier/handoff 能解决的，它需要的是连续性主体（user 或 workspace），而不是更复杂的任务内原语。

如果 Agentboster 想往"团队协作"演进，**正确的方向不是给 barrier/handoff 加更多特性，而是把 workspace/project 升格为协作主体**（多人共享一个 project，多 agent 在同一 project 下持续工作）——这跟 §4.4、§5.5 的建议一致，都指向 `project_id` 这个被低估的键。

---

## 9. 取舍总表

下表把六个维度的核心选择、背后的第一性原理、以及 Agentboster 视角的建议收拢到一处：

| 维度 | Agentboster 选择 | 第一性原理 | Memoh 选择 | Agentboster 要不要学 |
|---|---|---|---|---|
| 核心抽象 | session | 任务为中心 | bot | ❌ 不学，根决策 |
| 记忆归属 | user + project | user 是连续性主语 | team + bot | ⚠️ 学"给主语一个显式壳"的思路，但主体应是 user/project |
| 记忆写入权限 | agent 可写 | agent 是 user 的工具 | agent 不能写 | ❌ 不学 |
| 沙箱 | per-session，临时 | 任务工位 | per-bot，终身 | ⚠️ 不学 per-bot，但可升格 workspace/project 为可选连续载体 |
| 工具 | 临时装配 | 任务级零件 | 持久装备 | ⚠️ 若做能力持久化，按 project_id 分片，不引入 bot |
| MCP 归属 | 实例级 | 全局共享 | per-bot | ⚠️ 同上，按 project_id 分片 |
| 渠道归属 | session 属性 | 任务来源标签 | bot 属性 | ❌ 不学 |
| 跨平台身份 | `/pair` 手工绑定 | 任务内认领 | channel_identities 统一 | ❌ 不学，user_id 已够 |
| ACL | 白名单 | 简单二元 | source-aware rules | ⚠️ 表达力可借鉴，加在 session 层 |
| 部署 | serverless 优先 | run 会中断 | 常驻进程优先 | ❌ 不学，各自自洽 |
| turn 持久化 | run 重放 | serverless 刚需 | admission + fencing | ❌ 不学，各自自洽 |
| 审批/插话 | L2 单点 | — | decision 统一抽象 | ✅ 可学，编排层局部改进 |
| 多 agent | barrier/handoff/DAG | 补偿无 bot 锚点 | 朴素 fan-out | ❌ 这是 Agentboster 强项 |
| 团队协作 | 未做 | — | singleton team 占位 | ⚠️ 若做，主体应是 project，不是 team |

**贯穿全表的一条主线**：Agentboster 要坚守的是 session-centric + user/project 双层连续性。Memoh 的许多设计（per-bot 容器、per-bot MCP、channel_identities、RLS）是 bot-centric 的配套，单独搬过来会跟 Agentboster 的核心抽象打架；但"给连续性主语一个显式壳"这个**思路**是普适的，Agentboster 的主语是 user/project，应该让 user/project（而不是 bot）成为显式的连续性载体。

---

## 10. 常见误解

### 10.1 "两边都是 multi-agent 平台，所以是同类"

**误**。两边的 "multi" 指的不是同一件事：

- Agentboster 的 multi = 任务内 fan-out（一个 session 内多个 agent 协作）。
- Memoh 的 multi = 跨人 fleet（一个实例上多个 bot 给多个用户用）。

这俩 "multi" 在概念空间里几乎不相交。前者是"一次任务的合作"，后者是"一群实体的并存"。

### 10.2 "Agentboster 的 agent 是临时的，Memoh 的 agent 是常驻的"

**部分误**。两边的 sub-agent 都是临时的、per-task 生灭的、都不能递归 spawn。真正的常驻实体：

- Agentboster：**没有常驻 agent 实体**。连续性由 user（隐式）和 session（显式但临时）承载。
- Memoh：**bot 是常驻实体**（注意是 bot 不是 agent）。bot 的 sub-agent 跟 Agentboster 的 sub-agent 一样临时。

准确说法是：**两边的 agent 都临时，区别在"agent 的容器"——Agentboster 的容器是 session（临时），Memoh 的容器是 bot（常驻）。**

### 10.3 "Memoh 有 team 隔离，Agentboster 没有，所以 Agentboster 落后"

**误**。Memoh 的 `team/` 包当前是 **singleton**（固定 UUID `DefaultTeamID`，`internal/team/id.go`），RLS 框架搭好了但 team 还只有一个。两家在"团队隔离"这件事上的实际状态都是"没真正展开"，只是 Memoh 把脚手架先立起来了。

而且（§2.4 已述）团队隔离是 bot-centric 的刚需（多 bot fleet 跨人时必须有团队墙），不是 session-centric 的刚需。Agentboster 没有这个脚手架不是落后，是它的产品形态不需要——强行加等于悄悄把定位挪去跟 Memoh 同台竞争。

### 10.4 "Agentboster 应该照着 Memoh 补 per-user key / 配额 / team 隔离"

**视目标而定，通常不需要**。这三样是 fleet 模式（多个 bot 给多个互不信任的用户用）的配套。Agentboster 的甜点区（个人/小团队工作站，围绕 user/project 的 session 协作）不需要它们：

- per-user provider key：几个人共用实例时无意义；要做 SaaS 卖号才需要。
- 配额：同上。
- team 隔离：熟人协作不需要墙；跨公司/陌生人混用才需要。

如果 Agentboster 未来真要做"多团队 SaaS"，那等于换赛道，需要补的不只是这三样，而是整套多租户基础设施——那是重写，不是借鉴。

---

## 附录 A：基础事实对照

> 以下为两个项目的浅层事实，供快速参考。深层架构差异见 §3–§8。

### A.1 定位与许可证

| | Agentboster | Memoh |
|---|---|---|
| 一句话定位 | 多端协作的 AI 平台（Web + agentd + CLI） | 给每个 AI agent 一台云电脑的开源多智能体平台 |
| 许可证 | MIT | AGPLv3 |
| 部署形态 | Vercel / 自托管 Docker | 自托管 Docker / Memoh Cloud（路线图） |
| 产品形态 | 个人/小团队 AI 工作站 | 多 bot / 多用户舰队平台 |

### A.2 技术栈

| | Agentboster | Memoh |
|---|---|---|
| 主体语言 | TypeScript 6（Web/CLI）+ Go（agentd/dbushelper） | Go（后端）+ TypeScript/Vue（前端）+ Rust（a11y） |
| Web 框架 | Next.js 15.5 + React 19 | Vue 3 + Vite 8 |
| 桌面 | Tauri（Desktop）/ pi 框架（CLI） | Electron 34 + electron-vite |
| ORM | Drizzle | sqlc |
| AI SDK | Vercel AI SDK | 自研 Twilight AI（Go） |
| 向量库 | pgvector | pgvector（内置）/ Qdrant（mem0/openviking 后端） |
| 包管理 | Yarn（根）+ 独立子项目 | pnpm monorepo + Go modules |

### A.3 数据库引力中心计数

| | Agentboster | Memoh |
|---|---|---|
| 核心表 | `sessions` | `bots` |
| 外键引用数（核实） | 6 张子表 FK→sessions.id | 24 处 `REFERENCES bots(id)` |

（Agentboster 计数基于 `lib/core/db/schema/*.ts` 的 `.references(() => sessions.id)`；Memoh 计数基于 `db/postgres/migrations/0001_init.up.sql` 的 `REFERENCES bots(id)` grep。）

---

## 附录 B：术语映射

为方便对照两项目的概念，下表列出等价/近似术语：

| 概念 | Agentboster | Memoh | 说明 |
|---|---|---|---|
| 核心实体 | session | bot | 引力中心，§2 |
| 临时执行单元 | agent（sub-agent） | agent（spawn_agent） | 两边都临时，§10.2 |
| 工作区 | workspace（project_id 绑定） | workspace（per-bot 容器） | Agentboster 是 project 级，Memoh 是 bot 级 |
| 长期记忆 | long_term_memories | memory_node_embeddings（pgvector） | §3 |
| 任务内同步 | agent_barriers | （无） | Agentboster 独有，§8 |
| 任务内邮箱 | agent_handoffs | （无） | Agentboster 独有 |
| MCP 连接 | config.mcp（实例级） | mcp_connections（per-bot） | §5.2 |
| 渠道配置 | channels.*（全局 KV） | bot_channel_configs（per-bot） | §6.1 |
| 跨平台身份 | im_accounts + /pair | channel_identities | §6.3 |
| ACL | allowed_author_ids | bot_acl_rules（source-aware） | §6.4 |
| turn 持久化 | Workflow 'use step' | admitTurnRun + fencing | §7.2 |
| 审批 | L2 ask_question | decision 包（approval + input） | §7.6 |
| 部署模型 | serverless 优先 | 常驻进程优先 | §7.3 |
