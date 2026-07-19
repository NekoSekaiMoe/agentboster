# Agentboster 与 Memoh 的 Desktop 形态对比

> 对比基于当前工作区代码，初次分析日期为 2026-07-18，最近一次更新为 2026-07-18（合流 Desktop RPC mode 与 Remote-Control Registration Gate，使远程 LLM 能直接调度 Desktop 启动的 CLI 的物理桌面能力）。本文中的 Memoh 指仓库根目录下的 `memoh/` 参考项目。代码持续演进，本文描述的是当前实现，而不是未来路线图。

## 1. 结论摘要

Agentboster Desktop 和 Memoh Desktop 都提供聊天、文件、终端和远程工作区能力，但两者的产品中心不同：

- **Agentboster Desktop 是本地编码 Agent 工作台。** 它以用户当前电脑上的项目、目录、会话和 CLI Runtime 为中心。桌面壳直接启动本地 `agentboster-cli --mode rpc` 子进程，通过 stdin/stdout RPC 驱动聊天和工具执行，并打包 `computer-use-mcp` 作为物理桌面能力。RPC mode 启动时还会把 Session 注册到 Web backend（带 `hasDisplay`），让远程 LLM 通过 `computer-use-remote` 直接调度用户桌面。
- **Memoh Desktop 是多 Bot 平台的常驻原生客户端。** 它以 Memoh Cloud 或自托管 Memoh Server 为中心，复用 Web UI 的 Bot、聊天、Workspace、记忆、渠道和管理能力。Electron 壳不内置 Memoh Server，但可以把当前电脑作为受约束的 Remote Runtime 反向连接给服务器。

最简化的定位是：

| 产品 | 主要对象 | 最接近的产品形态 |
|---|---|---|
| Agentboster Desktop | 本地项目、本地会话、本机工具 | Agent IDE / 编码工作台 |
| Memoh Desktop | 远端 Bot、长期运行的 Workspace、平台配置 | 多 Agent 控制台 / 常驻客户端 |

两者最容易混淆的是“Desktop”一词实际包含两个概念：

1. **Desktop Client**：安装在用户操作系统上的 Tauri/Electron 客户端。
2. **Agent Desktop**：供 Agent 看见并操作的 GUI 桌面环境。

在第一个概念上，Agentboster 是 Tauri 本地工作台，Memoh 是 Electron 服务端客户端。在第二个概念上，Agentboster 同时支持物理宿主桌面和 agentd 沙箱桌面；Memoh 当前主要操作 Bot Workspace 内的 Xvnc 桌面。

## 2. 总体对比矩阵

| 维度 | Agentboster Desktop | Memoh Desktop |
|---|---|---|
| 产品中心 | 本地项目和编码会话 | Bot 和长期运行的 Workspace |
| 原生壳 | Tauri 2 + Rust | Electron + Node.js |
| Renderer | Lit + TypeScript + Vite | Vue 3 + Vite，复用 `@memohai/web` |
| 默认窗口 | 单个无边框、透明、自绘标题栏窗口 | 单个 BrowserWindow，macOS 隐藏标题栏 |
| 常驻方式 | 系统托盘常驻；关闭主窗口时按 `close_action` 设置隐藏到托盘、退出或每次询问 | 系统托盘常驻；关闭主窗口时隐藏而非退出 |
| Agent Runtime | 每个活动会话对应一个本地 CLI RPC Runtime | Agent Runtime 位于 Memoh Server 进程和 Workspace 中 |
| 本地依赖 | 需要或自动安装 `agentboster-cli`，可携带 `computer-use-mcp` | 不启动本地 Server、不安装 companion CLI；内嵌 Remote Runtime SDK |
| 服务端关系 | Web 是模型、Workflow、会话和持久化的权威端 | Memoh Server 是 Bot、Agent、记忆、渠道和 Workspace 的权威端 |
| 本地文件/命令 | CLI 直接针对当前项目目录执行 `local_*` 能力 | 可选 Remote Runtime，在服务器授权的 Workspace scope 内提供 `fs` 和 `exec` |
| 本机 Computer Use | `computer-use-mcp` 可截图、无障碍检查、鼠标/键盘输入；Desktop RPC mode 启动时自动向 Web 注册 `hasDisplay`，远程 LLM 可经 `computer-use-remote` 调度 | Remote Runtime M1 未声明截图、输入或无障碍能力 |
| 隔离桌面 | agentd LXC 中的 X11 + noVNC，可在 Desktop 中查看 | 每个 Bot Workspace 的 Xvnc 桌面，通过 Web UI/Desktop 查看和接管 |
| 浏览器形态 | 本机/CLI 工具加 agentd 沙箱浏览器 | Workspace 内 Browser Use，和 Workspace Desktop 统一归 Bot 所有 |
| UI 信息架构 | Workspace -> Project -> Session/File Tab | Bot -> Session/Workspace Panel |
| 扩展机制 | CLI packages、extensions、skills、prompts、themes | MCP、plugins、skills、ACP Agent、平台级 provider/channel |
| 多用户重心 | Web/IM 支持平台协作，Desktop 仍偏个人开发者入口 | 从产品模型上就是多用户、多 Bot、多渠道平台 |
| 电脑关机后的连续性 | 本地 CLI 和物理桌面能力离线；Web Workflow/agentd 可继续 | Server Workspace Agent 可继续；绑定到该电脑的 Remote Runtime 离线 |

## 3. Desktop Client：原生客户端形态

### 3.1 Agentboster：Tauri 本地工作台

Agentboster Desktop 位于 `subpackage/cli/packages/desktop/`，是独立于 CLI Yarn workspace 的 Tauri 应用。其前端使用 Lit，Rust 后端负责：

- 发现、安装和启动 `agentboster-cli`；
- 为不同会话管理独立的 RPC 子进程；
- 通过 stdin/stdout 转发逐行 JSON RPC；
- 提供文件系统、Shell 和原生窗口集成；
- 将打包的 `computer-use-mcp` 路径注入 CLI 运行环境；
- 管理系统托盘行为和关闭策略（ask/tray/quit 三种 close_action）。

窗口配置体现了它的工作台定位：

- 默认大小为 `1100 x 750`；
- 最小大小为 `600 x 400`；
- 无系统装饰，自绘标题栏；
- 透明背景和窗口阴影；
- 当前配置中只有一个主窗口。

其内部并非简单聊天页面，而是一个紧凑的 IDE 式布局。当前 `WorkspaceState` 可以进入以下 pane：

- `chat`
- `file`
- `packages`
- `settings`
- `terminal`
- `agentd-vnc`
- `schedule`

同时维护：

- 多 Workspace；
- 每个 Workspace 的项目选择；
- 多会话标签；
- 多文件标签；
- 全屏终端标签页（取代底部 Terminal Dock）；
- 文件/聊天分栏；
- Session Browser 和历史分叉；
- 包、扩展、Skill、Prompt、Theme 管理；
- AgentD VNC 远程桌面标签；
- Schedule 定时任务面板；
- Computer Use 截图格式/质量设置（JPEG/PNG 切换，质量滑块 1-100）。

