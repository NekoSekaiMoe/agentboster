# AgentBoster 千人级承载力评估

> 基于对实际源码的逐行核实(非 `docs/architecture.md`,该文档已过时)。
> 核实日期对应 commit `82e3d637`(含 L2 队列双 Bug 修复)。
> 所有结论附带 `文件:行号` 引用,可复核。

## 摘要(TL;DR)

plan.md(Update2 / Update3 / Update4)提出了几组关于"支撑上千人"的架构担忧。核实结论:

| plan.md 论点 | 核实结果 | 严重度 |
|---|---|---|
| Update2-1 SSE 长连接占云函数 | ✅ 属实(方向对) | P1(Vercel)/ 可接受(自托管) |
| Update2-2 看门狗 DB DDoS(5s/100QPS) | ❌ 误判(瞄准错对象) | 实际是低效,非 DDoS |
| Update2-3 vm.Script CPU 爆炸 | ❌ 误判 | 编译有 LRU 缓存 |
| Update3-1 Vercel 不适合大团队 | ✅ 属实 | 架构性,需权衡 |
| Update3-2 自托管轻松挂万流 | ⚠️ 过于乐观 | 方向对,数字夸大 |
| Update4 Bug1 全局锁 | ✅ 已修复(`82e3d637`) | — |
| Update4 Bug2 幽灵决议 | ✅ 已修复(`82e3d637`) | — |
| **(plan 漏掉)主聊天路由缺 `maxDuration`** | ✅ 属实 | **P0** |

**最重要的发现是 plan.md 漏掉的那条**:三个 SSE 路由(主 Web 聊天、CLI 聊天、重连端点)全部没有 `export const maxDuration`,而 IM webhook 路由却显式设了 300s。这是一个比 plan 所有论点都更致命、且修复成本极低的配置缺陷。

---

## 1. SSE 长连接链路(Update2-1 / Update3)

### 1.1 真实数据流

```
浏览器 useChat
  │ POST /app/(chat)/api/ai
  ▼
app/(chat)/api/ai/route.ts :: POST()            [:108]
  ├─ zod 校验 + cookies 鉴权
  └─ await chatMain({...}, {source:{type:'web'}})   [:165]
        │  (包了 60s 超时 race,只管 workflow 启动阶段 [:155])
        ▼
lib/chat/index.ts :: chatMain()
  ├─ ensureMessageSession / upsertUserMessage
  ├─ 有活跃 run → resumeWithMessage(不 start 新 run)
  └─ 否则 startWorkflow(...)
        ▼
lib/workflow/agent/dispatch.ts :: startWorkflow()   [:114]
  ├─ start(chatWorkflow, [...])   ← Workflow SDK,状态持久化到 Postgres
  ├─ updateSession(workflowRunId, status:'active')
  ├─ run.readable.tee() → primaryStream + drainStream   [:172]
  └─ return { runId, readable: primaryStream }
        ▼
route.ts: createUIMessageStreamResponse({stream: readable})   [:228-256]
```

**关键事实**:`createUIMessageStreamResponse` 返回的 Response,其 body 是 workflow run 的 readable 流。**直到 workflow run 完成或出错、readable 关闭,HTTP 响应才结束。**

### 1.2 工具执行期间的连接状态

Workflow SDK(`workflow@4.6.0` = Vercel Workflow DevKit)把 workflow 函数体编译成 durable step,状态持久化到 Postgres(`@workflow/world`)。当 agentd 执行耗时工具(npm install 数分钟):

- workflow 在该 step 处 durable sleep(状态落 DB),readable 流**暂停产出 chunk 但不关闭**。
- HTTP 连接**仍然打开**,但**无新数据流出**——空闲挂起(idle pending)。
- 直到工具结果返回 → step resume → 继续推 chunk。

> ✅ **证实 plan.md Update2-1 的核心观察**:HTTP 请求在整个 Agent 思考 + 工具执行期间一直挂起,直到 workflow run 完成。

### 1.3 Workflow 是 durable 的(可恢复)

这是最关键的一点,plan.md 没说清楚:

