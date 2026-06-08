# AgentBoster 缺失能力分析与补充计划

> 基于 AgentBoster vs Manboster 全面对比分析（results.md）和 REPORT.md 的竞品分析，
> 识别 AgentBoster 相对 Manboster 缺失或不足的能力，并制定补充计划。
>
> 本计划经过 40 轮技术异议审查，所有方案均基于代码级验证。

---

## 背景

AgentBoster 在功能广度上已大幅领先（25+ 工具、7 个 Bot 平台、3 种沙箱、4 个 MCP 工具），
但 Manboster 在以下维度仍有 AgentBoster 不具备的能力。本计划按优先级分类，逐一补全。

---

## P0 — 核心差距（安全与架构层面）

### 1. 工具级权限控制（MinUserType）—— 需完整信任链

**差距**：Manboster 每个工具都有 `MinUserType`（root/admin/user/unknown），gatekeeper 在执行前强制比对用户权限（`guard.go:95-98`）。AgentBoster Daemon 内部无用户概念，所有工具对 Agent 来说权限相同。

**影响**：多用户场景下无法区分"谁能用什么工具"。

**⚠️ 异议 #14：user identity 不能由 daemon 请求头作为可信来源**

计划写"Daemon 回调 API 在请求头携带 user identity + roles"——这把身份来源放到 daemon 侧，不安全。daemon 可以伪造请求头。

**正确信任链**：Web 根据 `task.sessionId → sessions.userId → users.roles` 派生身份，作为 Task payload 返回给 daemon。Daemon 不应信任自己提交的 roles。

**⚠️ 异议 #19：MinUserType 和 Web roles 缺映射定义**

Manboster 是 root/admin/user/unknown，Web 侧是字符串数组 `roles: text('roles').array().default(['user'])`（如 `['admin']`、`['user']`）。计划还提到 readonly。需要明确：
- readonly 算不算 user？
- root 从哪里来？
- 多 role 时取最高还是最低？
- 没有 session/user 时是 unknown 还是拒绝？

**⚠️ 异议 #20：无 session 的 task 没有处理**

`agentTasks.sessionId` 是可空的（`agentd.ts:15` 无 `.notNull()`），`createTask()` 允许不传 sessionId。信任链依赖 `task.sessionId → sessions.userId → users.roles`，但没定义 `sessionId = null` 的任务怎么授权。

**Roles 映射定义**：
```
Manboster MinUserType → Web roles 映射：
  root    → roles 包含 'owner' 或 'root'（显式声明，不从 admin 提升）
  admin   → roles 包含 'admin'（默认种子用户就是 admin，不会提升为 root）
  user    → roles 包含 'user'（默认值）
  unknown → sessionId = null 或 userId = null（无身份信息）

多 role 取最高：
  owner/root > admin > user > unknown
  例：roles=['user', 'admin'] → admin
  例：roles=['admin'] → admin（不会提升为 root）

readonly 处理：
  readonly 不是独立的 MinUserType，而是通过 roles 数组控制：
  - Web 侧新增 'readonly' role
  - readonly 映射为 unknown（最低权限）
  - 只允许标记为 unknown 的只读工具（如 vault_list, knowledge_search）
  - 不扩展 MinUserType 枚举，避免 Manboster 兼容性问题

⚠️ 异议 #24：admin → root 风险
  种子用户 roles=['admin']（users.ts:113）。如果 root → roles 包含 admin，
  默认管理员会被提升为 root。修正：root 只来自 'owner' 或 'root' role，
  admin 永远只映射到 admin。

⚠️ 异议 #27：admin 可提权创建 owner/root
  当前 app/api/auth/users/route.ts:64：createUser(username, password, { roles })
  roles 从请求体直接传入，无白名单校验。admin 可创建 roles: ['owner'] 的 root 用户。

  修正：roles 白名单校验 + 授予限制：
    ALL_ROLES = ['owner', 'root', 'admin', 'user', 'readonly']
    PROTECTED_ROLES = ['owner', 'root']
    校验逻辑：
      1. 请求中的 roles 必须是 ALL_ROLES 的子集
      2. 如果请求包含 PROTECTED_ROLES，调用者必须已是 owner/root（非 admin）
      3. admin 只能授予 admin/user/readonly
    实现位置：app/api/auth/users/route.ts POST 方法 + lib/core/db/users.ts

⚠️ 异议 #29：缺少 owner/root 的 bootstrap 方案
  种子用户 roles=['admin']（users.ts:113）。admin 不能创建 owner/root，
  系统里可能永远没有 root 用户。需要一个明确的 owner 入口。

  修正：env var bootstrap owner
    USERNAME + OWNER_USERNAME 环境变量：
      1. 如果设置 OWNER_USERNAME，在 seedInitialUser() 中创建 owner 用户
      2. owner 用户 roles=['owner']，不受 VALID_ROLES 限制
      3. 如果未设置 OWNER_USERNAME，回退到 admin 种子用户
      4. 首次登录后建议通过 Web UI 创建其他 owner/root 用户
    实现位置：lib/core/db/users.ts seedInitialUser()
```

**无 session task 的授权策略**：
```
sessionId = null 的任务：
  1. 信任链断裂：无法派生 userId/roles
  2. 授权决策：userId = null → 视为 unknown
  3. unknown 能力：
     - 仅允许 MinUserType ≤ unknown 的工具（低权限工具）
     - 高权限工具（exec, shell, codeact 等）拒绝
  4. 安全兜底：无 session 的任务不写入 reviewLog user 字段（userId=null）
```

