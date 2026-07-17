# CLI/Desktop 远程遥控模式 — 代码审查报告

审查分支:`feat/cli-server`(对比 `main`)
审查日期:2026-07-17
对照文档:`plan.md`

---

## 1. plan.md 完成度:约 50%,关键路径未打通

### 已完成

| 模块 | 状态 | 位置 |
|---|---|---|
| **模块 1** computer-use MCP core + server | 9 个文件、1473 行,`cargo check` 通过 | `subpackage/computer-use-mcp/` |
| **模块 1.6** lock.rs(机器锁 + 交叉互斥) | 完整 | `core/src/lock.rs`(135 行) |
| **模块 1.10** capability.rs(能力检测) | 完整 | `core/src/capability.rs`(112 行) |
| **模块 3.2** `lib/cli/remote-control.ts` | KV 状态 / listener / pushToCliSession / im 绑定 / session switch | 296 行 |
| **模块 3.3-3.5** session-events 三个 API 端点 | 全部存在 | `app/api/cli/session-events/[sessionId]/{,register,release}/route.ts` |
| **模块 3.6** writers 双路推送 | 已实现 pushToCliSession 调用 | `lib/workflow/agent/tools/local/index.ts:127-148` |
| **模块 3.7** local/index.ts 条件注册 | `isCliOnlineForSession` fallback | `lib/workflow/agent/tools/local/index.ts:199-213` |
| **模块 4.2** `/attach` `/detach` `/remote` 命令 | 命令解析 + DB 写入 | `lib/chat/commands/remote.ts`(270 行) |
| **模块 5** L2 安全审查 | 风险评估 + 审批流程 | `lib/workflow/agent/tools/local/{index.ts:96-125,security.ts}` |

### 未完成(关键缺口)

| 模块 | 缺口 | 影响 |
|---|---|---|
| **模块 4.3-4.4** chatMain 的 IM → CLI 路由 | **完全缺失**。`routeToCliSession()` 不存在,`chatMain()` 收到 IM 消息时**不读取** `remoteControlNodeId` 来重定向 | **致命:`/attach` 只是空操作,IM 消息永远路由到原 IM session,远程遥控根本不可用** |
| **模块 1.7** safety.rs | 只有 2 行注释占位符,无终端窗口排除、无 Escape 钩子 | prompt-injection 防护缺失 |
| **模块 1.2** screenshot.rs 终端排除 | `exclude_terminals` 参数已被删除,screenshot 不再做遮罩 | 终端内容会泄露给 LLM |
| **模块 1.8** server/main.rs 的 EscapeHook + Lock acquire | main.rs:33-39 启动时**不获取锁**,也**不注册 Escape 钩子** | 锁逻辑写了但没用,机器锁互斥形同虚设 |
| **模块 2.3** CLI 端 computer-use-mcp.ts(MCP 进程管理) | 不存在。CLI 端没有任何 spawn MCP binary / JSON-RPC 通信的代码 | CLI 无法驱动 MCP server |
| **模块 2.1** remote-control-lock.ts | 不存在,TUI 只读模式未实现 | 远程接管时本地用户可继续操作,无互斥 |
| **CLI tool-executor 只支持 local_*** | `tool-executor.ts:57` `default: throw Unknown tool` | computer-use 工具(screenshot 等)被 capability 列出,但收到调用直接抛错 |
| **模块 W3b** `lib/workflow/agent/tools/execute/computer-use.ts` | 不存在 | workflow 侧没有把 computer-use 工具注册给 LLM |
| **W1** source 类型扩展(`remoteIm`) | `types/workflow.ts` 的 ChatSource 没有 remoteIm/remoteAdapter 字段 | 无法在 workflow 内区分"IM 触发但跑在 CLI session" |
| **W2** system prompt 注入远程控制段 | build-prompt 无相关逻辑 | LLM 不知道自己在远程操控,不知道有 computer-use 工具 |
| **模块 1.11** Desktop 改为 core 薄壳 | Desktop 完全删除了 computer use,没有薄壳(详见第 2 节) | Desktop 失去 computer use 能力 |
| **打包脚本** package.mjs / prepare-resources.sh | `subpackage/cli/scripts/package.mjs` 不处理 MCP binary,`subpackage/cli/packages/desktop/scripts/` 不存在 | MCP binary 不会进入 CLI tarball / Desktop 安装包 |