因此，Agentboster Desktop 的“桌面化”不是把 Web 聊天页放进窗口，而是把 CLI 编码 Agent 的能力重新组织成图形工作台。

### 3.2 Memoh：Electron 常驻客户端

Memoh Desktop 位于 `memoh/apps/desktop/`。它不重新实现整套产品 UI，而是复用 `@memohai/web` 的：

- Vue 页面和布局；
- Pinia Store；
- i18n；
- API Client；
- Bot、聊天、Workspace 和设置页面；
- 设计 Token 和基础样式。

Electron Desktop 自己负责：

- BrowserWindow 生命周期；
- 系统托盘；
- 原生菜单和快捷键；
- preload IPC；
- 外部链接隔离；
- Server URL 保存和探测；
- 跨 Renderer 缓存失效通知；
- Remote Runtime 的连接和凭据保存。

当前窗口模型仍然以一个主聊天窗口为核心。设置页面不是独立的本地管理程序，而是在同一 Renderer 内作为持久 Overlay 呈现。主窗口关闭时，Electron 拦截 `close` 事件并调用 `hide()`；用户从托盘选择 Bot、设置或“显示 Memoh”时再次唤起窗口。

托盘菜单包含：

- 显示 Memoh；
- Bot 快速入口；
- Providers、Memory、Web Search、Voice、Email、Supermarket、Usage、Members 等设置入口；
- 当前 Computer Access / Remote Runtime 状态；
- 显式退出。

这使 Memoh Desktop 更接近一个常驻的 Agent 平台客户端，而不是只在处理某个项目时打开的开发工具。

## 4. Runtime 拓扑

### 4.1 Agentboster 的运行链路

Agentboster Desktop 的主要链路如下：

```text
用户
  -> Agentboster Desktop (Tauri + Lit)
    -> 每会话 agentboster-cli --mode rpc
      -> Agentboster Web API
        -> Workflow DevKit
          -> 模型调用、上下文、会话持久化、工具编排
      -> local_* 工具
        -> 本机项目文件和 Shell
      -> computer-use-mcp
        -> 本机截图、无障碍树和输入注入
```

这里需要注意：虽然 Desktop 启动了本地 CLI Runtime，但当前 Agentboster 架构中，CLI 是瘦客户端。模型调用、Workflow 权威状态和会话持久化仍由 Web 负责。Desktop/CLI 主要负责：

- 本地交互界面；
- 当前项目上下文；
- 本地工具执行；
- 将 Web 下发的工具请求在用户电脑上执行并回传；
- 为物理桌面 Computer Use 提供 MCP 端点。

Rust 后端用 `HashMap<String, RpcProcessHandle>` 保存多个 RPC 实例。一个 Workspace 中的不同 Session Tab 可以绑定不同 `instance_id`，从而避免快速切换时的状态串扰。

CLI 缺失时，Desktop 可以查询 Agentboster GitHub Release、下载最新 `agentboster-cli-*.tar.gz`，并安装到用户配置目录。Desktop 与 CLI 不要求严格锁步发版。

### 4.2 Memoh 的运行链路

Memoh Desktop 的默认链路如下：

```text
用户
  -> Memoh Desktop (Electron + Vue)
    -> Memoh Server REST / Stream API
      -> Go In-process Agent
        -> Bot 配置、记忆、渠道、定时任务
        -> Server/Container Workspace
          -> 文件、终端、浏览器、Xvnc 桌面
```

Desktop 不会在本机启动以下组件：

- Memoh Go Server；
- PostgreSQL；
- Qdrant；
- Container Runtime；
- Provider 模板和媒体 Runtime；
- companion CLI。

用户首次使用时需要连接 Memoh Cloud 或一个可访问的自托管 Server。Server URL 经过探测后保存到 Electron `userData` 目录。Renderer 持有登录态并调用服务端 API，Electron Main 不直接持有用户账号凭据。

### 4.3 Memoh Remote Runtime 是什么

Memoh Desktop 不是纯浏览器套壳，因为 Electron Main 内嵌 `@memohai/runtime`。用户配置 Runtime ID、名称和 Key 后，Desktop 会：

1. 使用 Electron `safeStorage` 加密 Runtime Key；
2. 从本机主动建立到 Memoh Server 的 WebSocket/gRPC 通道；
3. 把当前电脑注册为可供 Bot 选择的 Remote Runtime；
4. 在本机 Home Directory 下建立受保护的 Workspace Base；
5. 根据服务器下发的 Workspace scope 提供文件和命令服务。

当前握手协议声明的能力只有：

```text
fs
exec
workspace_scope
```

对应的 RPC 包括：

- ReadFile / WriteFile；
- ListDir / Stat；
- Mkdir / Rename / DeleteFile；
- Raw Stream Read/Write；
- Exec。

当前 M1 明确拒绝 Tunnel，并且不支持 ReverseHTTP。因此 Memoh Remote Runtime 不应被理解为一台完整的 agentd，也不应被理解为对物理桌面的远程控制客户端。

## 5. Agent Desktop：Agent 实际操作哪一块屏幕

### 5.1 Agentboster 有两类 Desktop

Agentboster 当前存在两条不同的桌面路径。

#### A. 用户物理桌面

Desktop 启动本地 CLI 时，会发现打包的 `computer-use-mcp`，并通过 `COMPUTER_USE_MCP_PATH` 注入 CLI。该 Rust MCP Server 面向用户正在操作的 Windows、macOS 或 Linux 桌面，提供：

- 屏幕截图；
- 鼠标点击和移动；
- 键盘输入；
- 无障碍树查询；
- 基于语义节点的 UI 操作。

这条路径的主要用途是让 Agent 操作真实宿主机应用，例如本地 IDE、浏览器、设计软件或系统设置。它的权限边界也最强：Agent 获得的是用户桌面的真实输入能力，而不是容器中的模拟桌面。

#### B. agentd 沙箱桌面

Agentboster 的 Web Workflow 还可以把 `desktop_*` 工具下发到 agentd。agentd 在持久 LXC 沙箱中准备：

- Xvfb；
- icewm；
- x11vnc；
- noVNC；
- AT-SPI2/dbushelper。

该桌面用于调试 Electron、Tauri、Qt、GTK 等 GUI 应用。Agent 可以截图、点击、输入或使用 AT-SPI2 Ref 操作控件；用户可以通过 Desktop 的 `agentd-vnc` pane 连接活动会话。

物理桌面与沙箱桌面是两条独立的执行边界：

```text
Desktop CLI -> computer-use-mcp -> 用户物理桌面

Web Workflow -> agentd -> LXC X11 桌面 -> noVNC/AT-SPI2
```

不能因为两者都叫 Desktop，就认为它们拥有相同权限或生命周期。

### 5.2 Memoh 的 Desktop 主要属于 Bot Workspace