**⚠️ 异议 #16：ReviewLog 缺 Web schema 改动**

`agentd.ts:42-55`：`agentReviewLogs` 表无 user 字段。`writeReviewLogs()`（line 79-102）无 user 参数。

**方案（完整信任链 + Web DB 改动）**：

```
Web DB Schema 改动：
  1. lib/core/db/schema/agentd.ts：
     - agentTasks 表新增 userId 字段（从 session 派生）
     - agentReviewLogs 表新增 userId + roles 字段

Web DB 查询改动：
  2. lib/core/db/agentd.ts：
     - createTask()：从 sessionId 查 sessions.userId，写入 agentTasks.userId
     - getTask()：join sessions + users，返回 user identity + roles
     - writeReviewLogs()：新增 userId/roles 参数，写入 agentReviewLogs

Web API 改动：
  3. app/api/agentd/v1/tasks/[id]/route.ts：
     - GET 返回 Task 时携带 userId + roles（从 DB 派生，非 daemon 提交）
  4. app/(chat)/api/agentd/v1/review-logs/route.ts：
     - POST：Web 侧重新校验 task.sessionId → user identity，不信任 daemon 提交的 roles
     - 注意：review logs 路由在 (chat) 布局下，不是 tasks/[id] 路由

Daemon 侧（被动接收）：
  4. clawless/types.go：Task 结构体新增 UserID + Roles（从 Web API 响应中读取）
  5. agent/loop.go：Run 方法从 Task 中提取 roles，传递给 gatekeeper
  6. security/gatekeeper.go：Audit 方法接收 roles 参数

审计侧（Web 侧校验）：
  7. l2_auth/manager.go：ReviewLog 新增 UserID + Roles 字段
  8. clawless/review_logs.go：WriteReviewLogs 携带 user identity
  9. Web 侧 writeReviewLogs()：重新从 task.sessionId 派生 roles，不信任 daemon 提交值
```

**预期产出**：
- `lib/core/db/schema/agentd.ts`：agentTasks 新增 userId，agentReviewLogs 新增 userId/roles
- `lib/core/db/agentd.ts`：createTask() 从 session 派生 userId，getTask() join user，writeReviewLogs() 写入 user
- `app/api/agentd/v1/tasks/[id]/route.ts`：GET 返回 user identity
- `app/(chat)/api/agentd/v1/review-logs/route.ts`：POST 重新校验 roles（正确路由落点）
- `agentd/internal/clawless/types.go`：Task 新增 UserID/Roles（从 Web API 响应读取）
- `agentd/internal/agent/loop.go`：Run 方法传递 roles
- `agentd/internal/security/gatekeeper.go`：Audit 接收 roles
- `agentd/internal/security/l2_auth/manager.go`：ReviewLog 新增 user 字段
- `agentd/internal/agent/tools.go`：ToolDefinition 新增 MinUserType

---

### 2. 安全层默认开启（需前置条件）

**差距**：Manboster 默认启用零信任（所有工具调用都经过 gatekeeper 审查），AgentBoster 的安全层可配置但不默认启用。

**影响**：部署者可能忘记启用安全层，导致工具调用无审查。

**⚠️ 异议 #2："零信任默认启用"与"L1 未配置自动跳过"逻辑冲突**

如果 L1 未配置就自动跳过，这不是严格的零信任默认启用。准确的语义是：
- **默认开启 L1 尝试**（L1Enabled 默认 true）
- **未配置时降级到 L0/L2**（L1 自动跳过，不是真正的零信任）
- 措辞应避免"零信任默认启用"，改用"安全层默认开启，未配置时降级"

**⚠️ 异议 #8：L1 "未配置"判断不成立——默认值会绕过**

`config.go:66-68` 中 L1 字段已有默认值：
```go
L1Provider  string `mapstructure:"l1_provider" default:"local_ollama"`
L1Endpoint  string `mapstructure:"l1_endpoint" default:"http://localhost:11434/api/generate"`
L1Model     string `mapstructure:"l1_model" default:"tinyllama:latest"`
```
字段**永远非空**——即使用户未显式配置，Viper 也会填入默认值。计划中"如果 L1 未配置"的判断会被默认值绕过，系统会误以为 L1 已配置。

**⚠️ 异议 #9：配置字段名不一致**

计划写 `security.l1_web_url`，但实际字段是 `security.l1_endpoint`（`config.go:67`）。不存在 `l1_web_url` 字段。

**前置条件（必须先满足）**：
1. ~~`agentd.toml` 中必须配置 L1 模型来源~~（不可行，默认值永远非空）
2. 改为：**显式配置检测 + 启动时实际健康检查**

**方案**：
- `agentd/internal/config/config.go` 中 `L1Enabled` 默认值改为 `true`
- **启动时实际健康检查**（不能只看字段是否为空）：
  - 如果 `l1_provider == "local_ollama"`：尝试连接 `l1_endpoint`，检查 Ollama 是否运行
  - 如果 `l1_provider == "web_callback"`：尝试调用 `l1_endpoint`，检查 Web 回调是否可达
  - 如果健康检查失败：启动日志 warn，L1 自动降级为跳过，L0 仍生效
  - 如果健康检查通过：正常启用三层审查
- README 中明确说明：L1 需要配置模型并确保服务可用，否则自动降级为 L0/L2

