# Session Heartbeat(主动发言决策)— arkloop LLM Heartbeat 移植

- Status: proposed(切片 A/B 已落地;C/D 已设计未实现)
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

## 未落地(切片 C/D)— 已验证的机制

### C1. 触发链穿线(位置参数链)

`chatMain` → `startWorkflow` → `start(chatWorkflow, [initialMessages, source, config,
sessionId, user, requestModel, agentsMd, planMode, thinkingLevel, clientSpoof,
requestAgent])` 是**位置参数**(`lib/workflow/agent/dispatch.ts:310`)。heartbeat 标志
追加在数组末尾(第 12 位),与 planMode 的穿线路径完全同构:
`lib/chat/index.ts`(LegacyChatMainRequest.heartbeat)→ dispatch(StartWorkflowInput.heartbeat)
→ chatWorkflow 签名 → `buildAgentTools(..., { heartbeat })` + prepareStep 读取。

### C2. 合成指令(不污染 transcript)

arkloop 给 `rc.Messages` 追加合成 user 消息、`ThreadMessageIDs` 记 `uuid.Nil`(仅模型
可见,不落库)。agentboster 对应机制已存在:**prepareStep 的 instructionQueue**
(`lib/workflow/agent/index.ts:655` 起)就是在每次模型调用前把排队指令映射进 messages。
heartbeat run 在 step 0 注入一条合成 user 指令(内容:这是第 N 次心跳、上次决策、距上次
用户消息多久、先调 heartbeat_decision 再决定),**不持久化** —— 每 30 分钟在 transcript
里堆 "[heartbeat]" 用户消息是不可接受的。

需要验证:initialMessages 为空数组时 chatWorkflow 是否正常(heartbeat 不带新用户消息,
建议 dispatcher 直接走 startWorkflow 而非 chatMain 的 envelope 解析,绕开空输入分支)。

### C3. 强制决策(toolChoice)

`@workflow/ai` 的 `DurableAgent`/`prepareStep` **原生支持 toolChoice**
(`PrepareStepResult.toolChoice`,`node_modules/@workflow/ai/dist/agent/durable-agent.d.ts:226`)。
在 prepareStep 里:

- `stepNumber === 0 && heartbeat` → 返回 `{ toolChoice: { type: 'tool', toolName:
  'heartbeat_decision' } }`(首步强制决策);
- 后续 step 不返回 toolChoice(auto)——`reply=true` 后模型仍可用只读工具收集上下文
  再组织发言。

### C4. 静默与投递(fail-closed)

- 扫描 stepResult 中的 heartbeat_decision tool-call input:
  - `reply=false` → 立即终止 run(stopCondition),全部输出丢弃;
  - `reply=true` → run 正常完成,最终文本投递到会话自己的 IM 线程;
  - **未观察到决策**(模型绕过强制,理论不可能)→ 按 reply=false 处理(fail-closed),
    记 warn 日志。
- 投递路径:IM 会话的出站走 `sendNotification`(`lib/extra/channels/send-notification.ts`),
  以 session 的 `channel`(adapter)+ `externalThreadId` 定位线程(targetChatId=
  threadId 的用法见同文件 :174/:202)。未验证点:scheduled 触发的 run 是否已有
  自动回投线程的路径(im-stream consumer),若有则复用之。

### D. 唤醒调度(两个互补机制)

- **主:每会话睡眠循环 workflow**(`sessionHeartbeatWorkflow(sessionId)`,
  `'use workflow'` + while-loop sleep(nextRunAt)),与 `scheduledTaskWorkflow` 的
  daily 循环同构(`lib/workflow/scheduled/index.ts`);workflowRunId 存
  `heartbeat_workflow_run_id`。启用时 start,禁用/改间隔时重启循环。
- **辅:lazy sweeper**(保险带):沿用 curator/reapStaleNodes 的 piggyback 惯用法
  (serverless 无常驻调度),在心跳相关的读写路径上偶发调用
  `listDueSessionHeartbeats()` 补发漏唤醒(host 重启导致睡眠循环丢失的场景)。
- 内部触发端点仿 `/api/bot/[authSecret]/schedule` 模式加 `/heartbeat`。

## 防坑

- **advance-on-dispatch,不是 on-completion**:慢/失败的 run 不得重放自己的槽位。
- **replay 安全**:chatWorkflow 是 durable workflow,step 重放时 heartbeat 注入指令必须
  幂等(instructionQueue 的 splice 模式天然幂等,复用即可)。
- 表结构变更走 drizzle push 部署路径;schema 加列后自托管入口(self-host-migrate)自动
  覆盖,无需额外迁移脚本(无表改名,不触发 push 改名陷阱)。

## 验证清单(切片 C/D 完成时)

- [ ] 强制 toolChoice:step 0 的 provider 请求里 tool_choice 指向 heartbeat_decision
- [ ] reply=false:run 终止、无 IM 出站、transcript 无痕
- [ ] reply=true:最终文本到达线程;transcript 只含 assistant 消息
- [ ] 非决策路径 fail-closed;decision 工具在普通 run 调用返回 ok:false
- [ ] 并发 tick 双发防护(claimDueHeartbeat 的 CAS)
- [ ] yarn check:lint && yarn test && yarn build(workflow bundler 门禁,lib/workflow 改动必跑)