### 实现与 plan 不一致

- **plan 明确写"无数据库 schema 变更,全部用 KV + 进程内 Map"**(plan.md:2204),但实现新增了 `sessions.remoteControlNodeId` 列(`lib/core/db/schema/chat.ts:29`)。这违反了 plan 的设计约定,而且这个列目前**没有任何读取方**——只写不读,是死代码。

---

## 2. 当前分支 computer-use-mcp 是否覆盖 main `computer_use.rs` 的全部功能?

**功能覆盖:基本对等并略有增强,但 plan 中的安全特性缺失。**

### main `computer_use.rs`(656 行,8 个 Tauri 命令)功能清单

| 功能 | main 实现 | MCP core 实现 | 对比 |
|---|---|---|---|
| screenshot | xcap 原始 PNG | xcap + Lanczos3 缩放 + base64 + 多显示器 | MCP **增强**(自动缩放、monitor_index) |
| mouse_move | enigo 绝对坐标 | enigo + CoordMapper 缩放 | 等价(增强:透明坐标转换) |
| mouse_click | button(left/right/middle/back/forward) | button + click_type(single/double) | MCP **增强**(双击) |
| mouse_drag | 从**当前光标**位置拖到 (to_x, to_y) | 必须指定 from_x, from_y | **行为差异**:MCP 不能用当前光标位置 |
| key_event | 单键 + direction(press/release/click) | key + modifiers 组合键 | MCP **增强**(组合键),但**丢失了 press/release 区分**——MCP 的 key_event 在无 modifiers 时硬编码 `click`(main.rs:321) |
| type_text | enigo.text | enigo.text | 等价 |
| get_ax_at_point | Windows/macOS 完整,Linux **stub 返回错误** | Windows/macOS/**Linux 全实现** | MCP **增强**(Linux AT-SPI 真实落地) |
| get_focused_ax | 同上 | 同上 | 同上 |

### main 有但 MCP 完全缺失的功能

1. **`safety.rs` 终端窗口排除** — plan 要求 screenshot 合成时遮罩终端窗口,MCP `screenshot.rs` 的 `capture_and_scale` 签名已经把 `exclude_terminals` 参数去掉,无任何遮罩代码。
2. **Escape 全局钩子** — `safety.rs` 只有 2 行注释,无 CGEvent tap / XGrabKey / SetWindowsHookEx 实现。
3. **Tauri spawn_blocking 包装** — main 在 macOS 上对 enigo 调用走 `spawn_blocking`(因为 enigo `!Send`);MCP 是单线程 stdio 服务,这点不适用,**不是缺陷**。

### 结论

**功能覆盖度:核心 8 个工具都在,且 Linux AX / 组合键 / 双击 / 缩放是增强。缺失项是 plan 1.7 的安全机制(终端排除、Escape 钩子)——这两项 plan 标记为"4 天"工作量,目前是 0 行实现。**

---

## 3. 当前分支 `lib.rs` 是否还有 main 分支的残余逻辑?

**答:无残余。`lib.rs` 已完全剥离了 computer use 逻辑,但 main 分支的 computer use 逻辑也没有"迁移"到 MCP——MCP 是从零新写的。**

### 证据

- 当前 `lib.rs`(1529 行)grep `computer_use|screenshot|mouse_|key_event|type_text|get_ax|AxNode|enigo|xcap|accessibility|uiautomation` → **0 命中**
- `mod computer_use;` 声明已删除(main 在 `:17`,当前没有)
- `invoke_handler!` 注册的 8 个 `computer_use::*` 命令已删除(当前 `:1511-1526` 的 handler 列表无任何 computer_use 项)
- Desktop 前端 grep `invoke('screenshot'|'mouse_move'|...)` → **0 命中**,前端也不再调用

### main 的 computer use 逻辑是否"全部迁移"到了 MCP?

**不是迁移,是平行重写。** main 的 `computer_use.rs` 是 Tauri command(async + spawn_blocking + enigo 直接调用);MCP core 是独立 Rust lib(同步函数 + CoordMapper 抽象)。两者无共享代码路径,且:

- **Desktop 当前没有任何 computer use 入口**:既无 Tauri command,也没按 plan 1.11 / 2.9 的设计改为"通过 RPC 调用 CLI 的 MCP binary"。Desktop 的 Cargo.toml 不依赖 `computer-use-core`,前端 `computerUse` bridge 也已删除。
- **`subpackage/cli/packages/coding-agent/src/core/tools/computer-use.ts` 是孤儿**:它仍通过 `ctx.ui.computerUse` 调用 Tauri IPC(`computer-use.ts:11` 注释还指向 `src-tauri/src/computer_use.rs`),但该 bridge 在 desktop 端已不存在 → 这个文件在当前分支**完全失效**,既不被 CLI TUI 模式用,也不被 remote-control 模式用(remote-control 用 tool-executor.ts)。

---

## 4. 综合判断

当前分支处于 **"模块 1 已落地但未接入,模块 3+5 部分落地,模块 2 和模块 4 的核心路由完全缺失"** 的中间状态:

1. **computer-use-mcp crate 本身基本可用**(编译通过,功能覆盖 main + 安全增强);
2. **但 MCP server 不获取锁、不挂 Escape 钩子**(plan 1.7 / 1.8 落空);
3. **CLI 不 spawn MCP binary**,tool-executor 只认 `local_*` 工具;
4. **`/attach` 写 DB 列但没人读**,IM 消息路由层完全缺失——这是整个 plan 的**心脏**(`routeToCliSession`),目前为 0 行;
5. **Desktop 完全失去了 computer use 能力**,且 `coding-agent/src/core/tools/computer-use.ts` 是指向已删除 Tauri 命令的死代码。

### MVP 阻塞项(必须修复才能"跑通远程遥控")

| # | 任务 | 模块 | 工作量 | 依赖 |
|---|---|---|---|---|
| (a) | chatMain 读取 `remoteControlNodeId`,把 IM 消息 dispatch 到目标 CLI session(`routeToCliSession`) | 4.3-4.4 | 2 天 | — |
| (b) | CLI remote-control-mode spawn MCP binary + JSON-RPC 通信;tool-executor 转发非 `local_*` 工具到 MCP | 2.3 | 2 天 | (c) |
| (c) | MCP server 启动时 acquire `ComputerUseLock`(锁生命周期 = 进程生命周期) | 1.8 | 0.5 天 | — |

MVP 小计:**~4.5 天**(可并行:(a) ∥ (c);(b) 依赖 (c))

### 完整性补强项(必要,排入后续迭代)

| # | 任务 | 模块 | 工作量 | 依赖 | 说明 |
|---|---|---|---|---|---|
| (d) | safety.rs 实现:终端窗口排除(macOS/Windows/Linux 窗口 class 匹配)+ Escape 全局钩子(CGEvent tap / XGrabKey / SetWindowsHookEx) | 1.7 | 3 天 | — | plan 原标 4 天,这里是剩余工作量;screenshot 需重新接入 `exclude_terminals` 参数 |
| (e) | workflow 侧 computer-use 工具注册(`lib/workflow/agent/tools/execute/computer-use.ts`),通过 `writeLocalToolRequest` 走和 `local_*` 相同的分发路径 | W3b | 1 天 | (a)(b) | 否则 LLM 永远拿不到 screenshot/mouse 工具 |
| (f) | system prompt 注入远程控制段(build-prompt.ts 新增 `buildRemoteControlSection`):告知 LLM 处于远程操控模式、可用工具清单、用户不在场提示、L2 审批约定 | W2 | 0.5 天 | (e) | 不注入会导致 LLM 误以为本地有交互能力,行为偏差 |
| (g) | W1 source 类型扩展:`ChatSource` 加 `remoteIm` / `remoteAdapter` / `remoteThreadId` 字段,L2 审批路径根据此走 IM 而非 TUI | W1 | 0.5 天 | (a) | 当前 L2 流程在远程模式下无法正确路由审批 |
| (h) | Desktop 薄壳化:Cargo.toml 加 `computer-use-core` 依赖,Tauri command 改为薄包装(~100 行胶水) | 1.11 | 1 天 | — | 恢复 Desktop 的 computer use 能力,与 CLI 共享同一份 core |
| (i) | 打包脚本:CLI `package.mjs` 嵌入 MCP binary 到 `bin/`;Desktop `prepare-resources.sh` + `tauri.conf.json` 的 `resources` 声明 | 补充 | 1.5 天 | (h) | 否则产物里根本没有 MCP binary,运行时找不到同级文件 |
| (j) | 死代码清理:`coding-agent/src/core/tools/computer-use.ts`(孤儿,指向已删除 Tauri command)删除或重写为 MCP 转发壳;`sessions.remoteControlNodeId` 与 plan 的 KV 路线(`im-attach:` / `cli-im-binding:`)二选一,统一约定 | — | 0.5 天 | (a) | 避免两条 attach 路径并存造成混乱 |

补强小计:**~8 天**((d)(h) 可并行;(e)(f)(g) 串行依赖 (a)(b);(i) 依赖 (h);(j) 依赖 (a))

### 排期总览

```
Week 1 (MVP, ~4.5 天)
  ├─ (a) routeToCliSession + chatMain 路由        [2d]
  ├─ (c) MCP server acquire lock                  [0.5d] ─┐
  └─ (b) CLI spawn MCP + tool-executor 转发       [2d]   ← (c)

Week 2 (补强 P1, ~3 天)
  ├─ (e) workflow computer-use 工具注册           [1d]   ← (a)(b)
  ├─ (f) system prompt 远程控制段                 [0.5d] ← (e)
  ├─ (g) ChatSource 类型扩展 + L2 路由            [0.5d] ← (a)
  └─ (j) 死代码清理 + KV/DB 路线统一              [0.5d] ← (a)

Week 2-3 (补强 P2, ~5 天,可与 P1 并行)
  ├─ (d) safety.rs 终端排除 + Escape 钩子         [3d]
  ├─ (h) Desktop 薄壳化                           [1d]
  └─ (i) 打包脚本                                 [1.5d] ← (h)
```

**总计:~12.5 天**(MVP 4.5d + 补强 8d;并行后实际日历约 8-9 个工作日)

### 风险与注意事项

- **(d) safety.rs 是最大的不确定性**:CGEvent tap / XGrabKey / Wayland libinput 三平台的输入拦截 API 各有陷阱,Wayland 下甚至可能需要 root + input group 权限。plan 标 4 天偏乐观,实际可能溢出到 5-6 天。
- **(j) KV vs DB 路线选择**:plan 设计是纯 KV(无 schema 变更),实现已经走了 DB 列路线。两者各有取舍——KV 跨 Vercel serverless 实例可用但需要 polling;DB 列简单但违反 plan 约定。建议**统一回 KV 路线**(对齐 plan),因为 session-events 端点本身已经依赖 KV polling 做跨实例 push。
- **(i) 打包脚本的 CI 链路**:plan 的 CI 工作流(computer-use-mcp matrix build + CLI tarball + Desktop Tauri)是三段串联,任何一段的平台 matrix 缺失都会导致某平台产物缺失 MCP binary。需要在 CI 上验证 `cargo build --target` 的交叉编译矩阵完整。
- **(b) 与 (e) 的协议一致性**:CLI tool-executor 转发到 MCP 的工具名/参数,必须和 workflow 侧 W3b 注册给 LLM 的工具名/参数 schema **严格一致**(目前 MCP 用 `get_accessibility_tree`/`get_focused_element`,workflow plan 里也是这两个名字,但 main 的 Tauri 命令用的是 `get_ax_at_point`/`get_focused_ax`——需要确认 tool-executor 的 switch case 覆盖 MCP 的命名)。