**降级策略**：
```
启动时 L1 健康检查：
  ├─ l1_provider=local_ollama + Ollama 可达 → 正常启用 L0+L1+L2
  ├─ l1_provider=local_ollama + Ollama 不可达 → L1 跳过，日志 warn
  ├─ l1_provider=web_callback + endpoint 可达 → 正常启用 L0+L1+L2
  ├─ l1_provider=web_callback + endpoint 不可达 → L1 跳过，日志 warn
  └─ l1_provider=其他未知值 → 启动失败（除非 l1_enabled=false 显式设置）
```

**⚠️ 异议 #13：unknown provider 不应自动跳过**

配置拼写错误（如 `l1_provider=ollama` 而非 `local_ollama`）会静默降级安全层——这是安全风险，不是容错。unknown provider 应该启动失败，除非用户显式设置 `l1_enabled=false`。

**迁移说明（已有部署）**：
- 已有 `l1_enabled = false` 的部署：不受影响，保持原行为
- 已有 `l1_enabled = true` 的部署：不受影响，保持原行为
- 新部署：默认 `l1_enabled = true`，如果未配模型则自动降级

**预期产出**：
- `agentd/agentd.toml.example`：默认启用 L1，附注模型配置要求
- `agentd/internal/config/default.go`：安全配置默认值
- `agentd/internal/config/validate.go`：L1 可用性校验 + 自动降级逻辑
- `agentd/internal/security/gatekeeper.go`：L1 不可用时跳过而非阻断

---

### 3. 安全失败策略：Fail-close（需前置条件）

**差距**：Manboster 在 Hachimi 不可用时拒绝所有工具调用（fail-close），AgentBoster 在 L0/L1 错误时允许执行（fail-open）。

**影响**：安全组件故障时，AgentBoster 会静默放行所有命令。

**⚠️ 关键约束**：Fail-close 的前提是"安全层确实可用"。如果 L1 模型本身就未配置（见第 2 项），fail-close 会导致所有工具被拒。

**前置条件**：
1. 必须先完成第 2 项（L1 可用性校验 + 自动降级）
2. Fail-close 仅适用于"L1 已配置但执行中失败"的场景，不适用于"L1 未配置"的场景

**方案**：
- 新增 `security.fail_open` 配置项（bool，默认 `false` = fail-close）
- **但 fail-close 的生效范围有限制**：
  - L1 已配置 + L1 执行失败 → fail-close（拒绝工具调用）
  - L1 未配置（自动降级）→ L1 跳过，不触发 fail-close，L0+L2 仍生效
  - L0 命中阻断规则 → 始终拒绝（硬规则，不受 fail_open 影响）
  - L0 引擎执行错误 → 按 fail-close 拒绝（安全组件故障不应放行）
  - L0 无规则命中 → 继续到 L1/L2（正常流程）
  - L2 认证失败 → 始终拒绝（硬规则，不受 fail_open 影响）

**降级策略**：
```
工具调用到达 gatekeeper：
  ├─ L0 命中阻断规则 → 直接拒绝（硬规则，不受 fail_open 影响）
  ├─ L0 引擎执行错误 → fail-close 拒绝（安全组件故障不应放行）
  ├─ L0 无规则命中 + L1 已配置：
  │   ├─ L1 审查通过 → 继续
  │   └─ L1 审查失败/超时 → fail_close 拒绝 | fail_open 放行（取决于配置）
  ├─ L0 无规则命中 + L1 未配置（自动降级）→ 跳过 L1，直接进入 L2
  └─ L2 认证失败 → 直接拒绝（硬规则，不受 fail_open 影响）
```

**⚠️ 异议 #18：L1 不可用时"直接进入 L2"语义不清**

"L1 不可用时直接进入 L2"没有明确：是所有工具调用都要求 L2，还是只有命中某类风险才 L2？没有 L1 score 时怎么判定风险？

**明确语义**：
- L1 降级时，**所有通过 L0 的工具调用都要求 L2 确认**
- 理由：没有 L1 score，无法判定风险等级，安全策略应保守
- 影响：用户体验下降（每次工具调用都要确认），但安全性不降级
- 缓解：L2 支持 "always" 持久授权（用户确认一次后，后续同类工具自动通过）
- README 明确说明：L1 降级模式下所有工具调用需 L2 确认，建议配置 L1 以获得更好体验

**迁移说明（已有部署）**：
- 已有 `fail_open = true` 的部署：不受影响
- 新部署：默认 `fail_open = false`（fail-close），但前提是 L1 已配置
- 如果 L1 未配置：fail_close 配置无效（L1 本就不执行，不存在"失败"场景）

**预期产出**：
- `agentd/internal/config/config.go`：新增 FailOpen bool 配置
- `agentd/internal/security/gatekeeper.go`：L1/L2 错误处理分支（含降级逻辑）

---

## P1 — 重要差距（用户体验与生态）

### 4. 国际化（i18n）—— 范围限定

**差距**：Manboster 有完整的 go-i18n/v2 支持（中/英双语），AgentBoster 所有文本硬编码英文。

**影响**：非英语用户体验差。

**⚠️ 异议 #6：范围过大——结构化日志不宜本地化**

"所有日志、工具描述、安全提示"一次性改造风险高。结构化日志（slog）本地化会：
- 破坏机器解析（日志聚合系统依赖固定格式）
- 影响排障（中英混杂增加 debug 难度）
- 增加维护成本（每次改日志都要同步翻译）

