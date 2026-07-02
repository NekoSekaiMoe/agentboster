# 编辑 AI 回答功能评估

> 评估日期：2026-06-30
> 基于 pi-coding-agent v0.80.2 / pi-desktop v0.6.3

---

## 1. 需求描述

用户可以对 AI 的回答（assistant 消息）进行编辑并保存，编辑后的文本替换原回答，并在后续对话/导出中使用编辑后的版本。

## 2. 当前架构约束

### 2.1 会话持久化

- pi 将所有会话消息存储在 `.jsonl` 文件中，每行一个 JSON 对象
- 消息行结构：`{ type: "message", message: { role, text, id, timestamp, thinking?, ... } }`
- 文件头行（session header）记录会话元数据：`{ type: "session", id, version, cwd, ... }`

### 2.2 pi RPC 指令集

当前 RPC 协议（`rpc-types.d.ts`）**没有** `edit_message` 指令。可用指令：

| 指令 | 用途 |
|------|------|
| `prompt` | 发送用户消息 |
| `fork` | 从某条用户消息 fork 出新会话文件 |
| `clone` | fork 的别名（`fork(leafId, {position:"at"})`） |
| `get_messages` | 获取当前会话所有消息 |
| `switch_session` | 切换到另一个会话文件 |
| `abort` | 中止当前响应 |

### 2.3 前端消息流

```
pi 子进程事件
  → AgentManager.handlePiEvent()
    → upsertToolMessage() / addMessage() 写入 agents.messages[]
      → scheduleMessageEmit() → IPC → renderer
        → setMessagesByAgent() → buildTimeline() → TurnRow / ToolCard
```

### 2.4 消息分组渲染

`buildTimeline()` 将消息分组为：

- `{kind:"message", message: ChatMessage}` — 用户/助手/错误消息
- `{kind:"tool-group", messages: ChatMessage[]}` — 工具调用组
- `{kind:"thinking-group", ...}` — 独立思考块
- `{kind:"run", items: [...], startedAt, endedAt}` — 一轮完整 AI 回答

助手消息最终通过 `TurnRow` → `AssistantText`（ReactMarkdown）渲染。

## 3. 方案对比

### 方案 A：fork 新会话（不推荐）

**流程：**

```
用户点击编辑 → 修改内容 → 保存
  → 后台调 pi RPC fork(entryId)
    → pi 创建新 .jsonl 文件，复制所有消息，header.parentSession 指向源文件
    → agent 切换到新会话
  → 找到对应消息，修改 text
  → 写回新文件
  → 前端刷新
```

**代价：**

| 方面 | 表现 |
|------|------|
| 磁盘 | **每次编辑产生一个新 `.jsonl` 文件** |
| 历史列表 | 多出一条会话记录，用户需要手动清理旧文件 |
| 导出 | 新旧文件各自独立导出 HTML，互不关联 |
| parentSession | 仅元数据标记，导出/预览不会显示"来自 fork" |
| 后续聊天 | 在新文件里继续，上下文一致 |
| 心智模型 | 编辑 = 创建分支，太重 |

**结论：不适合“轻量编辑”场景，适合“从此处分叉继续”的场景（已有）。**

### 方案 B：直接修改 JSONL（推荐）

**流程：**

```
用户点击编辑 → 修改内容 → 保存
  → 前端调用 IPC agentsEditMessage(agentId, messageId, newText)
  → 主进程 AgentManager.editMessage():
    1. 从 runtime.tab.sessionPath 拿到 JSONL 文件路径
    2. 读 JSONL，根据 message.id 找到对应行
    3. 替换 text 字段
    4. 写回 JSONL
    5. 更新 agents.get(agentId).messages[] 里对应消息的 text
    6. emit 更新后的 messages 到前端
  → 前端重新渲染编辑后的消息
```

**优势：**

| 方面 | 表现 |
|------|------|
| 磁盘 | **原地修改，不产生新文件** |
| 历史列表 | 无变化 |
| 导出 | 导出即为编辑后内容 |
| 后续聊天 | agent 内存中消息已更新，发送下一条时上下文为编辑后版本 |
| 复杂度 | 仅需 JSONL 读写 + 内存更新，不涉及 pi RPC 变更 |

**边界与风险：**

| 情况 | 处理 |
|------|------|
| 编辑流式中的回答 | 禁止：需判断 `status !== "running"` |
| 编辑旧会话（agent 已关闭） | 直接改 JSONL 即可，无需 agent 进程 |
| 编辑后 agent 重启 | JSONL 已更新，重启后重载显示正确文本 |
| 正在 compress 时编辑 | 禁止或排队 |
| 编辑工具调用结果 | 不支持，仅 assistant 角色 |
| 编辑 thinking 内容 | 不支持，仅 text |

