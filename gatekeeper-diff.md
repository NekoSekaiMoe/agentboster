# Manboster vs AgentBoster Gatekeeper 详细对比

## 1. 架构概览

| 维度 | Manboster Gatekeeper | AgentBoster Gatekeeper |
|------|---------------------|----------------------|
| **代码位置** | `manboster/internal/engine/gatekeeper/` | `agentd/internal/security/gatekeeper.go` |
| **语言/运行时** | Go 单体应用 | Go 守护进程 + Next.js Web 层协作 |
| **设计哲学** | IM 聊天中的零信任交互式审批 | 多层自动化安全流水线 |
| **调用频率** | 每次 tool call 都拦截 | 按任务批量审计 |
| **异步模型** | 同步阻塞（等待用户按钮响应） | 异步事件驱动（事件总线 + L2 缓存） |

---

## 2. 安全层级对比

### Manboster — 单层 + Hachimi 预判

```
Tool Call 请求
    │
    ├─ CheckSession (Ignorance 记忆检查)
    │   └─ 已拒绝？→ 直接拒绝
    │
    ├─ Ignorance Mark 检查（session级 / tool级）
    │   ├─ MarkCancelAll → 拒绝
    │   ├─ MarkContinueAll → 放行
    │   └─ MarkHachimiAll → 走 Hachimi
    │
    ├─ Hachimi 本地模型评估（可选）
    │   ├─ Safe → 自动放行 + 缓存
    │   ├─ Inspect → 提示用户选择 Allow/Deny/Allow-Suspicious
    │   └─ Unsafe → 提示用户选择 Allow/Deny
    │
    └─ 用户按钮交互（最终决策）
        ├─ Continue (本次放行)
        ├─ ContinueAll (10分钟全部放行)
        ├─ Ignore / ShutUp (静默放行一段时间)
        ├─ Cancel (本次拒绝)
        ├─ CancelIgnore (15分钟拒绝该工具)
        ├─ CancelAll (10分钟全部拒绝)
        ├─ HandleHachimi (交给 Hachimi 判断)
        └─ HandleHachimiAll (1小时全交 Hachimi)
```

### AgentBoster — 三层自动化 + L2 Web 授权

```
命令请求
    │
    ├─ Tier 1: L0 Rules Engine（正则模式匹配）
    │   ├─ 匹配 block 规则 → 直接拒绝（模拟 OS 错误消息）
    │   ├─ 匹配 warn 规则 → 继续到 L1
    │   └─ 无匹配 → 继续到 L1
    │
    ├─ Tier 2: L1 LLM Scorer（Flash 模型风险评分）
    │   ├─ low (0.0-0.39) → 静默放行
    │   ├─ medium (0.4-0.69) → 放行 + 通知用户
    │   ├─ high (0.7-0.89) → 需要 L2 授权
    │   └─ critical (0.9-1.0) → 需要 L2 高危授权
    │
    ├─ L1 结果加固（hardenL1Result）
    │   ├─ 未知 level → 强制转为 high
    │   └─ 确定性危险模式 → 强制提升为 high
    │
    └─ Tier 3: L2 Web 授权（事件总线通知）
        ├─ L2 缓存命中 → 直接放行/拒绝
        ├─ 待授权 → 发布 EventL2AuthRequired 事件
        └─ 用户在 Web 仪表板审批
```

---

## 3. 核心组件对比

### 3.1 风险评估模型

| 维度 | Manboster (Hachimi) | AgentBoster (L1 Scorer) |
|------|---------------------|------------------------|
| **模型类型** | 本地 GGUF 模型（on-device） | 远程 LLM API 或本地 Ollama |
| **模型名称** | Hachimi（猫咪主题） | 通用 Flash LLM |
| **运行位置** | 应用进程内 | Web 层 /agentd 调用 Web API（支持本地 Ollama） |
| **评估对象** | 工具调用请求 | Shell 命令 + LLM 输出内容 |
| **输出分类** | Safe / Inspect / Unsafe | low / medium / high / critical |
| **评估维度** | 工具调用安全性 | 10 维风险评估（沙箱逃逸、提权、破坏性操作等） |
| **缓存机制** | `SetHachimiCache` 基于描述哈希 | L2 缓存基于 session + pattern |
| **离线能力** | 完全离线（本地 GGUF 模型） | 可离线（配置 Ollama preset 走本地 `127.0.0.1:11434`）；也可走远程 API |

### 3.2 L0 规则引擎（仅 AgentBoster）

Manboster **没有** L0 规则引擎层。AgentBoster 的 L0 是一个完整的正则规则系统：