**方案（限定范围）**：
- **翻译范围**：仅用户可见的错误消息和交互文本（L2 确认消息、工具执行结果、启动/关闭提示）
- **不翻译**：slog 结构化日志、调试输出、机器可读的 audit log
- 在 `agentd/internal/` 下新增 `i18n/` 包
- 使用 `github.com/nicksnyder/go-i18n/v2`（与 Manboster 相同）
- 创建 `locales/en.json` 和 `locales/zh.json`

**预期产出**：
- `agentd/internal/i18n/`：新包（bundle、localizer、locales/）
- `agentd/internal/security/l2_auth/manager.go`：L2 确认消息使用 i18n
- `agentd/internal/agent/loop.go`：用户可见错误使用 i18n（非 slog 日志）
- `agentd/internal/sandbox/manager.go`：错误消息使用 i18n

---

### 5. 配置版本管理

**差距**：Manboster 有 `version` 字段管理配置版本，AgentBoster 无配置版本。

**影响**：配置升级时无兼容性检查，可能导致旧配置在新版本中行为异常。

**方案**：
- `agentd/internal/config/config.go` 新增 `Version string` 字段
- `agentd/internal/config/validate.go` 新增版本兼容性检查
- 参考：`manboster/internal/config/version.go`

**预期产出**：
- `agentd/internal/config/config.go`：新增 Version 字段
- `agentd/internal/config/validate.go`：版本检查逻辑

---

### 6. 贡献指南（CONTRIBUTING.md）

**差距**：Manboster 有详细的 CONTRIBUTING.md（Rev 4.1），AgentBoster 无独立贡献指南。

**影响**：社区贡献者无规范可依，代码质量不可控。

**方案**：
- 在根目录创建 `CONTRIBUTING.md`
- 包含：代码风格、提交约定、测试要求、安全报告流程
- 参考：`manboster/CONTRIBUTING.md`（Rev 4.1）

**预期产出**：
- `CONTRIBUTING.md`：贡献指南

---

### 7. 安全报告流程

**差距**：Manboster 有 SECURITY.md + security@manboster.dev + GitHub Security Advisory 流程，AgentBoster 无独立安全报告机制。

**影响**：安全漏洞发现后无正式报告渠道。

**方案**：
- 创建 `SECURITY.md`
- 说明漏洞报告流程
- 参考：`manboster/SECURITY.md`

**预期产出**：
- `SECURITY.md`：安全报告流程

---

### 8. 重复消息检测 —— 增强现有机制

**差距**：~~AgentBoster 无此机制~~ **事实错误**。AgentBoster 已有 Web 侧 dedup（`lib/chat/dedup.ts:45`：`checkDuplicate()` + Jaccard 相似度，300s TTL），并在 `lib/chat/index.ts:837` 使用。

**现有机制的不足**：
- 仅基于文本相似度（Jaccard similarity），无 platform message id
- 无 idempotency key 支持
- 仅覆盖 IM 渠道，未覆盖 Web API

**影响**：用户快速连发相同消息时，相似度阈值可能误判。

**⚠️ 异议 #3：不能只按"内容 hash + 5 秒"**

仅按内容 hash + 时间窗口会误吞：
- 合法重试（网络抖动后用户重发）
- 多渠道同内容消息（TG + Discord 同时收到）
- 定时任务重复触发（cron 误触发）

**方案（增强现有 dedup）**：
```
增强 lib/chat/dedup.ts（现有 Web 侧 dedup）：
  1. 新增 platform message id 去重（最高优先级）
     - checkDuplicate() 新增可选参数 messageId
     - 如果平台提供了唯一 ID，直接用它去重（不依赖文本相似度）

  2. 新增 idempotency key 支持（次优先级）
     - Web API 请求可携带 X-Idempotency-Key 头
     - checkDuplicate() 新增可选参数 idempotencyKey

  3. 保持现有 Jaccard 相似度作为兜底（最低优先级）

  4. 定时任务消息排除（cron 触发不应去重）
     - checkDuplicate() 新增可选参数 skipDedup
```

**实现位置**：
- `lib/chat/dedup.ts`：增强现有 `checkDuplicate()` 和 `recordMessage()`
- `lib/chat/index.ts`：传递 platform message id 和 idempotency key

**预期产出**：
- `lib/chat/dedup.ts`：增强现有 dedup（platform msg_id + idempotency key）
- `lib/chat/index.ts`：传递新参数

---

### 9. 反向 TTL 缓存 —— 需安全的 cache key

**差距**：Manboster 的 TTL 缓存是反向设计（root:30min, admin:2h, unknown:4h），权限越高 TTL 越短。AgentBoster 无 TTL 缓存。

**影响**：高权限操作无法通过缓存优化用户体验。

**⚠️ 异议 #2：cache key 过简会导致越权复用**

当前 AgentBoster L2 auth 的 cache key = `session_id + ":" + pattern`（`manager.go:42,91`）。
如果只按 pattern 匹配，一次 "rm -rf /tmp/*" 的确认可能意外复用到 "rm -rf /var/*"。

