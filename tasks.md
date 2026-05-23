好的，以下是一份面向 LLM 的 AgentClaw 完整实现文档。仅包含结构定义与接口定义，不含具体实现代码。在关键模块指引中标注了需参考 OpenCode 和 Manboster 源码对应部分的说明。

---

# AgentClaw 实现文档

本文件为 AgentClaw 项目的完整实现指引，面向开发 LLM。只提供结构体定义、接口定义和实现要点。所有新增代码放在 `lib/extra/` 目录下，ClawLess 原有架构保持不变。

## 目录
1. LLM 安全打分
2. L0/L1/L2 三级权限管理
3. 多类型沙箱 (tmpfs/docker/lxc/chroot)
4. 并行 Agents
5. OpenClaw Skill 兼容与自动安装
6. 外部主机操作 (Agent Daemon)
7. 多 IM 通知与操作
8. 多用户认证 (JWT/API Token/密码)
9. LLM 计划任务
10. 定时轮询与动态 Worker (参考 Asika)
11. 数据库支持 (Vercel DB / MongoDB)
12. 持久化记忆 (参考 asikaclaw)
13. 初始提示词 (参考 Manboster + 并行 Agent + 沙箱)
14. 配置文件结构

---

## 一、LLM 安全打分模块
**位置：** `lib/extra/security/scorer/`

### 结构体定义
```
ScoreRequest {
    action: string          // 操作描述
    command?: string        // 原始命令
    context: {
        workingDirectory: string
        sandboxType: string
        userId: string
        agentId: string
        taskDescription: string
    }
}

ScoreResponse {
    level: "safe" | "inspect" | "unsafe"
    score: number           // 0-100
    reasoning: string
    requiresConfirmation: boolean
}

LocalScorerConfig {
    baseUrl: string         // 局域网内 LLM URL
    model: string
    timeout: number
}

RemoteScorerConfig {
    baseUrl: string
    apiKey: string
    model: string
    timeout: number
}
```

### 接口定义
```
interface IScoringProvider {
    evaluate(req: ScoreRequest): Promise<ScoreResponse>
    evaluateBatch(reqs: ScoreRequest[]): Promise<ScoreResponse[]>
    readonly name: string
    readonly type: "local" | "remote"
}
```

### 实现指引
- 本地/远程 Provider 均需兼容 OpenAI 兼容 API。
- **提示词要求：** 请阅读 **Manboster** 源码中 `Hachimi` 安全裁决模型的 system prompt 设计，参考其 `unsafe/inspect/safe` 三档判断标准，编写本模块的打分 System Prompt。需明确各类命令的风险等级。

---

## 二、L0/L1/L2 三级权限管理
**位置：** `lib/extra/security/`

### 2.1 L0 规则引擎 (`l0_rules/`)

#### 结构体定义
```
L0Rule {
    id: string
    name: string
    description: string
    pattern: string            // 正则或glob
    patternType: "regex" | "glob"
    action: "allow" | "block" | "escalate"
    notifyOnBlock: boolean
    allowTemporaryOverride: boolean   // 是否允许临时放行
    overrideWindowSeconds: number     // 临时放行时长
    priority: number
    enabled: boolean
}

L0Result {
    matched: boolean
    rule: L0Rule | null
    action: string
    message: string
}
```

#### 接口定义
```
interface IL0RuleEngine {
    evaluate(command: string, workingDirectory: string): Promise<L0Result>
    addRule(rule: L0Rule): void
    removeRule(id: string): void
    reloadRules(): void
}
```

#### 预设规则指引
- 必须包含：`rm -rf /`、`mkfs`、`dd`、访问 `/etc/shadow`、非工作目录路径（允许临时放行）。
- 正则/glob 匹配逻辑参考 **Asika** 的 Label Rules 实现。

### 2.2 L1 模型打分 (`l1_scorer/`)

```
L1Result {
    level: "safe" | "inspect" | "unsafe"
    score: number
    reasoning: string
    escalated: boolean         // 是否升级到 L2
}
```

```
interface IL1Scorer {
    evaluate(req: ScoreRequest): Promise<L1Result>
}
```
- 调用 LLM 安全打分 Provider（`IScoringProvider`）。当分数高于阈值 (默认 70) 时升级为 L2。

### 2.3 L2 交互授权 (`l2_auth/`)

```
L2AuthorizationWindow = "once" | "10min" | "1hour" | "1day" | "session"

L2AuthRequest {
    id: string
    action: string
    risk: { level: string; score: number; reasoning: string }
    timestamp: number
    channelId: string
    userId: string
}

L2AuthResponse {
    requestId: string
    authorized: boolean
    window?: L2AuthorizationWindow
    rejectedReason?: string
}
```