Memoh 的产品定义是“每个 Agent 一台电脑”。这里的电脑主要是 Bot 的独立 Workspace，其中包含：

- 文件系统；
- 网络；
- Shell；
- 浏览器；
- Xvnc 桌面；
- 长期记忆和 Agent 配置。

当 Workspace Desktop 启用后，服务端会准备桌面、VNC、浏览器和 CJK 字体等组件。桌面画面可以在 Web/Desktop 的 Dockview panel 中打开，用户可以实时观看并接管输入。

Memoh 的 Computer Use 因而天然围绕隔离 Workspace：Agent 操作的是自己的工作环境，不是默认操作用户当前可见的物理桌面。

Memoh Desktop 的 Remote Runtime 当前只提供文件和命令能力；握手元数据中没有 `display`、`screenshot`、`input` 或 `a11y`。所以即使把笔记本连接为 Remote Runtime，也不能据此推断 Bot 可以控制该笔记本桌面。

## 6. 远程 LLM Desktop：模型如何看见并操作远端桌面

“远程 LLM Desktop”不是一个单一协议。一个完整实现至少包含三条彼此独立的链路：

1. **推理与编排链路**：Prompt、模型输出、Tool Call、Tool Result 在哪里生成和持久化。
2. **Agent 观察与控制链路**：LLM 如何获得截图或无障碍树，以及点击、输入最终在哪里执行。
3. **用户实时观看与接管链路**：用户如何看到连续视频、发送鼠标键盘输入，以及是否会和 Agent 抢控。

可以把它抽象成：

```text
                 推理与编排面
用户消息  -------------------------------->  远程 LLM
                                                |
                                                | tool call
                                                v
                 Agent 工具面             Desktop Adapter
                                                |
                               screenshot / a11y / input
                                                |
                                                v
                                           目标桌面
                                                ^
                                                |
                 人工接管面          VNC / WebRTC / 本机显示
                                                |
                                               用户
```

这三条链路可以共用底层桌面，但不能视为同一条数据流。特别是，用户看到的连续视频通常不会逐帧发送给 LLM；LLM 看到的是离散、按需获取的截图或语义快照。

### 6.1 Agentboster：远程 LLM 控制用户物理桌面

Agentboster 的模型和 Workflow 位于 Web 侧，目标桌面位于运行 CLI/Desktop 的用户电脑上。二者之间通过“远程工具回路”连接，而不是通过 VNC 直接连接。

端到端时序如下：

```text
1. CLI 以 Remote-Control Mode 连接一个 Session，用户从已附加的 IM 等入口提交任务
2. Web 创建或恢复 Workflow Run
3. Web 调用远程 LLM
4. LLM 产生 screenshot / mouse_click / type_text 等 Tool Call
5. Workflow 将 tool-request 写入 CLI Session Event
6. 在线 CLI 通过 SSE 收到请求
7. CLI 通过 stdio JSON-RPC 调用本机 computer-use-mcp
8. computer-use-mcp 读取屏幕或注入输入
9. CLI 将 Tool Result POST 回 Web
10. Workflow Hook 被恢复，结果重新进入 LLM Tool Loop
```

实际控制路径是：

```text
Web Workflow
  -> session-events SSE
    -> agentboster-cli remote-control mode
      -> computer-use-mcp stdio
        -> OS Screenshot / Accessibility / Input API
```

这意味着：

- LLM 不需要能访问用户电脑的入站端口；
- CLI 主动建立到 Web 的长连接，更适合位于 NAT 或防火墙后的个人电脑；
- Web 只在 CLI 已注册 `hasDisplay: true` 时向模型暴露截图工具；
- 鼠标、键盘和无障碍工具还要求 CLI 实际报告相应 MCP Tool；
- 普通 Web 会话不会自动获得用户物理桌面能力；该能力只对 CLI Session 或明确附加到 CLI Session 的远程 IM 会话注册。

#### 截图如何进入 LLM

Agentboster 的 `screenshot` Tool Result 会从 MCP 返回的 `content` 中提取图像，并直接作为 AI SDK Image Content Block 恢复给 Workflow。因此，一个典型视觉回路是：

```text
screenshot -> 模型直接看到 PNG -> mouse_click/type_text -> screenshot 验证
```

优点是少一次显式文件读取，模型拿到截图后可以立即推理。代价是：

- 每次截图都会产生视觉模型输入成本；
- 大图会增加上传延迟和上下文负担；
- 截图中所有未遮挡内容都会越过本机边界并发送给远程模型 Provider。

`computer-use-mcp` 为此提供了终端保护：默认遮挡截图中的终端窗口，并在 macOS/Windows 上拒绝对前台终端注入输入。用户显式启用 `allow_terminal_edit` 后才会放开这两项限制。

#### 无障碍观察如何进入 LLM

物理桌面的 Accessibility Tool 返回角色、名称、值和边界框等结构化文本。它比截图更便宜，也更适合精确识别按钮、输入框和当前焦点。但它依赖：

- macOS Accessibility 授权；
- Windows UIAutomation 可访问性；
- Linux AT-SPI2 和桌面总线；
- 应用自身正确暴露无障碍节点。

无法访问语义节点时，模型只能退回截图和坐标操作。此时窗口移动、缩放、DPI 或弹窗出现都会让旧坐标失效，所以每次改变 UI 状态后重新观察很重要。

#### IM 远程控制

Agentboster 还允许把 Telegram 等 IM Thread 附加到一个在线 CLI/Desktop Session。附加后，来自 IM 的 LLM 回合可以获得该 Session 的 `local_*` 和 Computer Use 工具。

这形成一种典型的“人不在电脑前，但 LLM 仍操作这台电脑”的形态：

```text
手机 IM
  -> Agentboster Web
    -> 远程 LLM
      -> SSE Tool Request
        -> 家中/办公室在线的 Desktop CLI
          -> 本机文件、Shell 或物理桌面
```

它不是通用远控软件：用户不会通过 IM 获得连续桌面视频，LLM 只是按需截图并执行离散动作。若需要人类视觉确认，仍需回到物理电脑或使用其他查看通道。

#### 在线状态和可靠性

CLI 会向 Web 注册：

- Session ID；
- 可用工具；
- `hasDisplay`、平台、DPI Scale、管理员状态；
- 当前工作目录；
- 连接时间。

Web 使用带 TTL 的在线状态判断是否注册 Computer Use Tool。工具请求优先经当前进程内 SSE Listener 发送；在 Vercel 多实例或 Serverless 场景下，会降级写入 KV 队列，由 SSE Endpoint 周期轮询取出。

这带来几个可观察的延迟来源：

- LLM 首 Token 和 Tool Call 生成时间；
- Web Workflow Step 调度；
- SSE 直发或 KV 轮询等待；
- 本机截图和 PNG 编码；
- 图像回传上传；
- Tool Result 恢复 Workflow；
- 下一轮视觉模型推理。