**安全的 cache key 设计**：
```
cache_key = user_id + ":" + session_id + ":" + tool_name + ":" + args_hash + ":" + sandbox_id + ":" + policy_version

各字段含义：
  user_id      — 谁在操作（防止跨用户复用）
  session_id   — 哪个会话（防止跨会话复用）
  tool_name    — 哪个工具（防止跨工具复用）
  args_hash    — 什么参数（防止同工具不同参数复用）
  sandbox_id   — 哪个沙箱（防止跨环境复用）
  policy_version — 安全策略版本（策略变更后缓存失效）
```

**参考**：Manboster 的 `ignorance.SessionManager` 使用 tool ID 作为 key（`guard.go:83`），但也没有包含 args hash。AgentBoster 应该做得更安全。

**实现**：
- `agentd/internal/security/l2_auth/manager.go`：重写 cache key 构建逻辑
- `agentd/internal/security/l2_auth/cache_key.go`：新增 CacheKey 结构体 + Hash 方法

**预期产出**：
- `agentd/internal/security/l2_auth/cache_key.go`：安全的 cache key 构建
- `agentd/internal/security/l2_auth/manager.go`：使用新 cache key

---

## P2 — 增强差距（功能完善）

### 10. Go install 支持

**差距**：Manboster 支持 `go install` 一行安装，AgentBoster Daemon 需要手动克隆 + 编译。

**影响**：开发者安装体验差。

**方案**：
- 确保 `agentd/cmd/agentd/main.go` 的 `go install` 路径正确
- 添加版本注入（ldflags 已有）
- 更新 README 安装说明

**预期产出**：
- `README.md`：新增 go install 安装说明
- `agentd/cmd/agentd/main.go`：确保可独立安装

---

### 11. 消息召回（RecallRunner）—— 需能力检测

**差距**：Manboster 有 RecallRunner（工具调用确认消息在 5 秒后自动撤回），AgentBoster 无此机制。

**影响**：群聊场景中工具调用确认消息会堆积。

**⚠️ 异议 #4：不应放在 daemon l2_auth——应作为 channel/web 层能力**

删除消息是 Bot 适配器能力，不是所有平台都有权限或 API。应设计 capability 检测：
- Telegram：支持 DeleteMessage
- Discord：支持 DeleteMessage
- Slack：支持 chat.delete
- Teams：部分支持
- Google Chat：不支持
- Feishu：支持
- QQ：不支持

**⚠️ 异议 #5：capability 方向应是 daemon 查询 web，而非 daemon 暴露**

当前方案写 `server/routes.go: GET /capabilities`，这是错误的方向。AgentBoster 的通信模式是 **daemon → web**（通过 `clawless.Client` 调用 Web API），不是 web → daemon。Capability 应由 daemon 查询 Web 获取。

**⚠️ 异议 #17：Recall capability 缺 adapter/source 上下文**

删除消息必须知道 adapter、chat/thread/message id。当前 daemon Task 结构（`clawless/types.go`）无这些字段。`GET /api/agentd/v1/capabilities` 不能只返回"当前 adapter 能力"——需要 adapter/source 上下文才能执行删除。

**⚠️ 异议 #21：Recall 的 message_id 来源不对**

删除的是 **L2 确认消息本身**，不是 task/source 原始消息。计划说 Task 需要 message_id，但实际应是：
1. Daemon 发送 L2 确认通知 → Web 侧 send notification/reply 返回 **sent message id**
2. Recall timer 保存这个 sent message id
3. 5 秒后删除这个 sent message id

Task 不需要 message_id——recall 的 message_id 来自 notification 发送的返回值。

**方案（daemon 查询 web + adapter/source 上下文）**：
```
Web DB Schema 改动：
  0. lib/core/db/schema/agentd.ts：agentTasks 表新增 adapter + source metadata 字段
     （或从 sessions 表 join 获取：sessions.channel + sessions.externalThreadId）

Web 侧（capability 定义 + API 暴露）：
  1. lib/bot/adaptor.ts：BotAdapters 新增 capabilities 查询
  2. 每个 adapter 声明支持的操作：{ delete: boolean, edit: boolean, reaction: boolean }
  3. app/api/agentd/v1/capabilities/route.ts：
     GET /capabilities?adapter=telegram&chatId=xxx
     - 接收 adapter 参数（从 task.source 派生）
     - 返回该 adapter 的能力 + 所需上下文（chat_id, thread_id）

Daemon 侧（capability 查询 + 感知）：
  4. clawless/client.go：新增 GetCapabilities(adapter, chatId, threadId string) 方法
  5. clawless/types.go：新增 BotCapabilities + BotSource 结构体
  6. security/l2_auth/manager.go：发送确认消息时
     - 从 task.source 获取 adapter/chatId/threadId 信息
     - 调用 GetCapabilities(adapter, chatId, threadId) 查询能力
     - 如果 adapter 支持 delete → 发送 + 保存 sent message id + 启动 recall timer
     - 如果 adapter 不支持 delete → 仅发送，不 recall

⚠️ 异议 #25：Recall capability 方法签名不一致
  API 是 GET /capabilities?adapter=telegram&chatId=xxx，但 daemon 方法写
  GetCapabilities(adapter string)，少了 chatId/threadId/source。
  修正：GetCapabilities(adapter, chatId, threadId string) 或 GetCapabilities(source BotSource)

Recall 执行（web 侧）：
  7. lib/bot/reply.ts：新增 deleteMessage(adapter, chatId, messageId) 方法
  8. lib/workflow/：L2 确认 workflow 中调用 deleteMessage
  9. message_id 来源：notification/reply API 返回的 sent message id（非 task 原始消息）
  10. Recall timer 保存 sent message id，5 秒后调用 deleteMessage
```