```
interface IL2AuthManager {
    requestAuthorization(req: L2AuthRequest): Promise<void>     // 通过 IM 发送确认
    handleResponse(resp: L2AuthResponse): Promise<void>
    isAuthorized(action: string, window: L2AuthorizationWindow): boolean
    revokeSession(userId: string): void
}
```

### 2.4 三级联动 Gatekeeper

```
interface ISecurityGatekeeper {
    evaluate(req: ScoreRequest): Promise<{
        authorized: boolean
        level: "L0" | "L1" | "L2"
        details: L0Result | L1Result | L2AuthRequest
        notificationSent: boolean
    }>
    handleL2Response(resp: L2AuthResponse): Promise<void>
}
```
- 流程：L0 规则引擎 → L1 打分 → L2 授权。
- **提示词要求：** 在 L2 授权消息模板中，参考 **OpenCode** 的交互询问方式（once/always/reject），扩展为时间窗口选项。

---

## 三、多类型沙箱
**位置：** `lib/extra/sandbox/`

### 结构体定义
```
SandboxType = "tmpfs" | "docker" | "lxc" | "chroot"

SandboxConfig {
    type: SandboxType
    image?: string              // Docker/LXC 镜像
    chrootPath?: string         // chroot 路径
    persist: boolean            // 是否持久化
    resources?: {
        cpuLimit: string
        memoryLimit: string
        diskLimit: string
    }
}

SandboxInfo {
    id: string
    type: SandboxType
    status: "creating" | "ready" | "running" | "destroyed"
    workspacePath: string       // 容器内工作目录
}
```

### 接口定义
```
interface ISandboxProvider {
    create(config: SandboxConfig): Promise<SandboxInfo>
    execute(sandboxId: string, command: string, env?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }>
    destroy(sandboxId: string): Promise<void>
    getStatus(sandboxId: string): Promise<SandboxInfo>
    listSandboxes(userId?: string): Promise<SandboxInfo[]>
}
```

### 管理器接口
```
interface ISandboxManager {
    selectSandbox(task: TaskRequest, userPreference?: SandboxType): Promise<SandboxInfo>
    createSandbox(config: SandboxConfig): Promise<SandboxInfo>
    execute(sandboxId: string, command: string): Promise<...>
    destroySandbox(sandboxId: string): Promise<void>
}
```

- **自动选择逻辑**：轻量一次性任务→tmpfs，需持久化环境→chroot/lxc，高风险不可信代码→docker。
- 需在 Agent 初始提示词中写入沙箱选择策略。
- **注意：** 参考 **Manboster** 的 WASM 沙箱设计思路，但本系统使用传统沙箱。参考 **Memoh** 的容器 workspace 生命周期。

---

## 四、并行 Agents 功能
**位置：** `lib/extra/agent/parallel/`

### 结构体定义
```
SubAgentTask {
    id: string
    parentTaskId: string
    description: string
    context: Record<string, any>
    sandboxConfig: SandboxConfig
    timeout: number
}

SubAgentResult {
    taskId: string
    success: boolean
    output: string
    error?: string
    duration: number
}
```

### 接口定义
```
interface IParallelOrchestrator {
    createSubAgent(parentTaskId: string, tasks: SubAgentTask[]): Promise<SubAgentResult[]>
    getSubAgentStatus(taskId: string): Promise<SubAgentResult>
    cancelSubAgent(taskId: string): Promise<void>
}
```
- 实现时通过远程 Agent Daemon 分配任务，支持并发执行。
- **提示词要求：** 需在系统提示词中加入“如何创建和管理子 Agent”的规则，参考 **OpenCode** 的 `spawn` 子进程模型和 **Manboster** 的 Sub-agent 工具调用逻辑。

---

## 五、OpenClaw Skill 兼容
**位置：** `lib/extra/agent/skills/`

### 结构体定义
```
SkillManifest {
    name: string
    version: string
    description: string
    main: string                // 入口文件 (SKILL.md 或 .mjs)
    dependencies?: string[]
    permissions?: string[]
}

SkillInstallOptions {
    source: string              // URL 或 ClawHub 包名
    autoRestart: boolean
}
```

### 接口定义
```
interface ISkillLoader {
    loadFromFile(path: string): Promise<SkillManifest>
    install(options: SkillInstallOptions): Promise<SkillManifest>
    uninstall(skillName: string): Promise<void>
    listInstalled(): Promise<SkillManifest[]>
    executeSkill(name: string, input: string, context: ExecutionContext): Promise<string>
}
```
- 需兼容 OpenClaw 的 SKILL.md 格式，实现自动解析和安装。
- 安装后自动注册为 Agent 可调用工具。