CLI 离线、Session 不匹配、MCP 未启动、系统权限未授予或 Tool Result 回调超时时，模型只会得到工具错误，不会自动获得另一台电脑的控制权。

#### Desktop RPC 与 Remote-Control Gate 的合流

Agentboster 历史上存在两种容易被混为一谈的 CLI 通信方式：

1. **Desktop/交互式 CLI Chat**：调用 `/api/cli/chat`，服务端把 `local-tool-request` 写入同一条聊天响应 Stream，前台 CLI 收到后执行本地工具并回传。
2. **Detached Remote-Control Mode**：CLI 长期连接 `/api/cli/session-events/[sessionId]`，注册显示能力并等待来自 IM 或其他入口的远程 Tool Request。

Desktop 的 Tauri 后端会发现 `computer-use-mcp`、设置 `COMPUTER_USE_MCP_PATH`，然后启动 `agentboster-cli --mode rpc`。Desktop renderer 在 `rpc_start` 时会生成一个稳定的 `webCliSessionId` 并读取 CLI auth 配置（`agentboster-cli login` 写入的 `config.json`）里的 Web backend URL，通过 CLI 参数 `--backend-url` + `--web-session-id` 传给 CLI。

> 配置路径按平台不同：Linux 为 `~/.config/agentboster-cli/config.json`，macOS 为 `~/Library/Application Support/agentboster-cli/config.json`，Windows 为 `%LOCALAPPDATA%\agentboster-cli\config.json`。由 `getAgentbosterHome()` 在 `@agentboster/adapter` 内部解析。

CLI 在 RPC mode 启动时，如果两个参数都存在且 auth token 可用，会同时做两件事：

- 调用 `startCliSessionRegistrar` 注册 online + 30s heartbeat，把 `cli-remote:<sessionId>` KV 写入 Web，使 `getCliCapabilities(sessionId)` 返回 `online=true`、`hasDisplay=true`、`tools=[screenshot, mouse_*, ...]`。
- 调用 `connectSessionEventStream` 监听同一条 session-events SSE，承接 Web 推过来的 `tool-request`，本地执行（复用 remote-control 的 `executeLocalTool`）后 `POST /api/cli/tool-result` 回去。

这样 Web 侧 `computer-use-remote` Tool Provider 在 factory 检查 `getCliCapabilities(sessionId)` 时会拿到注册状态，把 screenshot / mouse_* / key_event / accessibility 工具注册给模型；模型调用时通过 `writeLocalToolRequest` + `pushToCliSession` 双写，CLI 通过 SSE 收到并执行。

此外 `core/capability-detect.ts:resolveMcpBinary` 现在也读 `COMPUTER_USE_MCP_PATH`（之前只看 sibling 路径，Desktop 注入的 MCP 路径无法被 capability 检测看到，导致 register 时 `hasMcpBinary=false`）。

进程退出方面，Desktop Rust 端 `stop_rpc_instance` 改为 SIGTERM-first：先关闭 stdin（触发 RPC mode 的 `process.stdin.on('end')` → `shutdown()` → `registrar.stop()` 调 `POST /release`），轮询 2s 等优雅退出，超时再 SIGKILL。即便 SIGKILL 兜底，KV TTL 120s 也会最终清理。

剩余的限定：

- **CLI RPC mode 收到 remote tool-request 时不会获取 RemoteControlLock**。Detached Remote-Control Mode 在收到 `lock-acquired`/`lock-released` 时会调 `remoteControlLock.acquire/release` 防止 IM 远程回合跟 CLI 本地输入串扰；RPC mode 当前忽略这两个事件，因为 Desktop embedder 才是本地输入的拥有者。如果未来要让 Desktop 与 Web LLM 协同输入，需要补这一层。
- **`getStoredAuth()` 必须有 token**。Desktop 用户必须先在 CLI 跑过 `agentboster-cli login`。否则 RPC mode 跳过 Web session bridge，CLI 仍能跑 Desktop 本地任务，但 `computer-use-remote` 在 Web 侧不会注册。

### 6.2 Agentboster：远程 LLM 控制 agentd 沙箱桌面

Agentboster 的第二种远程 LLM Desktop 位于 agentd 的持久 LXC 沙箱中。模型仍在 Web 侧，但工具不再经用户 CLI，而是由 Web 调度到在线 agentd 节点：

```text
Web Workflow / 远程 LLM
  -> desktop_* Tool Call
    -> 选择在线 agentd Node
      -> LXC Sandbox
        -> Xvfb + icewm + x11vnc
        -> xdotool / AT-SPI2
      <- PNG / Accessibility Result
  <- Tool Result 恢复模型
```

这里也有两个彼此独立的观察面：

- **模型观察面**：`desktop_screenshot` 返回单张 PNG，或 `desktop_inspect` 返回 AT-SPI2 语义树。
- **用户观察面**：Desktop 的 `agentd-vnc` pane 通过 noVNC/RFB 观看连续画面并发送用户输入。

agentd 截图会被 Web Dispatcher 解析成真正的 Image Content Block，因此模型无需再读取文件。`desktop_inspect` 则返回紧凑文本和 `eN` Ref，后续可用 `desktop_a11y_click`、`desktop_a11y_type` 精确操作。对于常规 GTK/Chromium/Electron UI，优先使用语义树通常比连续截图更省 Token。

该形态比物理桌面更适合自治任务：

- GUI 运行在隔离沙箱，不直接暴露用户日常桌面；
- 分辨率和窗口管理器相对稳定；
- 用户可通过 noVNC 旁观或接管；
- 即使 Desktop App 关闭，只要 Web、Workflow 和 agentd 在线，沙箱任务仍可继续；
- 可以由调度器选择不同 agentd Node，而不是绑定唯一一台个人电脑。

限制包括：

- 首次调用可能需要约 30 秒安装并启动桌面栈；
- agentd Node 离线时工具不可用；
- noVNC 可见不代表 LLM Tool Call 一定成功，反之亦然；
- 模型和用户同时输入时仍可能发生焦点和坐标竞争；
- 当前 Desktop Tool 对 Web UI Source 有注册限制，主要面向 CLI、IM 和 Scheduled Session。

### 6.3 Memoh：远程 LLM 控制 Bot Workspace Desktop

Memoh 的 LLM Tool Loop 运行在 Go Server 内，目标桌面通常也位于 Server 管理的 Bot Workspace 中。相较 Agentboster 物理桌面路径，它少了一层跨公网 CLI 回调：

```text
Memoh Server / 远程 LLM
  -> computer_observe / computer_action
    -> Workspace Bridge
      -> a11y-cli 或 Display Service
        -> Workspace Xvnc Desktop
```

只有 Bot 启用了 Workspace Display，Server 才会向模型注册这些 GUI 工具。

Memoh 把浏览器和整机桌面明确分成两套工具：