**预期产出**：
- `lib/bot/adaptor.ts`：capabilities 查询
- `lib/bot/reply.ts`：deleteMessage 方法
- `app/api/agentd/v1/capabilities/route.ts`：capability API endpoint
- `agentd/internal/clawless/client.go`：GetCapabilities 方法
- `agentd/internal/clawless/types.go`：BotCapabilities 结构体
- `agentd/internal/security/l2_auth/manager.go`：capability 感知的 recall 逻辑

---

### 12. 工具可插拔配置

**差距**：Manboster 支持启用/禁用单个工具，AgentBoster 的工具是编译时固定注册的。

**影响**：用户无法按需禁用不需要的工具。

**⚠️ 异议 #22：Tools.Enabled 缺默认语义**

如果 `Tools.Enabled []string` 默认为空数组，会表示"启用空工具集"——破坏默认配置。

**修正方案（改用 Disabled 列表）**：
- 使用 `Tools.Disabled []string` 而非 `Tools.Enabled []string`
- 默认语义：
  - `nil`（未配置）= 启用全部工具
  - `[]`（显式空数组）= 启用全部工具
  - `["shell", "exec"]` = 禁用 shell 和 exec，其余启用
- 理由：禁用列表更安全——新增工具默认启用，只有明确禁用的才不注册

**方案**：
- `agentd/internal/config/config.go` 新增 `Tools.Disabled []string` 配置
- `agentd/internal/agent/tools_register.go` 的 `RegisterAllTools` 中过滤掉 Disabled 列表中的工具

**预期产出**：
- `agentd/internal/config/config.go`：新增 Tools 配置
- `agentd/internal/agent/tools_register.go`：条件注册

---

### 13. 贡献代码的测试要求

**差距**：Manboster CONTRIBUTING.md 要求"engine 包的贡献必须提供对应单元测试"，AgentBoster 明确无测试套件。

**影响**：代码质量无保障，回归风险高。

**方案**：
- 在 CONTRIBUTING.md 中制定测试规范
- 优先为安全模块（gatekeeper、L0 rules、L2 auth）编写测试
- 使用 `go test -race` 进行竞态检测

**预期产出**：
- `agentd/internal/security/gatekeeper_test.go`：gatekeeper 单元测试
- `agentd/internal/security/l0_rules/engine_test.go`：L0 规则测试
- `agentd/internal/agent/tools_exec_test.go`：工具执行测试

---

## P3 — 锦上添花（差异化可选）

### 14. TUI 交互界面 —— 路径统一

**差距**：Manboster 有完整的 Charmbracelet TUI，AgentBoster 仅有 Web UI。

**影响**：纯终端用户无法使用 AgentBoster。

**⚠️ 异议 #7：路径不一致——需统一到 daemon 子目录**

计划中混用 `agentd/cmd/agentd/` 和 `cmd/agentd/`，需统一。

**方案**：
- 所有 daemon 相关代码统一在 `agentd/` 下
- TUI 放在 `agentd/cmd/agentd/tui/`（与 main.go 同级）
- `agentd/cmd/agentd/main.go` 新增 `--tui` 命令
- 使用 `github.com/charmbracelet/huh` + `github.com/charmbracelet/lipgloss`

**预期产出**：
- `agentd/cmd/agentd/tui/`：TUI 包
- `agentd/cmd/agentd/main.go`：新增 `--tui` 命令

---

### 15. Vault 工具 —— 需独立设计

**差距**：Manboster 有实验性 vault 工具（敏感数据存储，LLM 无法访问），AgentBoster 无此工具。

**影响**：敏感数据（API Key、密码）无法安全存储。

**⚠️ 异议 #5：mTLS ≠ Vault——需独立加密设计**

mTLS 解决传输认证，不等于：
- Encryption-at-rest（静态加密）
- Key rotation（密钥轮换）
- LLM 不可读边界（确保 LLM 无法读取 vault 内容）
- Audit（谁在什么时候访问了什么）

**⚠️ 异议 #3：Vault 的"LLM 不可读边界"不成立**

当前 agent loop 中，**所有 ToolResult.Data 直接进入 LLM context**（`loop.go:142-146`）：
```go
resultJSON, _ := json.Marshal(toolResult)
l.messages = append(l.messages, Message{
    Role:    "tool",
    Content: string(resultJSON),
})
```
仅靠 tool description 写 "DO NOT expose to LLM" 不是安全边界——tool result 会被无条件序列化为 JSON 并追加到 messages。

**三种可行的 LLM 不可读方案**：

```
方案 A：独立用户侧通道（推荐）
  vault read 不返回 ToolResult，而是通过独立通道返回：
  - Daemon HTTP server 暴露 /vault/read 端点（仅 localhost）
  - 用户通过 curl/API 直接读取，不经过 agent loop
  - Agent 只知道 vault 中有哪些 key（名称列表），不知道 value

方案 B：Redacted Handle
  vault read 返回 redacted handle（如 "vault:api_key_***"）：
  - Agent 可以引用 handle（如 "使用 vault:api_key_*** 连接"）
  - 但无法获取明文
  - 实际使用时由 daemon 在执行前替换为真实值
  - 缺点：需要修改所有工具执行逻辑

方案 C：完全禁止 agent 读取
  vault 工具不注册为 agent tool：
  - Agent 完全无法访问 vault
  - 用户通过 CLI/API 直接操作 vault
  - 最安全，但丧失 agent 自动化能力
```