六、外部主机操作 (Agent Daemon)
位置： lib/extra/agent/daemon/

结构体定义
text
DaemonConfig {
    agentId: string
    host: string                // 远程主机 URL
    authType: "jwt" | "password"  // WebUI 用户名密码 + 远程系统密码双重认证
    credentials: {
        webuiUsername: string
        webuiPassword: string
        systemUsername: string
        systemPassword: string
    }
}

DaemonTask {
    id: string
    command: string
    sandboxConfig: SandboxConfig
    timeout: number
}
接口定义
text
interface IAgentDaemonClient {
    connect(config: DaemonConfig): Promise<boolean>
    submitTask(task: DaemonTask): Promise<string>    // 返回 taskId
    getTaskResult(taskId: string): Promise<{ status: string; output: string }>
    cancelTask(taskId: string): Promise<boolean>
    healthCheck(): Promise<boolean>
    disconnect(): void
}
远程 agent daemon 需暴露 HTTP API，通过 WebUI 的用户名密码和远程系统用户名密码双重保护。

通信使用 JWT token (登录后获取)。

七、多 IM 通知与操作
位置： lib/extra/channels/

结构体定义
text
ChannelType = "feishu" | "telegram" | "discord" | "slack"

IncomingMessage {
    channelType: ChannelType
    chatId: string
    userId: string
    text: string
    raw: any
}

OutgoingMessage {
    text: string
    attachments?: ...
    replyToMessageId?: string
}
接口定义
text
interface IChannelAdapter {
    readonly type: ChannelType
    init(config: Record<string, any>): Promise<void>
    sendMessage(chatId: string, msg: OutgoingMessage): Promise<void>
    onMessage(handler: (msg: IncomingMessage) => Promise<void>): void
    getChannelInfo(): { name: string; connected: boolean }
}
每个平台单独实现适配器，统一消息接口。

注意参考 Asika 的多渠道 Bot 抽象层设计。

八、多用户认证
位置： lib/extra/auth/

结构体定义
text
User {
    id: string
    username: string
    passwordHash?: string
    roles: string[]
    apiKeys: ApiKey[]
    createdAt: number
}

ApiKey {
    key: string
    name: string
    scopes: string[]
    expiresAt?: number
}

TokenPayload {
    sub: string                 // user id
    username: string
    iat: number
    exp: number
}
接口定义
text
interface IAuthProvider {
    // 用户名密码
    register(username: string, password: string): Promise<User>
    login(username: string, password: string): Promise<{ user: User; jwt: string }>
    // API Token
    createApiKey(userId: string, name: string, scopes: string[]): Promise<ApiKey>
    validateApiKey(key: string): Promise<User | null>
    // JWT
    generateJWT(user: User): string
    validateJWT(token: string): Promise<TokenPayload | null>
    // 管理
    changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void>
}
参考 Asika 的认证方式 (JWT + API Token + 密码)。

九、LLM 计划任务
位置： lib/extra/cron/scheduler.ts

结构体定义
text
ScheduledTask {
    id: string
    cronExpression: string
    action: {
        type: "agent_command" | "notification"
        command: string
        agentId?: string
    }
    enabled: boolean
    lastRun?: number
    nextRun: number
}
接口定义
text
interface ITaskScheduler {
    schedule(task: ScheduledTask): Promise<void>
    cancel(taskId: string): Promise<void>
    listTasks(userId?: string): Promise<ScheduledTask[]>
    update(taskId: string, updates: Partial<ScheduledTask>): Promise<void>
}
使用 cron 库解析 cron 表达式。

任务触发后可通过 Agent Daemon 执行或发送 IM 通知。

十、定时轮询与动态 Worker (参考 Asika)
位置： lib/extra/cron/poller.ts

结构体定义
text
PollerConfig {
    interval: number            // 轮询间隔（秒）
    taskType: string
    handler: string             // 处理函数标识
    enabled: boolean
}

WorkerStatus {
    workerId: string
    status: "idle" | "busy"
    currentTask?: string
    lastHeartbeat: number
}
接口定义
text
interface IDynamicPoller {
    startPoller(config: PollerConfig): void
    stopPoller(taskType: string): void
    getWorkerPoolStatus(): Promise<WorkerStatus[]>
    scaleWorkers(count: number): void
}
动态 Worker Pool 参考 Asika 的 Worker Pool dynamic 设计，具备 goroutine pool 的动态扩缩容思想。