| 工具 | 控制对象 | 首选观察方式 | 首选控制方式 |
|---|---|---|---|
| `browser_observe` / `browser_action` | Headed Chrome/Chromium 页面 | CDP Snapshot、Content、DOM | Element Ref / CDP Action |
| `computer_observe` / `computer_action` | 整个 Xvnc 桌面、原生窗口、系统弹窗 | AT-SPI Snapshot | Accessibility Ref，RFB 坐标作为回退 |
| `browser_remote_session` | 同一个 Workspace Chrome | CDP Endpoint | Workspace 内 Playwright/CDP 代码 |

这体现了一个重要策略：网页任务优先走 Browser Use，因为 DOM/CDP 比视觉坐标稳定；只有原生对话框、非浏览器应用或 CDP 无法覆盖的状态才使用 Computer Use。

#### Memoh 截图不会自动进入模型上下文

Memoh 的 `computer_observe screenshot` 和 Browser Screenshot 会把图像保存到 Workspace 路径，并只向 Tool Result 返回路径提示。模型如果确实需要看像素，需要再调用 `read` 读取该图片。

因此视觉回路是：

```text
computer_observe(screenshot)
  -> Screenshot saved to /workspace/...png
    -> read(/workspace/...png)
      -> 图像进入模型上下文
        -> computer_action(...)
```

与 Agentboster 的截图直返相比，这多一个 Tool Step，但有几个明确收益：

- 不会因为例行 Observe 就自动把屏幕像素发送给模型 Provider；
- 模型可先根据 Accessibility Snapshot 完成任务，只在语义不足时读取图片；
- 截图成为 Workspace 文件，可供后续工具、审计或人工检查使用；
- 视觉成本从“默认发生”变成“模型显式选择”。

代价是视觉任务会增加一次工具往返，而且模型必须正确理解“返回的是路径而不是图像”。如果模型不支持图像输入，截图仍可保存在 Workspace，但不能直接形成有效视觉推理。

#### Memoh 的用户实时观看通道

用户在 Web 或 Electron Desktop 中打开 Display Panel 时，客户端与 Server Display Service 协商 WebRTC：

```text
Workspace Xvnc/RFB
  -> Server Display Service
    -> GStreamer / WebRTC Video Track
      -> Web 或 Electron <video>

用户鼠标键盘
  -> WebRTC Data Channel
    -> Server Display Service
      -> RFB Input
        -> Workspace Desktop
```

用户看到的是连续视频，并能实时点击和输入。LLM 不订阅这条连续视频流；LLM 的截图由 Server Display Service 按 Tool Call 单独从 RFB 桌面捕获。

Display Panel 会从视频元素周期提取静态快照，用于前端面板状态和快速恢复。这些前端快照同样不等于 LLM Observation，也不会因为面板保持打开就自动进入对话上下文。

#### Agent 与用户共享同一桌面

Memoh 的 LLM Action 和用户接管最终都写入同一个 Workspace Display：

- LLM 优先通过 Accessibility Ref 操作；
- 无法使用 Ref 时，LLM 通过 Server Display Service 发送 RFB Pointer/Key；
- 用户通过 WebRTC Data Channel 发送 RFB Pointer/Key；
- 前端只允许当前激活的 Display Pane 转发输入，避免多个后台 Pane 互相抢鼠标。

这解决了多个 Viewer Pane 的前端竞争，但不能完全解决“用户与 Agent 同时操作”的竞争。用户接管时如果 Agent 仍在执行 Tool Loop，双方仍可能改变焦点、窗口位置或输入内容。当前代码更接近共享控制，而不是带显式租约的独占控制。

### 6.4 三条通道的横向比较

| 项目 | Agentboster 物理桌面 | Agentboster agentd 桌面 | Memoh Workspace Desktop |
|---|---|---|---|
| LLM 所在位置 | Web Workflow / 远程 Provider | Web Workflow / 远程 Provider | Memoh Go Server / 远程 Provider |
| 桌面所在位置 | 用户电脑 | agentd LXC | Bot Workspace |
| Tool 传输 | Web -> SSE/KV -> CLI -> MCP | Web -> agentd HTTP/mTLS | Server 进程 -> Workspace Bridge/Display |
| 语义观察 | OS Accessibility | AT-SPI2/dbushelper | AT-SPI2 `a11y-cli` |
| 截图进入模型 | Tool Result 直接附图 | Tool Result 直接附图 | 先存 Workspace，模型显式 `read` |
| 连续视频给用户 | 用户直接看物理屏幕 | noVNC/RFB | WebRTC Video |
| 用户远程输入 | 当前没有由 Computer Use Tool 自带的通用视频远控 UI | noVNC | WebRTC Data Channel -> RFB |
| NAT 方向 | CLI 主动连 Web，无需本机入站 | Web/agentd 按节点连接配置 | Desktop Client 不参与 Workspace Display；Viewer 连 Server |
| Desktop App 关闭后 | 物理桌面工具离线 | agentd 任务可继续 | Server Workspace 任务可继续 |
| 多节点/迁移 | Session 绑定一台在线 CLI | 可选择 agentd Node | Bot 绑定 Server/Container Workspace；Remote Runtime 另算 |

### 6.5 延迟、Token 与视觉策略

远程 LLM Desktop 的响应速度不能只看视频帧率。真正决定 Agent 完成一步 GUI 操作耗时的是整个闭环：

```text
Observe
  -> 网络传输
    -> 模型视觉/语义推理
      -> Action Tool Call
        -> 远端输入执行
          -> UI 重绘
            -> 下一次 Observe
```

三种观察方式的取舍如下：

| 观察方式 | 优点 | 代价 | 适用场景 |
|---|---|---|---|
| Accessibility Snapshot | Token 少、目标稳定、可直接使用 Ref | 依赖应用正确暴露语义 | 表单、按钮、菜单、标准控件 |
| Browser DOM/CDP | 语义最完整、无需视觉定位 | 只覆盖浏览器页面 | Web 应用和网页自动化 |
| Screenshot | 覆盖任何可见 GUI，适合理解布局 | 图像上传慢、视觉 Token 高、坐标脆弱 | Canvas、原生弹窗、图像状态、语义缺失 UI |
| 连续 VNC/WebRTC | 适合人类实时旁观和接管 | 不适合作为逐帧 LLM 上下文 | 调试、人工确认、紧急接管 |

因此，两边比较合理的 Agent 策略都是：

1. Browser DOM/CDP 优先；
2. Accessibility Snapshot 次之；
3. Screenshot 只在视觉布局确实重要时使用；
4. Action 后仅在下一步依赖新状态时重新 Observe；
5. 用户实时视频用于监督，不作为模型的连续视觉输入。

### 6.6 隐私和数据出域

“用户能看到远程桌面”和“LLM Provider 能看到桌面内容”是两件不同的事。