- `start()` 把 workflow 注册为 durable job,状态落 Postgres。`Run.readable` 是从持久化流后端读出的 view,**不是进程内 buffer**。
- `getRun(runId)` 可从**任意进程/请求**通过 runId 重新拿 readable(`@workflow/core/dist/runtime/run.d.ts`,带 `getTailIndex()` / `startIndex` 重连语义)。
- `app/(chat)/api/ai/[runId]/stream/route.ts` 是重连端点:HTTP 断开后可 `GET /api/ai/[runId]/stream` 重新订阅。
- `chatMain` 对活跃 run 走 `resumeWithMessage` 而非 `startWorkflow`。

> **HTTP 连接中途断了,workflow 继续在后台跑**(SDK 执行器与 HTTP 请求解耦,状态在 Postgres)。客户端可重连。HTTP 断开只损失"这条连接上的实时流式 chunk",不损失执行状态。

**但有个未完全确认的前提**:SDK 的 step runtime 驱动进程归属。在 Vercel Serverless 上,step 执行通常由首次 `start()` 的函数实例在 keep-alive 期间驱动;若该实例被 maxDuration 杀,下一轮 step 靠请求触发 resume 或 SDK 内置 reenqueue 续命。这部分的健壮性取决于 `@workflow/core` 的 deployment/world 配置。

---

## 2. 【P0】主聊天路由缺 `maxDuration`(plan 漏掉的真问题)

### 2.1 事实

逐文件核查(`grep maxDuration app/`):

| 文件 | maxDuration | 说明 |
|---|---|---|
| `app/(chat)/api/ai/route.ts`(主聊天) | **无** ❌ | 走默认 |
| `app/api/cli/chat/route.ts`(CLI 聊天) | **无** ❌ | 走默认 |
| `app/(chat)/api/ai/[runId]/stream/route.ts`(重连) | **无** ❌ | 走默认 |
| `app/api/internal/im-stream/route.ts`(IM 流) | **无** ❌ | 靠 body 保活 |
| `app/api/bot/[authSecret]/[adapter]/callback/route.ts` | `300` ✅ | IM webhook |
| `app/api/bot/[authSecret]/schedule/route.ts` | `300` ✅ | 调度 |
| `app/api/cron/*` | 60–300 | cron |

### 2.2 后果

在 Vercel 上:
- **Hobby**:函数默认 10s 硬超时被杀 → workflow readable 流在 `/api/ai` 这一侧被截断,客户端 SSE 提前结束。
- **Pro**:默认 60s(Fluid compute 下需显式 `export const maxDuration = 300` 才到 300s)。当前没声明 → **任何超过 60s 的 workflow(npm install、长 tool 循环)必然截断 HTTP 流**。

虽然 workflow 本身 durable 仍可后台继续,但用户体验是"消息发出去然后断了",需靠前端重连 `/api/ai/[runId]/stream`。

### 2.3 这是比 plan 所有论点都优先的修复项

- 修复成本:每个文件加一行 `export const maxDuration = 300;`。
- 收益:立刻让 Vercel 上的长任务可流式输出到 5 分钟。
- IM webhook 路径已经这么做了,主聊天路径漏了——纯属配置不一致。

---

## 3. 看门狗 DB DDoS(Update2-2)—— 误判

### 3.1 plan 的原论点

> "500 并发用户 → 500 Vercel 实例 → 每实例 5 秒看门狗 → 每秒 100 次无效 DB 查询 → 耗尽 Neon 配额。"

### 3.2 真实情况:plan 把"看门狗"和"sweeper"搞混了

逐个核实所有进程内定时器:

| 定时器 | 文件:行 | 查 DB | unref | 频率 |
|---|---|---|---|---|
| L2 `checkTimeouts` | `lib/security/l2-decision-queue.ts:287` | **否**(纯内存 Map) | 否 | 5s |
| L2 `expireStaleDecisions` sweeper | `lib/security/l2-index.ts:24` | **是**(SELECT+UPDATE) | 是 | 30s |
| Barrier sweeper | `lib/workflow/agent/barrier.ts:582` | 条件(有过期项才查) | 是 | 30s |
| 调度心跳 | `lib/workflow/scheduled/dispatch.ts:464` | 是(单行 UPDATE) | 否(per-run 短命) | 30s |
| CLI KV 轮询 | `app/api/cli/session-events/[sessionId]/route.ts:56` | 否(查 KV) | 否(per-SSE) | 2s |
| IM typing | `app/api/internal/im-stream/route.ts:136` | 否(打 IM API) | 否(per-msg) | 4.5s |