- **规则类型**：command（命令模式）、path（路径访问）、network（网络工具）
- **匹配方式**：glob → regex 两级级联
- **内置预设**：44 条规则（25 命令 + 7 路径 + 3 网络 + 9 输出安全）
- **输出审计**：检测系统提示词泄露、凭据暴露、注入模式
- **热重载**：支持通过 ClawLess API 动态更新规则
- **OS 错误伪装**：拦截时返回 `sh: rm: Operation not permitted` 而非暴露安全规则
- **线程安全**：sync.RWMutex + sync.Map 编译缓存

预设规则示例：
```go
// 命令黑名单
{ID: "cmd-rm-rf-root",      Pattern: "rm -rf /"}
{ID: "cmd-sudo",            Pattern: "sudo\\s"}
{ID: "cmd-curl-pipe-bash",  Pattern: "curl.*\\|\\s*bash"}

// 路径黑名单
{ID: "path-etc-shadow",     Pattern: "/etc/shadow"}
{ID: "path-etc-ssh",        Pattern: "/etc/ssh/"}
{ID: "path-home-ssh",       Pattern: "~/.ssh/"}

// 网络黑名单
{ID: "net-nmap",            Pattern: "nmap\\s"}
{ID: "net-hydra",           Pattern: "hydra"}

// 输出安全规则
{ID: "out-system-prompt-leak",  Pattern: "(?i)your\\s+system\\s+prompt"}
{ID: "out-api-key-leak",        Pattern: "(?i)api[_-]?key\\s*[:=]"}
{ID: "out-private-key-leak",    Pattern: "-----BEGIN.*PRIVATE KEY-----"}
```

### 3.3 确定性 L2 模式（仅 AgentBoster）

AgentBoster 有一个额外的确定性检查层，即使 L1 评分为 low，以下模式也会被强制提升为 high：

```go
var deterministicL2Patterns = []struct{ reason, regex }{
    {"uses shred to overwrite file contents",           `shred`},
    {"uses find -exec with a destructive command",       `find.*-exec.*(?:rm|shred|dd|truncate|wipefs)`},
    {"uses find -delete for bulk deletion",              `find.*-delete`},
    {"pipes file lists into a destructive command",      `xargs.*(?:rm|shred|dd|truncate|wipefs)`},
    {"uses interpreter one-liner for destructive ops",   `(?:perl|ruby|node).*-e.*(?:unlink|rmtree|rm\s+-rf|shred)`},
    {"uses Python one-liner for destructive ops",        `python3?.*-c.*(?:shutil\.rmtree|os\.(?:remove|unlink)|rm\s+-rf|shred)`},
}
```

### 3.4 用户授权机制

| 维度 | Manboster | AgentBoster |
|------|-----------|------------|
| **授权方式** | 聊天平台按钮交互 | Web 仪表板通知 + 审批 |
| **授权粒度** | 按工具调用 + 按 session | 按命令模式（pattern） |
| **缓存格式** | `instance:chatId:sid:toolName:group` | SHA256(`userID \x00 sessionID \x00 toolName \x00 argsHash \x00 sandboxID \x00 policyVersion`) |
| **TTL 策略** | 基于用户权限级别（4h/2h/30min） | `hhddmmyy` 格式（时/日/月/年） |
| **会话级批量操作** | ContinueAll / CancelAll（10分钟） | `always` = 会话生命周期 |
| **取消机制** | CancelIgnore（15分钟）/ CancelAll | Reject + 缓存 |
| **过期处理** | Ignorance Manager 自动清理 | 后台 cleanup worker（30秒间隔） |
| **超时机制** | 无明确超时 | 3 分钟默认超时 + 升级机制 |
| **并发控制** | 无 | 同 task 最多 3 个并发授权请求 |

### 3.5 记忆/状态管理

| 维度 | Manboster (Ignorance) | AgentBoster (L2 Auth) |
|------|----------------------|----------------------|
| **存储结构** | `map[string]MarkData`（内存） | `map[string]*L2AuthEntry`（内存） |
| **Mark 类型** | MarkIgnore, MarkCancel, MarkContinue, MarkHachimi, MarkHachimiAll, MarkHachimiAllSuspicious, MarkCancelAll, MarkContinueAll | ActionPass, ActionReject |
| **键格式** | `instance:chatId:sid:toolName:group` | SHA256(userID + sessionID + toolName + argsHash + sandboxID + policyVersion) |
| **清理策略** | 按 TTL 自动过期 | 后台 goroutine 每 30 秒清理 |
| **审计日志** | 无 | 过期时写入 ClawLess ReviewLog |
| **会话清理** | `Clear(sessionId)` | `ClearSession(sessionId)` |