| 数据 | 是否通常离开目标电脑/Workspace | 是否进入 LLM Provider |
|---|---|---|
| Accessibility Snapshot | 会作为 Tool Result 回到 Agent Server | 是，通常作为文本进入模型上下文 |
| Agentboster Computer Use Screenshot | 从 CLI/agentd 回传 Web | 是，直接作为图像 Tool Result |
| Memoh Screenshot 文件 | 保存到 Workspace | 仅当模型随后显式 `read` 时进入 |
| noVNC/WebRTC 连续视频 | 传到用户 Viewer | 不会自动进入 LLM |
| 用户鼠标键盘输入 | 传到目标桌面 | 通常不会作为屏幕内容自动进入 LLM，但可能通过后续 Observe 被看到 |

由此可见：

- Agentboster 的截图直返更顺滑，但默认的数据出域更积极；
- Memoh 的截图落盘再读取更保守，但 Tool Loop 更长；
- 两边的 Accessibility Snapshot 都可能包含窗口标题、控件名称和输入框值，不能因为它是文本就视为无敏感信息；
- 物理桌面比隔离 Workspace 更容易混入私人通知、其他应用窗口和系统凭据。

### 6.7 并发、抢控与一致性

远程 LLM Desktop 不是事务系统。一次 `observe -> action` 之间，屏幕可能已被用户、动画、通知或另一个 Agent 改变。

Agentboster 物理桌面通过 Lock File 避免 CLI 和 Desktop 同时开启两个 `computer-use-mcp` Session，但这不能阻止用户本人移动鼠标或切换窗口。IM 远控还使用每个 Workflow Run 的 Session Lock，避免同一个 CLI Session 被多个远程回合并发占用。

agentd noVNC 和 Memoh WebRTC 都允许用户与 Agent 触达同一桌面输入面。当前更可靠的使用方式是：

- Agent 自动执行时用户只观察；
- 用户接管前先停止或暂停 Agent 回合；
- 使用 Ref 而不是长期缓存的坐标；
- 关键写操作后重新观察；
- 对不可逆操作增加审批，而不是只依赖视觉确认。

### 6.8 故障与降级方式

| 故障 | Agentboster 行为 | Memoh 行为 |
|---|---|---|
| LLM Provider 不可用 | Workflow 无法继续推理，桌面本身仍在 | Agent 回合失败，Workspace 和 Display 可继续运行 |
| CLI/Desktop 离线 | 物理桌面工具不注册或返回错误 | 不影响 Server Workspace；只影响该电脑的 Remote Runtime |
| agentd 离线 | agentd Desktop/Browser Tool 不可用 | 不适用 |
| Workspace Display 未启用 | agentd Desktop 需在线节点和沙箱准备 | Browser/Computer Tool 不注册 |
| Accessibility 不可用 | 退回截图和坐标；部分输入工具可能不注册 | 退回 Screenshot 或 RFB 坐标输入 |
| 视频编码/Viewer 失败 | noVNC 查看失败，但 Tool Screenshot 可能仍工作 | WebRTC Viewer 失败，但 Server Tool Screenshot 可能仍工作 |
| Tool Result 回调丢失 | Workflow 等待 Hook，最终超时 | Tool Execute 在 Server 内返回错误或超时 |
| 用户与 Agent 同时输入 | 物理桌面或 noVNC 焦点竞争 | Workspace RFB 焦点竞争 |

一个重要结论是：**人工 Viewer 故障不必然等于 LLM 失明，LLM Tool 故障也不必然等于人工 Viewer 黑屏。** 两条链路应分别监控和报告状态。

### 6.9 产品层面的差异

Agentboster 的远程 LLM Desktop 更像“把远程大脑接到现有电脑”：

- 可以接入用户真实桌面和本地开发环境；
- 也可以改走 agentd 的隔离桌面；
- CLI Session 是远程 LLM 与个人电脑之间的能力桥梁；
- 更适合临时接管、开发协作和跨 IM 操作本机。

Memoh 的远程 LLM Desktop 更像“给远程大脑一台长期拥有的电脑”：

- Desktop 属于 Bot Workspace，而不是属于 Viewer；
- Browser、文件、终端、Display 和记忆围绕同一个 Bot 生命周期组织；
- Electron Desktop 只是观察和管理入口，关掉后 Server Agent 仍可工作；
- 更适合持续自动化、多 Bot 和多人共享监督。

## 7. UI 与交互模型

### 7.1 Agentboster：Workspace / Project / Session

Agentboster Desktop 的导航层级更接近开发工具：

```text
Workspace
  -> Project
    -> Session Tab
    -> File Tab
    -> Terminal Tab
    -> Schedule
    -> Packages / Settings / AgentD VNC
```

主要交互特征包括：

- 从本地目录开始新会话；
- 项目级 Session 列表和恢复；
- 多会话同时保持 Runtime；
- 文件预览和编辑；
- 可调整宽度的聊天/文件分栏；
- 全屏终端标签页（取代底部 Terminal Dock）；
- 模型和 Thinking Level 快速切换；
- Session Fork、历史查看和 HTML 导出；
- 定时任务管理（Schedule Pane：delay/daily 类型，节点路由偏好，IM 通知渠道选择）；
- Computer Use 截图格式/质量设置（JPEG/PNG + 质量滑块）；
- 扩展 UI 的 select、confirm、input、editor 等原生 Overlay；
- Package、Skill、Prompt、Theme 和命令面板。

这套信息架构假设用户的主要任务是：打开一个代码项目，和 Agent 共同完成开发工作。

### 7.2 Memoh：Bot / Workspace / Panel

Memoh 的导航层级更接近多 Agent 平台：

```text
用户/团队
  -> Bot
    -> Chat Session
    -> Workspace
      -> File
      -> Terminal
      -> Browser
      -> Desktop
      -> Schedule
    -> Memory / Provider / Channel / Plugin / Permission
```

主工作区使用 Dockview 管理面板，可以打开或切分：

- Chat；
- File Editor / Preview；
- Terminal；
- Browser；
- Desktop Display；
- Schedule。

设置面远比单个编码 Agent 更宽，包含：

- Bots；
- Providers 和 Models；
- Memory；
- Web Search；
- Voice / Transcription；
- Email；
- Channels 和身份；
- MCP / Plugins / Supermarket；
- Members 和权限；
- Runtimes；
- Usage；
- Appearance 和 Keyboard。

这套信息架构假设用户的主要任务是：创建、配置、观察和管理一个或多个长期运行的 Bot。

## 8. 生命周期与“常驻”含义

### 8.1 Agentboster

Agentboster Desktop 当前主要是前台工作台：

- 启动应用后创建 Tauri 主窗口；
- 打开 Session 时启动本地 CLI RPC 子进程；
- 多个 Session 可以持有多个 RPC 子进程；
- 系统托盘常驻，托盘菜单提供 Show / New Chat / Quit，左键单击切换窗口显隐；
- 关闭主窗口的行为由 `settings.json` 的 `close_action` 决定：`ask`（默认）会弹原生对话框询问一次并可记住选择，`tray` 直接隐藏到托盘，`quit` 直接退出；
- 退出时通过 `RunEvent::ExitRequested` 拦截，drain 所有 RPC 子进程，避免孤儿进程。