**plan 描述的"5 秒看门狗查 DB"不存在**。`checkTimeouts` 只遍历进程内 `this.decisions` Map,对本实例自己 enqueue 过且还在内存里的 decision 改状态,只在有超时项时才 best-effort 写 DB(无 SELECT)。

**真正符合"每实例轮询 DB"的是 30 秒 `expireStaleDecisions` sweeper**,但:
- 调了 `.unref()`,空闲实例不阻止进程退出。
- Vercel 实例空闲即回收,不会维持 500 个常驻。
- 即便极端 500 常驻实例,30s 一次 → **≈17 QPS**,不是 plan 说的 100 QPS(算术错 6 倍)。
- 查询带 `WHERE status IN ('pending','sent') AND expires_at < now()` 的索引条件,Neon 处理 17 QPS 索引查询(多数命中 0 行)是小儿科。

### 3.3 结论

> ❌ **plan 误判为"灾难性 DDoS",实际为"轻微低效"**。严重度:低。可选优化:改用 enqueue 时调度一次性 setTimeout 兜底,或 Postgres `LISTEN/NOTIFY`,但非紧急。

---

## 4. vm.Script 沙箱 CPU(Update2-3)—— 误判

### plan 的原论点

> "每步都用 vm.createContext + vm.Script,上千并发会 CPU 爆炸。"

### 真实情况(读 `@workflow/core/dist/`)

1. **编译有 LRU 缓存**:`node_modules/@workflow/core/dist/vm/script-cache.js` 是进程级 LRU(`MAX_BUNDLES=8`),`getCachedWorkflowScript(code, filename)` 按 `(code, filename)` 缓存编译好的 `vm.Script`。**同一 bundle 在一个进程里只编译一次**。生产一个部署 = 一个 bundle = 编译成本摊销到进程生命周期。

2. **每 step 真实开销**:`runWorkflow()` 在每次 replay 迭代调 `createContext()`(创建新 context,开销是注入 Math.random/Date/Web API/Request/Response 等),然后 `runCachedWorkflowScript()`——**命中缓存**,只 `script.runInContext()`,不重编译。V8 对函数体惰性编译。

3. per-step 成本 ≈ "一次 createContext + 一次已编译 Script 的 runInContext",是 O(几十 KB 内存 + sub-ms~几 ms CPU),1000 并发 step 不会"CPU 无法承受"。

4. 真正的 CPU 大头是 LLM 调用 + Zod 校验 + 工具序列化,都在 host 进程(沙箱外),与 vm 无关。

> ❌ **plan 误判**。vm.Script 编译缓存机制专门解决了 plan 担心的"每步重编译"问题。

---

## 5. Vercel vs 自托管(Update3)

### 5.1 Vercel 部署:确实不适合大团队(plan 说对)

✅ plan 方向正确:
- SSE 流式响应占用函数并发槽 + GB-second 持续计费。挂起期间无 CPU 工作(等 agentd),但实例未释放。
- 高峰并发有挤兑风险(webhook 与主聊天共享并发池)。
- 长任务产生持续计费。

❌ plan 夸大处:
- "Vercel Pro 并发硬墙 1000"是过时认知。Fluid compute 下并发弹性 + GB-second 计费,不是硬墙。
- "连 webhook 都被线性阻塞"不准。webhook 已设 `maxDuration=300` 且 IM 走独立 `/api/internal/im-stream` fire-and-forget 消费器,webhook 本身快速 ACK。共享并发池但不线性阻塞。

### 5.2 自托管:适合,但"轻松挂万流"过于乐观

✅ plan 方向正确:
- Node.js 事件循环擅长长连接挂起,CPU 开销极低。