**推荐方案 A**：Web 侧存储 + 鉴权代理。Vault 数据存在 Web 侧（Postgres），Web API 直接读取。

**⚠️ 异议 #10：localhost 不适配 Web 用户**

AgentBoster 是 Web 平台，用户通过 Vercel Dashboard（Web）访问，无法直接访问 daemon 的 localhost。

**⚠️ 异议 #12：Vault 数据流不闭合**

`clawless.Client` 是 daemon 调 Web 的客户端，不是 Web 调 daemon。计划中"Web /api/vault/read + daemon VaultRead()"方向混乱。需要先决定 vault 数据存哪里。

**决定：Vault 数据存 Web 侧（Postgres）**

理由：
- Web 侧已有 Postgres（Neon）+ Vercel Blob，存储基础设施完善
- Web API 可直接读取，无需 daemon 入站 API
- Daemon 无本地数据库（`agentd` 无 DB 依赖），不适合存储 vault 数据
- 加密在 Web 侧完成，daemon 不接触明文

**修正方案（Web 侧存储）**：
```
数据存储（Web 侧）：
  1. Postgres 新增 vault_entries 表（id, key, encrypted_value, nonce, created_at）
  2. 主密钥从环境变量 VAULT_MASTER_KEY 读取（Web 侧 env var）
  3. 加密/解密在 Web 侧完成

LLM 不可读边界：
  4. vault_list 注册为 daemon agent tool（返回 key 名称列表，不含 value）
  5. vault_read 不注册为 agent tool
  6. Web 侧新增 app/api/vault/read/route.ts（鉴权后返回明文）
  7. Web 用户通过 Dashboard vault 页面读取明文

Daemon 不参与 vault 读取：
  8. Daemon 无 vault API 端点
  9. Daemon 不持有 VAULT_MASTER_KEY
  10. Daemon 仅通过 vault_list 获取 key 名称（供 agent 上下文使用）
```

**⚠️ 异议 #11：Vault 工具注册需明确**

计划说"vault read 不注册为 agent tool"，但预期产出仍写 `tools_vault.go` 注册 vault。需明确：
- **注册为 agent tool**：`vault_list`（返回 key 名称列表，LLM 可读）
- **不注册为 agent tool**：`vault_read`（返回明文，LLM 不可读）
- **Web 侧**：`/api/vault/read` 端点（鉴权后返回明文）

**完整方案**：
```
Encryption-at-rest（Web 侧）：
  1. Postgres 新增 vault_entries 表（id, key, encrypted_value, nonce, created_at）
  2. 使用 AES-256-GCM 加密 vault 数据
  3. 主密钥从环境变量 VAULT_MASTER_KEY 读取（Web 侧 env var，不存文件）
  4. 每条 vault 记录使用独立 nonce

Key rotation（Web 侧）：
  5. 支持 VAULT_MASTER_KEY 轮换（重新加密所有数据）
  6. 轮换期间支持双密钥读取

LLM 不可读边界（Web 侧存储）：
  7. vault_list 注册为 daemon agent tool（返回 key 名称列表，LLM 可读）
  8. vault_read 不注册为 agent tool
  9. Web 侧 app/api/vault/read/route.ts（鉴权后返回明文）
  10. Web 侧 app/api/vault/list/route.ts（鉴权后返回 key 名称列表）
  11. Web 用户通过 Dashboard vault 页面读取明文
  12. Daemon vault_list tool 通过 clawless.Client 调用 Web API 获取 key 列表
  13. Daemon 不持有 VAULT_MASTER_KEY，不接触明文

Daemon vault_list 调用链：
  agent tool vault_list → clawless.Client.ListVaultKeys() → Web API /api/vault/list → 返回 key 名称列表

⚠️ 异议 #28：Vault daemon list endpoint 鉴权不匹配
  middleware.ts:29-30：只有 /api/agentd/v1/* 走 AGENTD_API_KEY 放行。
  /api/vault/list 需要 web login cookie，daemon 没有 cookie 调不了。

  修正：拆成两个端点：
    Web 侧（Dashboard 用户）：
      app/api/vault/list/route.ts — 鉴权后返回 key 名称 + 值摘要
    Daemon 侧（vault_list tool）：
      app/api/agentd/v1/vault/list/route.ts — AGENTD_API_KEY 鉴权，只返回 key 名称
      clawless.Client 调此端点，不走 /api/vault/list

Audit（Web 侧）：
  12. 所有 vault 操作写入 audit log（who/when/what/action）
  13. 审计日志不可被 LLM 读取
```

**预期产出**：
- `lib/core/db/schema/vault.ts`：vault_entries 表定义
- `app/api/vault/read/route.ts`：Web 侧鉴权读取端点
- `app/api/vault/list/route.ts`：Web 侧 vault 管理端点
- `app/api/agentd/v1/vault/list/route.ts`：Daemon vault_list tool 端点（AGENTD_API_KEY 鉴权，只返回 key 名称）
- `lib/vault/`：Web 侧加密/解密/审计逻辑
- `agentd/internal/clawless/client.go`：ListVaultKeys() 方法（daemon → web 查询 key 列表）
- `agentd/internal/agent/tools_vault.go`：`vault_list` 工具（通过 clawless.Client 调 Web API）
- `agentd/internal/agent/tools_register.go`：仅注册 vault_list