当 `close_action = quit` 或用户从托盘选择 Quit 时，Desktop 会失去：

- 本地 CLI 交互；
- 本机项目工具；
- 物理桌面 Computer Use；
- Desktop 中的 VNC 查看入口。

但当 `close_action = tray` 或用户在询问对话框中选择"隐藏到托盘"时，主窗口只隐藏、RPC 子进程继续运行，所有上述能力保持在线，托盘图标常驻供随时唤起。

不代表整个 Agentboster 系统停止。已经部署的 Web Workflow、IM Bot、定时工作流和 agentd 节点仍可独立运行。

### 8.2 Memoh

Memoh Desktop 是显式的常驻应用：

- 创建系统托盘；
- 关闭窗口时隐藏；
- 托盘直接选择 Bot 或设置页面；
- Remote Runtime 状态在托盘显示；
- 显式选择 Quit 才执行完整退出和 Runtime 清理。

服务器 Workspace 中的 Bot 不依赖 Desktop 窗口存活。即使用户关闭笔记本，Server 上的 Agent、记忆、渠道、心跳和定时任务仍可继续。

但要区分两种 Workspace：

- **Server/Container Workspace**：随服务器运行，不依赖笔记本。
- **绑定到 Desktop 的 Remote Runtime**：依赖 Desktop 和笔记本在线；离线后不会自动变成一台可用的本机执行节点。

## 9. 安全边界

### 9.1 Agentboster Desktop 的边界

Agentboster Desktop 为了成为本地编码 Agent Host，需要较强的本机权限：

- Tauri Shell 权限；
- 文件系统权限；
- 启动和管理 CLI 子进程；
- Git 和外部程序调用；
- computer-use-mcp 的屏幕读取和输入注入；
- macOS Accessibility、Windows UIAutomation 或 Linux AT-SPI 等系统授权。

优势是本地开发体验直接；代价是权限范围更接近 IDE 和自动化工具。尤其是物理桌面 Computer Use，其风险高于沙箱内 GUI 自动化。

Agentboster 的另一层安全来自 Web/agentd：

- Web 持有会话和 Workflow 权威状态；
- agentd 工具执行经过 L0/L1/L2 安全评估；
- agentd 桌面位于 LXC 沙箱；
- CLI 和 agentd 使用不同鉴权和执行边界。

### 9.2 Memoh Desktop 的边界

Memoh Electron Renderer 使用：

- `contextIsolation: true`；
- `nodeIntegration: false`；
- 受信 Renderer URL 检查；
- 狭窄、类型化的 preload IPC；
- 外部 URL 白名单协议；
- `safeStorage` 加密 Remote Runtime Key。

Remote Runtime 进一步使用：

- 固定 Workspace Base；
- 每个服务器挂载的 Workspace ID 和相对路径 scope；
- PathGuard 防止目录穿越；
- 受约束的文件 RPC；
- 受监督的命令子进程；
- 当前禁用 Tunnel 和 ReverseHTTP。

因此 Memoh Desktop 对本机暴露的默认能力比 Agentboster 的物理桌面 Computer Use 更窄。但一旦用户将某个 Remote Runtime Workspace 授权给 Bot，该 Bot 仍能在对应目录中读写文件和执行 Shell，必须按高权限能力管理。

## 10. 部署与升级边界

### 10.1 Agentboster

Agentboster 是多组件部署：

- Next.js Web；
- agentd；
- CLI；
- Desktop；
- computer-use-mcp；
- dbushelper。

Desktop 是 CLI 的图形宿主，不等同于 Web，也不等同于 agentd。Desktop 可以独立更新，并在启动时发现或安装兼容的 CLI。物理桌面能力由 `computer-use-mcp` Sidecar 提供，agentd 沙箱桌面能力则由另一套 Go/Linux 组件提供。

### 10.2 Memoh

Memoh Desktop 的打包边界刻意保持简单，只包含：

- Electron 应用；
- Renderer 资源；
- 图标；
- `@memohai/runtime` JavaScript SDK 和 gRPC Proto。

Server、数据库、Qdrant、容器运行时和 Workspace Toolkit 都必须部署在 Memoh Server 一侧。Desktop 与 Server 通过公开 API 和 Runtime 协议连接。

这意味着 Memoh Desktop 更容易理解为“Server 的原生分发渠道”，而 Agentboster Desktop 更像“CLI 的原生图形宿主”。

## 11. 各自更适合的场景

### Agentboster Desktop 更适合

- 以本地 Git 仓库为中心的开发任务；
- 同时查看聊天、代码和终端；
- 使用本机已安装的开发环境和凭据；
- 让 Agent 操作本地桌面应用；
- 调试 agentd 沙箱中的 Electron/Tauri/Qt/GTK 应用；
- 需要 Session Fork、代码工作区和 CLI 扩展生态的个人开发者。

### Memoh Desktop 更适合

- 管理多个长期运行的 Bot；
- 给团队成员分配不同 Bot 和权限；
- 统一配置模型、记忆、渠道、MCP 和插件；
- 通过 Telegram、Discord、飞书、微信、邮件等渠道持续服务；
- 让每个 Bot 使用独立的服务器 Workspace、浏览器和桌面；
- 必要时把某台个人电脑的受约束目录临时接入 Server。

## 12. 不能直接类比的部分

### 12.1 Agentboster `computer-use-mcp` 不等于 Memoh Remote Runtime

前者包含屏幕、输入和无障碍控制；后者当前只有文件、命令和 Workspace scope。两者权限模型、工具协议和用户预期都不同。

### 12.2 Agentboster agentd Desktop 不等于 Agentboster Desktop App

前者是 Linux 沙箱中的 X11 桌面；后者是安装在用户电脑上的 Tauri 应用。Desktop App 只是其中一个查看和控制入口。

### 12.3 Memoh Workspace Desktop 不等于用户物理桌面

Memoh 的 Xvnc Display 属于 Bot Workspace。即使用户通过 Electron Desktop 查看它，画面也来自 Workspace，不是默认来自用户正在使用的操作系统桌面。

### 12.4 两者都不是完全脱离服务端的本地单机 Agent

Agentboster 的 Web 是 Workflow、模型和会话权威端；Memoh Desktop 也必须连接 Cloud 或 Hosted Server。它们都可以在本机执行工作，但核心平台状态并不只存在 Desktop 应用内部。

## 13. 最终判断

如果只比较窗口截图，两者都会呈现侧栏、聊天、文件、终端和桌面面板，看起来很接近。但从运行边界看，它们是两种不同产品：

```text
Agentboster Desktop
= 本地项目工作台
+ 本地 CLI RPC Host
+ 物理桌面 Computer Use（Desktop RPC mode 自动注册到 Web backend）
+ agentd 沙箱桌面的查看入口
+ 系统托盘常驻与可配置的关闭到托盘流程

Memoh Desktop
= Memoh Server 的原生常驻客户端
+ 多 Bot 管理和 Web UI 复用
+ 可选的受约束 Remote Runtime
+ Bot Workspace 桌面的查看与接管入口
```

