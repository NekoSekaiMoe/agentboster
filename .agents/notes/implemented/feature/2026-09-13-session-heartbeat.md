# Session Heartbeat(主动发言决策)— arkloop LLM Heartbeat 移植

- Status: implemented(切片 A/B/C/D 全部落地;验证清单见文末)
- Date: 2026-09-13
- Source: ref/arkloop(`mw_llm_heartbeat.go`、`tools/builtin/heartbeat_decision`、`llm_heartbeat_scheduler.go`)
- 只借设计,不搬代码(Arkloop License 非 OSI;本仓库 MIT)

## 为什么

agentboster 的 IM 渠道目前是纯被动:用户不发消息,agent 永远沉默。arkloop 的 LLM
Heartbeat 给了一个反骚扰的主动发言模型:按会话间隔唤醒 agent,但**第一步强制模型先回答
"这轮要不要说话"**(heartbeat_decision 工具,tool_choice=specific),`reply=false`
则整轮静默丢弃。决策权在模型,成本是每次唤醒一次廉价的首步调用,而不是无限的推送冲动。

被否掉的备选:
- **定时直接发消息**(cron prompt 固定输出)— 无决策环节,必然骚扰;不可接受。
- **后台规则引擎判断再生成** — 规则永远追不上"此刻该不该打扰"的语境判断;把决策交给
  看得见上下文的模型是唯一不做哑决策的位置。

## 已落地(切片 A/B,commit 在 feat/harness-hardening)

1. **`heartbeat_decision` 内置工具**(`lib/workflow/agent/tools/heartbeat/decision.ts`)
   - 对**所有 run** 注册(内置默认启用),保证 heartbeat 与普通 run 的工具 schema 完全
     一致 —— provider 的 prompt cache 按 schema 键控,per-run-kind 漂移会双向炸缓存
     (arkloop 保持 `tool_schema_hash` 稳定同理)。
   - 工具执行器 fail-closed:非 heartbeat run 调用返回 `ok:false`(arkloop 同款语义
     "called outside heartbeat run"),防止普通对话里被误用出"决定不回复"的怪行为。
   - 决策的单一事实源 = **step 的 tool-call input**(loop 扫描 stepResult),没有
     side-channel Map,不存在跨 run 泄漏。
2. **工厂上下文标志**:`BuildInToolFactoryContext.heartbeat` / `BuildAgentToolsOptions.heartbeat`
   (`tools/define.ts` + `tools/index.ts`),与 planMode 同构的穿线。
3. **`session_heartbeats` 表**(`lib/core/db/schema/heartbeat.ts`,一行一会话):
   enabled / intervalMinutes(clamp [5,1440],默认 30)/ nextRunAt / lastDecision* /
   failureCount。`lib/core/db/heartbeat.ts` 提供:
   - `claimDueHeartbeat()`:**单语句 CAS**——`UPDATE ... WHERE enabled AND next_run_at
     <= now SET next_run_at = now + interval RETURNING`,advance-on-dispatch,并发
     tick 不可能双发。被否掉的两段式(read→recompute→write)在 claim 与重算之间有
     竞态窗口。
   - `recordHeartbeatResult()`:failureCount 用 SQL 自增(`sql\`col + 1\``),被否掉的
     read-then-write 会丢并发更新(TS 里 `a ?? 0 + 1` 还有优先级坑)。
4. **设置面**:`GET/PUT /api/sessions/[id]/heartbeat`(session 所有权校验同
   orchestration 路由;非 IM 会话 409 —— 主动发言需要一个"说话的线程")。

## 已落地(切片 C/D)

- **触发链穿线**:`LegacyChatMainRequest.heartbeat` → `startWorkflow` 位置参数第 12 位
  → `chatWorkflow(heartbeat)` → `buildAgentTools({ heartbeat })`。合成指令作为
  `initialMessages` 的最后一条 user 消息由 dispatcher 注入(**不持久化**,arkloop 的
  uuid.Nil 同义);`writeUserMessageMarker` 只写 UI status chunk,不落库,已核实。
- **强制决策**:`prepareStep` 在 `stepNumber === 0 && heartbeat` 时返回
  `toolChoice: { type: 'tool', toolName: 'heartbeat_decision' }`,后续 step 不约束。
- **投递门控**:stream 完成后扫 `result.steps` 取 decision input(单一事实源),
  `reply=false` / 无 decision(fail-closed)/ 非 IM source → 静默;`reply=true` 且
  `extractFinalAssistantText` 非空 → `sendAdapterSourceReply`(TTS 适配复用)。
- **唤醒循环**:`sessionHeartbeatWorkflow`(每会话 sleep(nextRunAt) 循环,醒来重读
  配置,未到点则继续睡)→ POST `/api/bot/{authSecret}/heartbeat` →
  `deliverSessionHeartbeat`(CAS 认领 + `startWorkflow`)。PUT 启用时
  `ensureHeartbeatWorkflow` 起循环;连续失败 3 次自动 `disableSessionHeartbeat`。

### 踩坑记录(已验证,勿重蹈)

- **含 `'use workflow'` 的模块,动态导入链也会被 DevKit 检查器走查**:`deliverSessionHeartbeat`
  里 `await import('@/lib/core/db/users')` → `auth/password` → bcryptjs,yarn build 直接
  硬失败(报错位置误导性地指向 password.ts 的首个使用点)。解法沿用 scheduled/
  的 index(workflow)/dispatch(host)分文件模式:`heartbeat.ts` 只留 workflow+
  'use step'(其动态依赖 db/heartbeat、bot/webhook 均为干净链),
  `heartbeat-dispatch.ts` 放 host 侧(dispatch/ensure,自由引用 db/users 等重依赖)。
  这比 AGENTS.md 现有规则更严:**不只是顶层 `node:*`,任何会被拉进 workflow bundle 的
  重依赖(哪怕 `await import`)都不能出现在含 workflow 声明的模块里。**

## 防坑(历史)

- **advance-on-dispatch,不是 on-completion**:慢/失败的 run 不得重放自己的槽位。
- **replay 安全**:chatWorkflow 是 durable workflow,step 重放时 heartbeat 注入指令必须
  幂等(指令作为 workflow 输入的一部分,天然可重放)。
- 表结构变更走 drizzle push 部署路径;schema 加列后自托管入口(self-host-migrate)自动
  覆盖,无需额外迁移脚本(无表改名,不触发 push 改名陷阱)。

## 验证清单(切片 C/D 完成时)

- [ ] 强制 toolChoice:step 0 的 provider 请求里 tool_choice 指向 heartbeat_decision
- [ ] reply=false:run 终止、无 IM 出站、transcript 无痕
- [ ] reply=true:最终文本到达线程;transcript 只含 assistant 消息
- [ ] 非决策路径 fail-closed;decision 工具在普通 run 调用返回 ok:false
- [ ] 并发 tick 双发防护(claimDueHeartbeat 的 CAS)
- [ ] yarn check:lint && yarn test && yarn build(workflow bundler 门禁,lib/workflow 改动必跑)