## 4. 实现路径

### 4.1 后端（主进程）

**新增文件：** 无，修改 `AgentManager.ts`

```typescript
// AgentManager.ts
async editMessage(agentId: string, messageId: string, newText: string): Promise<void> {
  const runtime = this.requireRuntime(agentId);

  // 1. 更新 JSONL 文件
  const sessionPath = runtime.tab.sessionPath;
  if (sessionPath) {
    const raw = await readFile(sessionPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.message?.id === messageId && entry.message.role === 'assistant') {
          entry.message.text = newText;
          lines[i] = JSON.stringify(entry);
          changed = true;
          break;
        }
      } catch { /* skip malformed lines */ }
    }
    if (changed) await writeFile(sessionPath, lines.join('\n'), 'utf8');
  }

  // 2. 更新内存消息
  const list = this.messages.get(agentId) ?? [];
  const updated = list.map((m) =>
    m.id === messageId ? { ...m, text: newText, timestamp: Date.now() } : m,
  );
  this.messages.set(agentId, updated);
  this.scheduleMessageEmit(agentId, true);
}
```

**新增 IPC 通道：** `src/shared/ipc.ts` + `src/main/index.ts`

```
agentsEditMessage: "agents:edit-message"  // (agentId, messageId, newText) → void
```

### 4.2 前端（渲染进程）

**涉及文件：**

| 文件 | 改动 |
|------|------|
| `AppParts.tsx` | `TurnRow` 添加 hover"编辑"按钮 + 编辑态 textarea + 保存/取消 |
| `App.tsx` | 新增 `editingMessageId` 状态 + IPC 调用 + 回调传递 |
| `browserApi.ts` | 新增 `api.agents.editMessage()` |
| `i18n.ts` | 中英文文案 |

**交互设计（参考 UserBubble 模式）：**

```
渲染态：
  [工具名] [状态] [耗时] [摘要]       [chevron]
  [正文 Markdown]

hover 时：
  [工具名] [状态] [耗时] [摘要]  [编辑] [chevron]

点击编辑后：
  [工具名] [状态] [耗时] [摘要]  [取消] [保存]
  [textarea / Monaco 输入框，预填当前文本]
```

**状态管理：**

```typescript
const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

// 保存回调
const handleSaveEdit = async (messageId: string, newText: string) => {
  if (!activeAgentId) return;
  setEditingMessageId(null);
  await api.agents.editMessage(activeAgentId, messageId, newText);
};
```

### 4.3 方案 C（推荐）：写入 JSONL + 重启 agent 进程

利用刚修复的「重启不切换不抢回」能力，编辑后重启 pi 子进程使其重新加载 JSONL：

```
用户编辑 → 保存
  → IPC → AgentManager.editMessage()
    1. 写 JSONL 文件（原地更新 text 字段）
    2. 更新桌面端内存 messages[]
    3. 调用 restart(agentId)
       → pi 子进程退出（桌面端保留 starting 占位，位置不跳）
       → 新 pi 子进程启动，从 JSONL 重新加载
       → 子进程内部 agent.state.messages 已包含编辑后的内容
  → agent 状态变为 idle，就绪
```

**优点：**

| 维度 | 表现 |
|------|------|
| 改 pi SDK | ❌ 不需要 |
| 写扩展 | ❌ 不需要 |
| 产生新文件 | ❌ 不产生 |
| 上下文一致 | ✅ 重启后 JSONL→内存，完全一致 |
| 导出 | ✅ 修改后的内容 |
| 重启体验 | ✅ 同一位置 loading→就绪，不切换不抢回 |
| 实现量 | 最小 |

**代价：** 重启需要几秒（pi 子进程启动 + get_state + loadMessages 的时间）。

### 4.4 扩展（Extension）路径评估

已有一个内置扩展 `pi-deck-file-capture.ts`（`resources/extensions/pi-deck-file-capture.ts`），部署在 `~/.pi/agent/extensions/`，pi 自动发现。同样的机制可以部署第二个内置扩展。

**扩展的能力：**

扩展运行在 pi 子进程内，能访问：
- `pi.on("context", ...)` — 在每次 LLM 调用前修改消息上下文
- `pi.on("input", ...)` — 拦截用户输入
- `pi.registerCommand()` — 注册斜线命令
- `fs.readFile / writeFile` — 直接读写磁盘