---

## 4. 批量处理（仅 AgentBoster）

AgentBoster 的 `AuditBatch` 支持对多个命令进行批量安全审计：

```
commands[] 
    │
    ├─ L0: 并行检查（sync.WaitGroup）
    │   └─ 每个命令独立检查，命中则标记 blocked
    │
    ├─ L1: 批量评分（单次 LLM 调用）
    │   ├─ token-bomb 防护：总字符 > 4096 则降级为逐条评分
    │   └─ 失败时自动 fallback 到逐条 Score()
    │
    └─ L2: 逐条检查 L2 缓存
        ├─ 缓存命中 → 直接决策
        └─ 未命中 → 发布 EventL2AuthRequired
```

Manboster 没有批量处理能力，每次 tool call 都是独立的同步流程。

---

## 5. 操作系统级安全（仅 AgentBoster）

AgentBoster 额外提供 OS 级别的安全加固：

### 5.1 Seccomp Profile
```go
// 阻止的系统调用类别：
- 内核模块加载：init_module, finit_module, delete_module
- 系统重启：reboot
- 文件系统操作：mount, umount2, pivot_root
- 进程追踪（容器逃逸防护）：ptrace, process_vm_readv/writev
- 命名空间创建：unshare, clone3
- BPF/JIT（内核代码注入防护）：bpf, perf_event_open
- 凭据窃取防护：add_key, request_key, keyctl
- 终端注入防护：ioctl TIOCSTI
```

### 5.2 特权降级
```go
// DropPrivileges: 从 root 降权到非特权用户
// 设置 HOME, SHELL, USER 环境变量
// 解析并设置完整的补充组列表
// 验证降权后无法恢复 root
```

### 5.3 Linux Capabilities
- `os_enforce/capabilities.go` — Linux capabilities 管理
- `os_enforce/policy.go` — 安全策略定义

Manboster 没有这些 OS 级安全机制，因为它运行在应用层而非系统层。

---

## 6. 输出安全审计（仅 AgentBoster）

AgentBoster 对 LLM 生成的输出内容也进行安全审计：

```
LLM 输出内容
    │
    ├─ L0 Output Check（输出规则匹配）
    │   ├─ 系统提示词泄露检测
    │   ├─ 凭据暴露检测（API key, password, private key）
    │   ├─ 内部路径泄露检测
    │   └─ 注入模式检测（DAN, jailbreak）
    │
    └─ L1 Output Score（LLM 风险评分）
        ├─ low → 放行
        ├─ medium → 放行 + 警告
        └─ high/critical → 拦截
```

Manboster 没有输出审计机制。

---

## 7. 事件总线与可观测性（仅 AgentBoster）

AgentBoster 使用 `eventbus` 进行组件间通信：

```go
// 事件类型
EventSecurityAlert    // L0/L1 安全告警
EventL2AuthRequired   // L2 授权请求
```

**审计日志**：每层决策都生成 `ReviewLog`，记录：
- `task_id` — 任务标识
- `command` — 命令内容
- `level` — 审计层级（L0/L1/L2）
- `score` — 风险评分
- `decision` — 决策结果
- `reason` — 决策原因

Manboster 没有事件总线或结构化审计日志。

---

## 8. 可配置性

| 维度 | Manboster | AgentBoster |
|------|-----------|------------|
| **失败策略** | 无配置（Hachimi 不可用时直接报错） | `failOpen` / `failClosed` 可配置 |
| **L1 开关** | 无（Hachimi 可选启用） | `l1Enabled` 可完全禁用 L1 |
| **规则热重载** | 无 | L0 支持 `Reload()` + `ReloadOutputRules()` |
| **L1 批量模式** | 无 | 可配置 token-bomb 阈值 |
| **超时时间** | 固定（10分钟/15分钟/1小时） | 可配置（默认 3 分钟 + 5 分钟升级） |
| **用户权限分级** | UserUnknown / UserAdmin / UserRoot | userType 在 cache key 中 |

---

## 9. 交互界面对比

### Manboster — 聊天按钮

**无 Hachimi 时的选项**（6 个按钮）：
1. 本次同意 (Continue)
2. 全部同意 10 分钟 (ContinueAll)
3. 同意一段时间 (Ignore/ShutUp)
4. 本次拒绝 (Cancel)
5. 15 分钟内都拒绝 (CancelIgnore)
6. 10 分钟内全拒绝 (CancelAll)

**有 Hachimi 时的选项**（8 个按钮）：
1-6 同上 +
7. 让 Hachimi 来处理 (HandleHachimi)
8. 1小时内全让 Hachimi 处理 (HandleHachimiAll)