因此，Agentboster 的 Desktop 形态更强调“Agent 来到我的电脑和项目中工作”；Memoh 的 Desktop 形态更强调“我从桌面客户端管理运行在平台中的 Agent 及其电脑”。

## 14. 主要代码依据

### Agentboster

- [`README.md`](../README.md)：Web、agentd、CLI、computer-use-mcp 的总体职责。
- [`subpackage/cli/packages/desktop/README.md`](../subpackage/cli/packages/desktop/README.md)：Tauri Desktop 和本机 Computer Use 定位。
- [`subpackage/cli/packages/desktop/FEATURE_MAPPING.md`](../subpackage/cli/packages/desktop/FEATURE_MAPPING.md)：聊天、Session、包管理和扩展 UI 能力映射。
- [`subpackage/cli/packages/desktop/src/main.ts`](../subpackage/cli/packages/desktop/src/main.ts)：Workspace、Session/File Tab、Terminal、Schedule、Packages 和 AgentD VNC 布局。
- [`subpackage/cli/packages/desktop/src-tauri/src/lib.rs`](../subpackage/cli/packages/desktop/src-tauri/src/lib.rs)：CLI 发现/安装、RPC 子进程和 computer-use-mcp 注入；托盘菜单、关闭到托盘拦截、`close_action` 持久化、退出时 drain RPC。
- [`subpackage/cli/packages/desktop/src-tauri/tauri.conf.json`](../subpackage/cli/packages/desktop/src-tauri/tauri.conf.json)：窗口和 Tauri 打包配置；`app.trayIcon` 声明。
- [`subpackage/cli/packages/desktop/src/main.ts`](../subpackage/cli/packages/desktop/src/main.ts)（事件监听部分）：监听主进程 `close-requested` 事件，弹原生对话框并回传用户选择；监听 `tray-new-chat` 触发新会话。
- [`subpackage/cli/packages/desktop/src/components/settings-panel.ts`](../subpackage/cli/packages/desktop/src/components/settings-panel.ts)（Window & tray 分组）：暴露 `close_action` 三选一，调 `set_close_action` 持久化。
- [`subpackage/computer-use-mcp/README.md`](../subpackage/computer-use-mcp/README.md)：跨平台本机 Computer Use Server。
- [`lib/workflow/agent/tools/execute/computer-use.ts`](../lib/workflow/agent/tools/execute/computer-use.ts)：远程 LLM 到 CLI/MCP 的 Computer Use 注册门槛（`getCliCapabilities(sessionId).online && hasDisplay`）和 Tool Result 回路。
- [`lib/workflow/agent/tools/execute/desktop.ts`](../lib/workflow/agent/tools/execute/desktop.ts)：agentd 沙箱 Desktop 工具。
- [`app/api/cli/session-events/[sessionId]/route.ts`](../app/api/cli/session-events/[sessionId]/route.ts)：Detached Remote-Control 的 SSE、能力登记和 KV 降级入口。
- [`lib/cli/remote-control.ts`](../lib/cli/remote-control.ts)：CLI 在线状态、Event Queue、IM Attachment 和 Session Lock。
- [`subpackage/cli/packages/coding-agent/src/core/cli-session-registrar.ts`](../subpackage/cli/packages/coding-agent/src/core/cli-session-registrar.ts)：register/heartbeat/release 公共模块（remote-control-mode 和 rpc-mode 共用）+ session-events SSE 监听。
- [`subpackage/cli/packages/coding-agent/src/modes/rpc/rpc-mode.ts`](../subpackage/cli/packages/coding-agent/src/modes/rpc/rpc-mode.ts)（`startWebSessionBridge`）：RPC mode 启动时如带 `--backend-url` + `--web-session-id`，注册 online + 监听 SSE tool-request。
- [`subpackage/cli/packages/coding-agent/src/core/capability-detect.ts`](../subpackage/cli/packages/coding-agent/src/core/capability-detect.ts)：`resolveMcpBinary` 现在也读 `COMPUTER_USE_MCP_PATH`。
- [`subpackage/cli/packages/desktop/src/rpc/bridge.ts`](../subpackage/cli/packages/desktop/src/rpc/bridge.ts)（`RpcStartOptions.sessionId/backendUrl`）：Desktop renderer 生成 stable `webCliSessionId` + 从 `agentboster-auth` 读 backendUrl 传给 Rust。
- [`subpackage/cli/packages/desktop/src-tauri/src/lib.rs`](../subpackage/cli/packages/desktop/src-tauri/src/lib.rs)（`build_command` + `stop_rpc_instance`）：Rust 端转发 `--backend-url`/`--web-session-id`；SIGTERM-first 的 stop 让 CLI 优雅 release，避免 KV 幽灵在线。
- [`subpackage/cli/packages/coding-agent/src/modes/remote-control/remote-control-mode.ts`](../subpackage/cli/packages/coding-agent/src/modes/remote-control/remote-control-mode.ts)：CLI Remote-Control 长连接和 Tool Executor（已改用 cli-session-registrar）。

### Memoh

- [`memoh/README_CN.md`](../memoh/README_CN.md)：每个 Agent 一台 Workspace 电脑的产品定位。
- [`memoh/apps/desktop/AGENTS.md`](../memoh/apps/desktop/AGENTS.md)：Electron Desktop 的边界和 Web 复用规则。
- [`memoh/apps/desktop/README.md`](../memoh/apps/desktop/README.md)：Desktop 是 Hosted Server Client，不打包本地 Server。
- [`memoh/apps/desktop/src/main/index.ts`](../memoh/apps/desktop/src/main/index.ts)：窗口、托盘、Server 连接、IPC 和 Runtime 生命周期。
- [`memoh/apps/desktop/src/main/remote-runtime.ts`](../memoh/apps/desktop/src/main/remote-runtime.ts)：Remote Runtime 配置、加密和连接管理。
- [`memoh/packages/runtime/src/session.ts`](../memoh/packages/runtime/src/session.ts)：Remote Runtime 握手能力。
- [`memoh/packages/runtime/src/service.ts`](../memoh/packages/runtime/src/service.ts)：文件/命令 RPC 以及 M1 的 Tunnel/ReverseHTTP 限制。
- [`memoh/apps/web/src/store/workspace-tabs.ts`](../memoh/apps/web/src/store/workspace-tabs.ts)：Chat、File、Terminal、Browser、Display 和 Schedule 面板。
- [`memoh/apps/web/src/pages/home/components/display-pane.vue`](../memoh/apps/web/src/pages/home/components/display-pane.vue)：WebRTC 视频、用户输入和前端 Display Snapshot。
- [`memoh/internal/agent/tools/browser.go`](../memoh/internal/agent/tools/browser.go)：Browser/Computer Observe、Action 和截图落盘策略。
- [`memoh/internal/display/service.go`](../memoh/internal/display/service.go)：Workspace Display、RFB 和 WebRTC 服务。
