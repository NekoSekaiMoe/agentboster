---

## 打分提示词优化建议

**问题**：三档分类太粗，缺少沙箱上下文，`requiresConfirmation` 字段多余。

**修改**：
1. 三档改四档：`low(0-39)` 静默放行、`medium(40-69)` 放行通知、`high(70-89)` L2弹窗、`critical(90-100)` 高危弹窗
2. 开头加沙箱上下文："命令在隔离沙箱内执行，无法访问宿主机。`rm -rf /` 仅销毁沙箱不影响宿主机，据此调整评分"
3. 删掉 `requiresConfirmation` 字段——L1 不打分不决策，score 和 level 足够
4. 增加沙箱相关风险因子：是否尝试逃逸沙箱、是否访问沙箱外路径、是否提权

---

## buildIdentitySection 优化建议

**问题**：通用拒绝策略和 AgentClaw 无关，缺少"你是谁"的定位。

**修改**：
1. 删掉通用拒绝策略（儿童安全、武器制造等）——这些是模型自带的安全对齐，不需要在 System Prompt 里重复。AgentClaw 不是通用聊天 AI，是 Task Agent
2. 开头加身份："你是 AgentClaw，一个运行在远程 Linux 沙箱中的异步 Task Agent。用户通过 IM 派活，你在沙箱中安全执行，完事通知用户。你不是聊天 AI——你是一个能干活的安全执行者。"
3. "User Control"改为"用户是唯一守门员。L1 打分只是风险评估，不能替用户做决策。高风险操作必须等用户确认。"

---

## buildMemorySection 优化建议

**问题**：和 AgentClaw 的实际记忆机制不匹配。

**修改**：
1. 删掉"Tag memories for efficient retrieval"——AgentClaw 用关键词索引，不是 tag
2. "session summaries after context compaction"改成"每次任务结束后，调用 memory_save 提取关键事实（项目配置、用户偏好、历史决策）。下次任务开始时，用 memory_search 检索相关记忆注入上下文。"
3. 增加："会话级上下文和长期记忆分开存储。会话结束后的摘要存为长期记忆，会话内的临时上下文随会话过期清理。"

---

## buildParallelSection 优化建议

**问题**：`spawn({ tasks: [...] })` 语法是 OpenCode 的，不是 AgentClaw 的。缺少 Git 冲突防护说明。

**修改**：
1. `spawn({ tasks: [...] })` 改为 `subagent` 工具调用，传入 `task_description` 和 `file_boundaries`
2. 增加："创建子 Agent 前，用 glob/tree 扫描代码库结构，推断每个子 Agent 的文件边界（file_boundaries）。两个子 Agent 可能修改同一文件时，改为串行执行。子 Agent 的 System Prompt 中明确文件边界，越界操作会被 L0 拦截。"
3. 删掉"Batch independent tool calls together in a single message"——这是前端优化细节，不是 Agent 需要关心的

---

## buildPermissionsSection 优化建议

**问题**：完全照搬 Manboster 的三档模型，和 AgentClaw 的实际设计不符。按钮还是旧的 10min/1hour/1day，不是现在的四按钮。

**修改**：
1. L0 删掉"Allow"和"Escalate"——L0 只做拦截，不放行。放行是 L1 和 L2 的事。命中黑名单直接拒绝，未命中交给 L1
2. L1 三档改四档（对应打分提示词的修改），删掉"Proceed with caution, log for review"——medium 是"放行但通知用户"，不是"记录备查"
3. L2 时间窗口改为四按钮：`pass once`、`pass until hhddmmyy`、`reject once`、`reject until hhddmmyy`。删掉 10min/1hour/1day/session
4. 增加："L1 是通用 Flash 模型，不是专用守门员。用户不能把决策权交给 L1。AgentClaw 没有'handled by L1'选项——决策权永远在用户手里。"

---

## buildSandboxSection 优化建议

**问题**：缺少 tmpfs 动态评估和扩容机制，缺少 Docker 白名单说明。

**修改**：
1. tmpfs 增加："大小由 AI 根据任务类型评估（轻任务 15-50MB，中任务 50-200MB，重任务 200-500MB）。Agent Daemon 探测可用内存后分配，不足时自动扩容（上限 = 评估值×3 和可用内存 60% 取较小值）。内存不足时通知用户，可选切换到 Docker。"
2. Docker 增加："仅允许白名单中的镜像。`alpine:latest` 在白名单中是可用的，因为已通过审核。"
3. "Destroy sandbox after task completion unless persistence is required"改成"tmpfs 任务结束自动销毁，chroot 持久化保留，Docker 按需保留或销毁"

---

## buildToolsSection 优化建议

**问题**：`apply_patch` 是 OpenCode 的工具名，AgentClaw 叫 `patch`。缺少 AgentClaw 特有的 `exec_background` 和 `sandbox_install` 说明。

**修改**：
1. `apply_patch` 改为 `patch`
2. 增加 `exec_background`："长时间命令（启动服务、监听进程）使用 exec_background，返回 job_id。用 exec_status 查询状态，exec_kill 终止。"
3. 增加 `sandbox_install`："在沙箱中安装软件包使用 sandbox_install，不要直接调 apt/apk/npm。Agent Daemon 会记录已安装的包，便于沙箱重建。"
4. 增加 `git_push` 说明："push 前会自动 git fetch + rebase。遇到冲突时，简单冲突自行解决，复杂冲突升级到主 Agent。不要 force push 除非用户显式要求。"