---

## 执行顺序建议

```
第一阶段（P0，安全与架构）：
  1. 工具级权限控制（MinUserType + 完整信任链）—— 跨 Web/daemon 协议前置设计依赖
  2. 安全层默认开启 + L1 可用性校验 + 自动降级 —— 前置：L1 降级逻辑
  3. Fail-close 安全策略 —— 前置：第 2 项完成

第二阶段（P1，用户体验）：
  4. 国际化（i18n）—— 范围限定：仅用户可见错误和交互文本
  5. 配置版本管理
  6. CONTRIBUTING.md
  7. SECURITY.md
  8. 重复消息检测 —— 幂等键优先（platform msg_id > task_id > content hash）
  9. 反向 TTL 缓存 —— 安全 cache key（user+session+tool+args+sandbox+policy）

第三阶段（P2，功能完善）：
  10. Go install 支持
  11. 消息召回 —— capability 检测 + channel/web 层暴露
  12. 工具可插拔配置
  13. 测试套件

第四阶段（P3，差异化）：
  14. TUI 交互界面 —— 路径统一到 agentd/cmd/agentd/
  15. Vault 工具 —— 独立加密设计（非 mTLS）
```

---

## 影响评估

| 优先级 | 数量 | 预估工作量 | 核心价值 |
|--------|------|-----------|----------|
| P0 | 3 项 | 3-5 天 | 安全架构对齐（含信任链设计） |
| P1 | 6 项 | 4-6 天 | 用户体验对齐（含安全 cache key） |
| P2 | 4 项 | 3-4 天 | 功能完善（含 capability 检测） |
| P3 | 2 项 | 4-6 天 | 差异化可选（含独立加密设计） |
| **合计** | **15 项** | **14-21 天** | — |

---

## 风险提示

1. **MinUserType 信任链**是最高复杂度变更——需 Web DB schema 改动 + Web API 重新校验 roles + Daemon 协议扩展
2. **信任链方向**——Web 根据 task.sessionId → sessions.userId → users.roles 派生身份，不信任 daemon 请求头
3. **Roles 映射**——Manboster root/admin/user/unknown 与 Web roles 数组的映射需明确定义，多 role 取最高
4. **无 session task**——sessionId=null 时信任链断裂，userId=null → unknown，仅允许低权限工具
5. **Fail-close + 安全层默认开启**是最高风险变更——L1 默认值会绕过"未配置"判断，必须做启动时健康检查
6. **L1 unknown provider**——配置拼写错误会静默降级安全层，unknown provider 必须启动失败
7. **L1 降级语义**——L1 不可用时所有通过 L0 的工具调用都要求 L2 确认（无 L1 score 无法判定风险）
8. **安全 cache key**——args_hash 需要稳定序列化
9. **消息召回 capability**——需 adapter/source 上下文，message_id 来自 notification 返回值（非 task 原始消息）
10. **Review logs 路由**——正确路径是 `app/(chat)/api/agentd/v1/review-logs/route.ts`，不是 tasks/[id]
11. **Vault 数据存储**——存在 Web 侧（Postgres），daemon 通过 clawless.Client.ListVaultKeys() 调 Web API
12. **Vault LLM 不可读边界**——vault_read 不注册为 agent tool
13. **Tools.Disabled**——使用 Disabled 列表而非 Enabled，nil/空 = 全部启用
14. **重复消息检测**——已有 Web 侧 dedup，需增强而非从零实现
15. **L0 文案**——区分：命中阻断规则 → 拒绝；引擎错误 → fail-close；无规则命中 → 继续
16. **i18n 范围**——限定为用户可见错误，结构化日志保持英文
17. **路径准确性**——Web 应用在仓库根目录，无 `web/` 子目录

### P0 执行依赖关系

```
第 1 项（MinUserType + 信任链）—— 跨 Web/daemon 协议前置设计依赖，需 Web 侧配合
第 2 项（安全层默认开启）—— 必须先实现 L1 可用性校验 + 自动降级
第 3 项（fail-close）—— 必须在第 2 项之后，且依赖 L1 降级逻辑
```

**正确执行顺序**：
1. 先做第 1 项（MinUserType + 信任链）—— 需 Web 侧多用户改造 + Task 协议扩展
2. 再做第 2 项（安全层默认开启）—— 同时实现 L1 可用性校验 + 自动降级
3. 最后做第 3 项（fail-close）—— 基于第 2 项的降级逻辑

---

> 计划生成日期：2026-06-08
> 基于：results.md 对比分析 + REPORT.md 竞品分析
> 审查：40 轮技术异议（信任链、cache key、幂等键、capability、加密、i18n 范围、路径统一、零信任措辞、Vault LLM 边界、MinUserType 依赖、Recall 方向、路径错误、L1 默认值绕过、字段名不一致、Vault 内部矛盾、localhost 不适配、Web 已有 roles、dedup 已存在、Vault 数据流方向、Vault API 路径、L1 unknown provider、L0 文案歧义、信任链方向、Web DB schema、ReviewLog schema、Recall adapter context、L1→L2 语义、vault_list 调用链、Roles 映射、无 session task、Review logs 路由、Recall message_id、Tools.Disabled 语义、admin→root 风险、readonly 语义、Recall 方法签名、admin 提权、Vault daemon 鉴权、roles 校验矛盾、owner bootstrap）