**Hachimi Unsafe 后的选项**（2 个按钮）：
- 允许 (Allow)
- 拒绝 (Deny)

**Hachimi Suspicious 后的选项**（3 个按钮）：
- 允许 (Allow)
- 一小时内允许可疑行为 (AllowSuspicious)
- 拒绝 (Deny)

### AgentBoster — Web 仪表板

- L1 medium → 非阻塞通知（event bus 推送）
- L1 high/critical → L2 授权弹窗（DecisionQueue 管理）
  - 命令 diff 预览（高亮危险片段）
  - 风险评分和原因
  - Allow / Reject 按钮
  - 支持 "once" / "always" / "hhddmmyy" 持续时间选择

---

## 10. 安全哲学对比

| 维度 | Manboster | AgentBoster |
|------|-----------|------------|
| **默认策略** | 零信任（每次都要用户确认） | 分层信任（L0 自动 → L1 自动 → L2 人工） |
| **用户参与度** | 高（每个工具调用都要操作） | 低（仅高风险需要人工介入） |
| **AI 辅助** | Hachimi 本地 GGUF 模型预判 | L1 LLM 评分（支持远程 API 或本地 Ollama） |
| **自动化程度** | 低（依赖用户决策） | 高（多层自动过滤） |
| **安全深度** | 浅（单层 + 缓存） | 深（L0+L1+L2+OS 级） |
| **误报处理** | 用户手动选择 Allow | L2 缓存 + 持续时间控制 |
| **批处理能力** | 无 | 有（AuditBatch） |
| **输出审计** | 无 | 有（L0+L1 输出检查） |
| **OS 级隔离** | 无 | Seccomp + Capabilities + 特权降级 |

---

## 11. 文件结构对比

### Manboster Gatekeeper

```
manboster/internal/engine/gatekeeper/
├── gatekeeper.go    # Service 定义和构造
├── guard.go         # Guard 核心逻辑（159行）
├── check.go         # CheckSession（16行）
├── select.go        # 用户选择交互（31行）
├── hachimi.go       # Hachimi 模型集成（105行）
├── type.go          # 选择类型定义（59行）
├── build.go         # Session ID 构建（11行）
└── errors.go        # Hachimi 错误定义（10行）

总计：~400 行
```

### AgentBoster Gatekeeper

```
agentd/internal/security/
├── gatekeeper.go           # Gatekeeper 核心（699行）
├── gatekeeper_test.go      # 单元测试（169行）
├── privilege.go            # 特权降级（120行）
├── privilege_test.go       # 特权降级测试
├── l0_rules/
│   ├── engine.go           # L0 规则引擎（209行）
│   ├── engine_test.go      # L0 引擎测试
│   ├── loader.go           # 规则加载器
│   └── presets.go          # 内置规则预设（97行）
├── l2_auth/
│   ├── manager.go          # L2 授权管理（528行）
│   ├── manager_test.go     # L2 管理测试
│   ├── cache_key.go        # 缓存键构建
│   └── command_review_test.go
└── os_enforce/
    ├── seccomp.go          # Seccomp 配置（206行）
    ├── capabilities.go     # Linux Capabilities
    └── policy.go           # 安全策略

Web 层（lib/security/）:
├── l1-scorer.ts            # L1 评分器（169行）
├── l1-model.ts             # L1 模型配置
├── l2-decision-queue.ts    # L2 决策队列（287行）
└── l2-index.ts             # L2 导出

总计：~2500+ 行
```

---

## 12. 总结

| 场景 | Manboster 更适合 | AgentBoster 更适合 |
|------|-----------------|-------------------|
| **IM 聊天机器人** | ✅ 按钮交互天然适配 | ❌ 需要额外的 Web 界面 |
| **服务器守护进程** | ❌ 不适合长驻进程 | ✅ 批量审计 + 事件驱动 |
| **高安全性场景** | ⚠️ 单层防护 | ✅ 多层防御 + OS 级隔离 |
| **低延迟要求** | ✅ 本地模型零网络延迟 | ⚠️ 远程 LLM 有延迟；Ollama 本地推理延迟取决于模型大小 |
| **离线环境** | ✅ Hachimi 完全离线 | ✅ 配置 Ollama 后可完全离线 |
| **批量任务** | ❌ 逐个处理 | ✅ 批量审计 + token-bomb 防护 |
| **输出安全** | ❌ 无 | ✅ L0+L1 输出审计 |
| **运维友好** | ⚠️ 无热重载 | ✅ 规则热重载 + 审计日志 |