**关键约束：**

扩展和桌面端之间**没有直接通讯通道**。桌面端（AgentManager）在 Electron 主进程，扩展在 pi 子进程中，它们通过 RPC JSON 协议交互。扩展不能监听桌面 IPC，桌面也不能直接调用扩展 API。

**可能的通讯方式：**

| 方式 | 问题 |
|------|------|
| 桌面端发特殊格式 `prompt`，扩展在 `input` 事件拦截 | 需要一次额外 RPC 调用，扩展解析协议文本，脆 |
| 扩展通过 File Watcher 监听 JSONL 变化 | 竞态、延迟、文件系统监听跨平台不一致 |
| 扩展读共享文件（desktop 写 edit-meta.json） | IO 轮询 + 时序问题 |

**结论：** 能用扩展实现，但通讯通道绕，不如方案 C 直接可靠。

### 4.5 方案总结

| 方案 | 上下文同步 | 新文件 | 改 pi SDK | 写扩展 | 实现成本 |
|------|-----------|-------|----------|-------|---------|
| **A：fork 新会话** | ✅ | ✅ 每次编辑一个新文件 | ❌ | ❌ | 低 |
| **B：直接改 JSONL** | ❌ 需要额外 RPC 或重启 | ❌ | ❌（或加 RPC） | ❌ | 低~中 |
| **C：改 JSONL + 重启** | ✅ 重启后完全一致 | ❌ | ❌ | ❌ | **最低** |
| **Extension + context 修补** | ✅ 每轮自动修补 | ❌ | ❌ | ✅ 写扩展 | 中 |
| **Extension + 新 RPC 指令** | ✅ 即时同步 | ❌ | ✅ 加 edit_message | ✅ 可选 | 高 |

**推荐方案 C**：写入 JSONL + 重启 agent 进程。利用刚修复的重启占位机制，用户无感知切换。

## 5. 推荐方案（C）工作量估算

| 模块 | 预估人天 | 关键文件 |
|------|---------|---------|
| 后端 IPC + JSONL 读写 | 0.5 天 | `AgentManager.ts`, `index.ts`, `ipc.ts` |
| 前端编辑 UI（TurnRow） | 0.5 天 | `AppParts.tsx`, `App.tsx` |
| 前端 IPC 桥接 | 0.25 天 | `browserApi.ts`, `App.tsx` |
| 边界处理 + 测试 | 0.25 天 | — |
| **合计** | **~1.5 天** | |

如果后续不接受重启延迟，可增量改为方案 B + 向 pi SDK 提交 `edit_message` RPC PR（增加约 0.5 天）。

## 6. 不做的方案

| 方案 | 问题 |
|------|------|
| 只改前端显示不改 JSONL | 重启/切换 agent 后恢复原内容，用户困惑 |
| 用 fork 替代编辑 | 每次编辑产生新文件，会话列表膨胀 |
| 用 monarch editor 替换 textarea | 依赖加载加重大量消息场景，建议初期 textarea |
| 纯 Extension 实现（File Watcher） | 通讯通道绕，时序脆弱，跨平台不一致 |

## 7. 相关源码索引

| 路径 | 说明 |
|------|------|
| `src/shared/types.ts:88` | `ChatMessage` 类型定义 |
| `src/shared/ipc.ts` | IPC 通道枚举 |
| `src/main/pi/AgentManager.ts:1300` | `upsertToolMessage` 消息构建 |
| `src/main/pi/AgentManager.ts:1430` | `addMessage` 消息追加 |
| `src/main/pi/bashResult.ts` | bash 工具消息格式化参考 |
| `src/renderer/src/App.tsx:1057` | `setActiveAgentId` 状态切换逻辑 |
| `src/renderer/src/components/app/AppParts.tsx:1242` | `getToolSubtitle` 工具副标题提取 |
| `src/renderer/src/components/app/AppParts.tsx:1665` | `TurnRow` 组件（助手回答渲染） |
| `src/renderer/src/components/app/AppParts.tsx:1826` | `UserBubble` 组件（已有编辑模式参考） |
| `D:...pi-coding-agent/dist/core/session-manager.js:1126` | `forkFrom` fork 实现 |
| `D:...pi-coding-agent/dist/modes/rpc/rpc-types.d.ts` | RPC 协议全部指令类型 |
| `D:...pi-coding-agent/dist/modes/rpc/rpc-mode.js:458` | RPC fork/clone 指令处理 |