使用 TypeScript 实现 Worker Pool（如 workerpool 模式）。

十一、数据库支持
位置： lib/extra/db/

结构体定义
text
DBProviderType = "vercel-postgres" | "mongodb"

DBConfig {
    type: DBProviderType
    connectionString: string
    ssl?: boolean
}
接口定义
text
interface IDatabaseProvider {
    connect(config: DBConfig): Promise<void>
    query(sql: string, params?: any[]): Promise<any>
    insert(collection: string, data: Record<string, any>): Promise<string>
    find(collection: string, filter: Record<string, any>): Promise<any[]>
    update(collection: string, id: string, data: Record<string, any>): Promise<void>
    delete(collection: string, id: string): Promise<void>
    close(): void
}
Vercel Postgres 使用 @vercel/postgres。

MongoDB 使用 mongodb 驱动。

十二、持久化记忆 (参考 asikaclaw)
位置： lib/extra/memory/

结构体定义
text
MemoryItem {
    id: string
    agentId: string
    userId: string
    type: "fact" | "preference" | "context"
    key: string                 // 精确查询关键词
    value: string
    tags: string[]
    createdAt: number
    updatedAt: number
    accessCount: number
}

MemoryQuery {
    agentId?: string
    userId?: string
    keyword?: string
    limit?: number
}
接口定义
text
interface IMemoryProvider {
    store(item: Omit<MemoryItem, "id" | "accessCount">): Promise<MemoryItem>
    retrieve(query: MemoryQuery): Promise<MemoryItem[]>
    update(id: string, updates: Partial<MemoryItem>): Promise<void>
    delete(id: string): Promise<void>
    // 会话摘要
    createSessionSummary(agentId: string, sessionId: string, summary: string): Promise<void>
    getSessionSummaries(agentId: string, limit?: number): Promise<string[]>
}
实现时使用数据库层的 IDatabaseProvider，不强制向量检索，使用关键词索引。

参考 asikaclaw 的结构化记忆设计：精确 key 查找、按时间/访问频率排序。

十三、初始提示词 (System Prompt)
位置： lib/extra/prompts/system.ts

结构要求
必须包含以下模块的 Prompt 片段，且通过组合生成最终系统提示词。

基础人格与安全边界：参考 Manboster 的系统提示词。

工具调用规范：参考 Manboster 的 Hachimi 评分标准。

并行 Agent 管理：说明何时创建子 Agent，如何分配任务，如何汇总结果。

沙箱自动选择：列出 tmpfs/docker/lxc/chroot 的选择策略。

权限分级说明：L0/L1/L2 的含义及操作流程。

记忆使用规则：何时从记忆检索，何时存储新记忆。

OpenClaw Skill 调用：加载的技能作为工具列表的一部分。

提示词编写指引：
请阅读 Manboster 的 system_chat.md、system_subagent.md 等提示词文件，以及 OpenCode 关于安全执行和子进程创建的提示词设计，将其中相关部分改写并融入本系统提示词。需强调异步任务模式、沙箱隔离策略、安全审查流程。

十四、配置文件结构定义
text
AgentClawConfig {
    server: {
        host: string
        port: number
    }
    security: {
        l0RulesPath: string
        l1Scorer: LocalScorerConfig | RemoteScorerConfig
        l2Auth: {
            enabled: boolean
            defaultWindow: L2AuthorizationWindow
        }
    }
    sandbox: {
        defaultType: SandboxType
        docker: { socketPath: string }
        lxc: { template: string }
        chroot: { basePath: string }
        tmpfs: { maxSize: string }
    }
    agents: {
        maxParallel: number
        defaultTimeout: number
    }
    channels: {
        feishu: { ... }
        telegram: { ... }
        discord: { ... }
        slack: { ... }
    }
    auth: {
        jwtSecret: string
        tokenExpiration: number
    }
    db: DBConfig
    memory: {
        provider: "vercel-kv" | "mongodb"
        connectionString?: string
    }
    cron: {
        pollers: PollerConfig[]
    }
    daemon: {
        enabled: boolean
        endpoints: DaemonConfig[]
    }
}
附加说明
所有模块均需导出对应的工厂函数或初始化方法，通过配置注入。

TypeScript 实现，严格遵循 ClawLess 的 Next.js 项目结构。

代码中不允许包含具体平台 API 的实现逻辑，仅定义结构体和接口。

具体业务逻辑由后续开发人员根据接口补充，本文件仅提供架构契约。

致 LLM： 请按照上述结构体和接口定义生成框架代码，并在标注了“参考XXX”的模块中，仔细阅读对应的开源项目部分，以正确实现逻辑细节。