❌ plan 论据瑕疵:
- **"@neondatabase/serverless HTTP driver 让挂起连接不霸占 TCP 连接"——张冠李戴**。自托管(Docker)用的是 `pg`(node-postgres)TCP driver + 连接池(见 `lib/core/db/pg-driver.ts` 与 AGENTS.md「DB: Dual-driver」)。HTTP driver 是 Vercel 专属。plan 把 Vercel 特性当成私有化优势的论据了。
- **"单台普通服务器轻松挂万流"忽略**:
  - `ulimit -n` 默认 1024,需调到 10 万+(运维门槛)。
  - 每流持有 `run.readable.tee()` reader + `guardWorkflowChunks` TransformStream(`lib/chat/stream-guard.ts`)+ SDK 状态,万流 × 元数据 ≈ 几百 MB 量级,不是"极其微小"。
  - `pg` 连接池默认 10,需调大或改 queue。
  - Workflow step runtime 在自托管下的并发模型需确认。

> 实际几千流可行,万流需压测验证,不能拍脑袋。但结论"自托管适合千人团队"成立。

---

## 6. plan Update4 的两个 Bug —— 已在本分支修复

侦察兵读的是修复后的代码,所以看到"已修复"。核实 `git log`:`82e3d637 fix(l2): isolate queue by (userId, sessionId) and persist promote to DB` 即本次修复。

- **Bug1(全局锁)**:已修。`canPromote`(`l2-decision-queue.ts`)现按 `(userId, sessionId)` 分桶,跨用户/跨会话不互相阻塞。
- **Bug2(幽灵决议/promote 不写 DB)**:已修。`promote()` 有 `await markSent(decisionId)`;`markSent` 是 `UPDATE ... WHERE status='pending'` 的 CAS 写。

---

## 7. 可操作建议(按优先级)

### P0:补 maxDuration(成本极低,收益极大)

给三个 SSE 路由加一行,与 IM webhook 路由对齐:

```ts
// app/(chat)/api/ai/route.ts
// app/api/cli/chat/route.ts
// app/(chat)/api/ai/[runId]/stream/route.ts
export const maxDuration = 300;
```

### P1:确认前端重连逻辑

`/api/ai/[runId]/stream` 提供了重连端点,但前端 `useChat` 是否在连接断开后自动重连?需审计前端。若不重连,maxDuration 截断后即使 workflow durable 后台继续,用户体验仍是"消息断了"。

### P1:确认 workflow step runtime 在 Serverless 的驱动归属

在 Vercel 上,step 执行由谁驱动?若由首次 start 的函数实例驱动,该实例被 maxDuration 杀后 step 靠什么续命?这是比"并发墙"更本质的 Serverless 适配问题,取决于 `@workflow/core` 配置。

### P2(可选优化,非 bug)

- L2 sweeper(`l2-index.ts` 30s):可改用 LISTEN/NOTIFY 或 enqueue 时调度一次性 setTimeout,消除空转查询。
- L2 `checkTimeouts`(`l2-decision-queue.ts:287`)的 setInterval 缺 `.unref()`,建议加上(与 sweeper 一致)。
- CLI SSE KV 轮询(`session-events/route.ts` 2s):500 连接 = 250 QPS KV 读,可迁移到 WebSocket。仅 CLI 远程控制模式。

---

## 附:证据索引

| 关注点 | 文件:行号 |
|---|---|
| 主聊天 POST 入口 | `app/(chat)/api/ai/route.ts:108-260` |
| chatMain 60s 启动超时 race | `app/(chat)/api/ai/route.ts:155-175` |
| createUIMessageStreamResponse | `app/(chat)/api/ai/route.ts:228,247,256` |
| CLI 聊天入口(无 maxDuration) | `app/api/cli/chat/route.ts:172-260` |
| 重连端点(无 maxDuration) | `app/(chat)/api/ai/[runId]/stream/route.ts:1-40` |
| chatMain | `lib/chat/index.ts:1280-1960` |
| startWorkflow + tee/drain | `lib/workflow/agent/dispatch.ts:114-205` |
| IM webhook(maxDuration=300) | `app/api/bot/[authSecret]/[adapter]/callback/route.ts:20-24` |
| L2 checkTimeouts(5s,纯内存) | `lib/security/l2-decision-queue.ts:287` |
| L2 sweeper(30s,查 DB,unref) | `lib/security/l2-index.ts:24` |
| L2 markSent(已修复) | `lib/core/db/l2-decisions.ts:176-194` |
| Workflow SDK durable API | `node_modules/workflow/dist/api.d.ts` |
| vm.Script LRU 缓存 | `node_modules/@workflow/core/dist/vm/script-cache.js` |
