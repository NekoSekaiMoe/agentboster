# CLI/Desktop 远程遥控模式 — 实施计划

## 概述

用户通过 IM（Telegram/Discord/Slack 等）或 WebUI 远程指挥 CLI/Desktop 操控本地电脑。
核心思路：IM 作为已有 CLI 会话的第二输入源，不涉及跨会话、跨节点。

### 架构图

```
┌────────────────────────────────────────────────────────┐
│ 用户电脑                                                │
│                                                        │
│  ┌──────────┐  stdio/MCP  ┌─────────────────────────┐  │
│  │computer- │◄───────────►│ CLI (agentboster-cli)   │  │
│  │use MCP   │             │                         │  │
│  │(Rust bin)│             │ • 持久 SSE 连接到 Web    │  │
│  └──────────┘             │ • 接收 tool-request      │  │
│   截图/鼠标/键盘/a11y       │ • 执行后 POST 结果回 Web │  │
│                           │ • 进程锁（远程接管时只读） │  │
│                           └────────────┬────────────┘  │
└────────────────────────────────────────┼────────────────┘
                            持久 SSE ↕ tool-result POST
                        ┌────────────┴────────────┐
                        │     Web 后端 (Next.js)    │
                        │                          │
                        │ • session-events 端点     │
                        │ • CLI 在线状态追踪         │
                        │ • IM 消息路由到 CLI 会话    │
                        │ • L2 审批 → IM 按钮        │
                        └────────────┬─────────────┘
                            IM webhook ↕ 消息/审批
                        ┌────────────┴────────────┐
                        │   IM (Telegram/Discord)   │
                        │                           │
                        │  /attach <sessionId>      │
                        │  用户发送指令 → 路由到会话   │
                        │  L2 审批按钮 → 批准/拒绝    │
                        └───────────────────────────┘
```

### 核心约定

- CLI 和 Desktop 保持独立包，Desktop 通过 RPC 模式调用 CLI
- Desktop 调用 CLI 时共享 `agentboster-desktop` 配置目录，CLI 独立运行时用 `agentboster-cli`
- computer-use MCP 作为独立 Rust binary，built-in 到 CLI tarball 和 Desktop Tauri bundle
- 远程遥控基于「IM 作为 CLI 会话的第二输入源」，不涉及跨会话、跨节点
- 一个 CLI 进程同时只跑一个会话；会话切换时远程绑定自动跟随
- CLI 掉线 → 会话完全冻结（不接受新消息，只读历史）
- L2 审批复用 agentd 现有 IM 按钮模式
- 调用 computer-use MCP binary 时 CWD 保持调用者当前目录

---

## 模块 1：computer-use MCP Server（4 天）

### 1.0 目标

将 Desktop 的 `computer_use.rs` 核心逻辑提取为独立 Rust library crate，
在此基础上构建 MCP server binary。Desktop 和 CLI 共享同一份实现代码。

### 1.1 目录结构

**新建目录**：`subpackage/computer-use-mcp/`

```
subpackage/computer-use-mcp/
├── core/                              ← Rust library crate (共享实现)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                     ← 公开 API
│       ├── screenshot.rs              ← xcap 截图 + image crate Lanczos3 缩放
│       ├── input.rs                   ← enigo 鼠标/键盘注入
│       ├── accessibility.rs           ← 平台 a11y
│       │                                 macOS: accessibility-sys C API
│       │                                 Windows: uiautomation crate
│       │                                 Linux: atspi / zbus 直连 D-Bus
│       ├── lock.rs                    ← 机器范围锁文件
│       ├── safety.rs                  ← 终端窗口排除 + Escape 全局钩子
│       └── coord.rs                   ← 坐标缩放：外部(缩放后) ↔ 内部(原始屏幕)
└── server/                            ← MCP server binary
    ├── Cargo.toml                     ← 依赖 core, 依赖 MCP stdio transport
    └── src/
        └── main.rs                    ← stdio JSON-RPC transport + tool dispatch
```

### 1.2 screenshot.rs — 截图 + 自动缩放

```rust
use image::imageops::FilterType;
use xcap::Monitor;

const DEFAULT_MAX_WIDTH: u32 = 1400;

pub struct ScreenshotResult {
    pub png_base64: String,
    pub native_size: (u32, u32),      // 原始分辨率 e.g. (3456, 2234)
    pub scaled_size: (u32, u32),      // 缩放后 e.g. (1400, 905)
    pub scale_factor: f64,            // native_w / scaled_w
}

pub fn capture_and_scale(
    max_width: Option<u32>,
    exclude_terminals: bool,
) -> Result<ScreenshotResult> {
    let max_w = max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let frame = Monitor::all()?[0].capture_image()?;
    let (w, h) = (frame.width(), frame.height());

    // 终端窗口排除（合成时遮罩）
    let frame = if exclude_terminals {
        mask_terminal_windows(frame)?
    } else {
        frame
    };

    let (scaled, scaled_size) = if w > max_w {
        let ratio = max_w as f64 / w as f64;
        let new_h = (h as f64 * ratio) as u32;
        let resized = image::imageops::resize(
            &frame, max_w, new_h, FilterType::Lanczos3
        );
        (resized, (max_w, new_h))
    } else {
        (frame.clone(), (w, h))
    };

    Ok(ScreenshotResult {
        png_base64: encode_png_base64(&scaled)?,
        native_size: (w, h),
        scaled_size,
        scale_factor: w as f64 / scaled_size.0 as f64,
    })
}
```

关键细节：
- Retina 16" MBP 原始 3456×2234 → 缩放到 ~1400×905，保持宽高比
- 普通 1080p (1920×1080) → 缩放到 ~1400×788
- 720p 及以下不缩放
- 模型看到的坐标都是缩放后坐标，模型传入的操作坐标也是缩放后坐标

### 1.3 coord.rs — 坐标系统

```rust
pub struct CoordMapper {
    pub scale_factor: f64,  // native / scaled
}

impl CoordMapper {
    /// 模型坐标（缩放后）→ 屏幕坐标（原始）
    pub fn to_native(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.scale_factor, y * self.scale_factor)
    }
    /// 屏幕坐标（原始）→ 模型坐标（缩放后）
    pub fn to_scaled(&self, x: f64, y: f64) -> (f64, f64) {
        (x / self.scale_factor, y / self.scale_factor)
    }
}
```

所有 mouse_move/mouse_click/mouse_drag 的坐标参数均为缩放后坐标。
MCP server 在执行前通过 `to_native()` 转换，对模型完全透明。

### 1.4 input.rs — 鼠标/键盘注入

```rust
use enigo::{Enigo, Mouse, Keyboard, Settings, Coordinate};

pub struct InputController {
    enigo: Enigo,
    coord_mapper: CoordMapper,
}

impl InputController {
    pub fn mouse_move(&mut self, x: f64, y: f64) -> Result<()> {
        let (nx, ny) = self.coord_mapper.to_native(x, y);
        self.enigo.move_mouse(nx as i32, ny as i32, Coordinate::Abs)?;
        Ok(())
    }

    pub fn mouse_click(&mut self, x: f64, y: f64, button: MouseButton, click_type: ClickType) -> Result<()> {
        self.mouse_move(x, y)?;
        match click_type {
            ClickType::Single => self.enigo.button(button.into(), enigo::Direction::Click)?,
            ClickType::Double => {
                self.enigo.button(button.into(), enigo::Direction::Click)?;
                self.enigo.button(button.into(), enigo::Direction::Click)?;
            }
            ClickType::Right => self.enigo.button(enigo::Button::Right, enigo::Direction::Click)?,
        }
        Ok(())
    }

    pub fn mouse_drag(&mut self, from_x: f64, from_y: f64, to_x: f64, to_y: f64) -> Result<()> {
        let (fx, fy) = self.coord_mapper.to_native(from_x, from_y);
        let (tx, ty) = self.coord_mapper.to_native(to_x, to_y);
        self.enigo.move_mouse(fx as i32, fy as i32, Coordinate::Abs)?;
        self.enigo.button(enigo::Button::Left, enigo::Direction::Press)?;
        self.enigo.move_mouse(tx as i32, ty as i32, Coordinate::Abs)?;
        self.enigo.button(enigo::Button::Left, enigo::Direction::Release)?;
        Ok(())
    }

    pub fn key_event(&mut self, key: &str, modifiers: &[String]) -> Result<()>;
    pub fn type_text(&mut self, text: &str) -> Result<()>;
}
```

### 1.5 accessibility.rs — 平台 a11y

```rust
pub struct AxNode {
    pub role: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub bounds: Option<Rect>,  // x, y, width, height (缩放后坐标)
    pub enabled: bool,
    pub focused: bool,
    pub children: Vec<AxNode>,
}

/// 获取辅助功能树
pub fn get_accessibility_tree(
    app_name: Option<&str>,
    max_depth: Option<u32>,
    coord_mapper: &CoordMapper,
) -> Result<Vec<AxNode>>;

/// 获取当前焦点元素
pub fn get_focused_element(coord_mapper: &CoordMapper) -> Result<Option<AxNode>>;
```

平台实现：
- **macOS**：`accessibility-sys` crate (AXUIElementRef API)
  - `AXUIElementCreateApplication` → 遍历 AXChildren
  - bounds 通过 `kAXPositionAttribute` + `kAXSizeAttribute`
  - 需要 Accessibility 权限 (`AXIsProcessTrusted()`)
- **Windows**：`uiautomation` crate
  - `UIAutomation::new()` → `get_root_element()` → `find_all()`
  - bounds 通过 `get_bounding_rectangle()`
- **Linux**：`atspi` crate 或 `zbus` 直连 AT-SPI2 D-Bus
  - `org.a11y.Bus` → 遍历 Accessible 接口
  - bounds 通过 `Component.GetExtents()`
  - 不依赖 dbushelper（dbushelper 仅服务 agentd 容器场景）

所有 bounds 输出为缩放后坐标（通过 `coord_mapper.to_scaled()`）。

### 1.6 lock.rs — 机器范围锁

```rust
use std::fs;
use std::path::PathBuf;
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct LockInfo {
    pid: u32,
    session_id: String,
    acquired_at: String,  // ISO 8601
}

pub struct ComputerUseLock {
    path: PathBuf,
}

impl ComputerUseLock {
    /// 锁文件路径：~/.config/agentboster-desktop/computer-use.lock
    /// CLI 独立运行时：~/.config/agentboster-cli/computer-use.lock
    /// 两者都检查，确保互斥
    pub fn acquire(session_id: &str, config_dir: &Path) -> Result<Self, LockError> {
        let path = config_dir.join("computer-use.lock");

        // 检查已有锁
        if path.exists() {
            let info: LockInfo = serde_json::from_str(&fs::read_to_string(&path)?)?;
            // 检查持有进程是否还活着
            if process_alive(info.pid) {
                return Err(LockError::Held {
                    session_id: info.session_id,
                    pid: info.pid,
                });
            }
            // 进程已死，stale lock，清理
            fs::remove_file(&path)?;
        }

        // 写入新锁
        let info = LockInfo {
            pid: std::process::id(),
            session_id: session_id.to_string(),
            acquired_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(&path, serde_json::to_string(&info)?)?;

        // macOS 通知
        #[cfg(target_os = "macos")]
        notify_macos("AgentBoster is using your computer · press Esc to stop");

        Ok(Self { path })
    }
}

impl Drop for ComputerUseLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
```

锁生命周期 = MCP server 进程生命周期。
CLI 退出 → MCP 进程退出 → Drop 释放锁。
CLI 和 Desktop 读同一路径（Desktop 调用 CLI 时共享 `agentboster-desktop` 目录），天然互斥。

### 1.7 safety.rs — 安全机制

```rust
/// 终端窗口排除
pub fn terminal_window_ids() -> Vec<WindowId> {
    // 按 window class / bundle id 匹配终端应用
    // macOS: com.apple.Terminal, com.googlecode.iterm2, io.alacritty, ...
    // Windows: WindowsTerminal.exe, cmd.exe, powershell.exe, ...
    // Linux: gnome-terminal, konsole, xterm, alacritty, ...
}

/// Escape 全局钩子
pub struct EscapeHook { /* platform handle */ }

impl EscapeHook {
    pub fn register(on_escape: impl Fn() + Send + 'static) -> Result<Self> {
        // macOS: CGEvent tap (kCGEventKeyDown, keycode 53)
        //   Escape 按键被消耗（不传递给应用），防止 prompt injection 用 Esc 关闭对话框
        // Linux X11: XGrabKey on root window
        // Linux Wayland: libinput 监听（需 input group 权限）
        // Windows: SetWindowsHookEx(WH_KEYBOARD_LL)
    }
}

impl Drop for EscapeHook {
    fn drop(&mut self) {
        // 注销钩子
    }
}
```

Escape 行为：
1. 中止当前正在执行的 computer-use 操作
2. 如果有隐藏的应用窗口（如全屏操控时），恢复显示
3. MCP server 继续运行（不退出），保持锁，但暂停操作
4. 用户可通过 IM 发送新指令恢复

### 1.8 server/src/main.rs — MCP Server

```rust
use computer_use_core::*;
use std::io::{BufRead, Write};

fn main() -> Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    // 初始化
    let config_dir = resolve_config_dir();  // 从 CLI 传入的环境变量或默认路径
    let lock = ComputerUseLock::acquire(&session_id_from_env(), &config_dir)?;
    let escape_hook = EscapeHook::register(|| { /* 设置 abort flag */ })?;

    // 能力检测
    let capabilities = detect_capabilities();

    // MCP initialize 握手
    // ...

    // 主循环：读取 JSON-RPC 请求，分发到对应工具
    for line in stdin.lock().lines() {
        let request: JsonRpcRequest = serde_json::from_str(&line?)?;
        let response = match request.method.as_str() {
            "tools/call" => handle_tool_call(&request.params, &capabilities)?,
            "tools/list" => handle_tools_list(&capabilities)?,
            _ => json_rpc_error(-32601, "Method not found"),
        };
        writeln!(stdout.lock(), "{}", serde_json::to_string(&response)?)?;
    }

    Ok(())
    // lock 和 escape_hook 在这里 Drop
}

fn handle_tool_call(params: &Value, caps: &Capabilities) -> Result<Value> {
    let tool_name = params["name"].as_str().unwrap();
    let args = &params["arguments"];

    match tool_name {
        "screenshot" => {
            let result = screenshot::capture_and_scale(
                args.get("max_width").and_then(|v| v.as_u64().map(|v| v as u32)),
                true, // exclude terminals
            )?;
            Ok(json!({
                "content": [{
                    "type": "image",
                    "data": result.png_base64,
                    "mimeType": "image/png"
                }],
                "_meta": {
                    "nativeSize": result.native_size,
                    "scaledSize": result.scaled_size,
                    "scaleFactor": result.scale_factor,
                }
            }))
        }
        "mouse_move" => { /* ... */ }
        "mouse_click" => { /* ... */ }
        "mouse_drag" => { /* ... */ }
        "key_event" => { /* ... */ }
        "type_text" => { /* ... */ }
        "get_accessibility_tree" => { /* ... */ }
        "get_focused_element" => { /* ... */ }
        _ => json_rpc_error(-32601, &format!("Unknown tool: {tool_name}")),
    }
}
```

MCP binary 的 CWD = 调用者（CLI/Desktop）的 CWD。
CLI spawn 时不改变工作目录：`spawn(binary_path, { cwd: process.cwd() })`。

### 1.9 MCP 工具清单

| 工具名 | 参数 | 返回 | L1 风险级别 |
|--------|------|------|-------------|
| `screenshot` | `max_width?: number` | base64 PNG image content | 低 |
| `mouse_move` | `x: number, y: number` | `{ "moved_to": [x, y] }` | 低 |
| `mouse_click` | `x: number, y: number, button?: "left"\|"right"\|"middle", click_type?: "single"\|"double"` | `{ "clicked": [x, y], "button": "left" }` | 低 |
| `mouse_drag` | `from_x, from_y, to_x, to_y: number` | `{ "dragged": { "from": [...], "to": [...] } }` | 低 |
| `key_event` | `key: string, modifiers?: string[]` | `{ "pressed": "ctrl+s" }` | 中（含危险组合键如 ctrl+alt+del） |
| `type_text` | `text: string` | `{ "typed": "hello world" }` | 低 |
| `get_accessibility_tree` | `app_name?: string, max_depth?: number` | `{ "tree": [AxNode...] }` | 低 |
| `get_focused_element` | — | `{ "element": AxNode \| null }` | 低 |

所有坐标参数和返回值均为缩放后坐标。

### 1.10 能力检测（启动时）

MCP server 在 `initialize` 响应中上报能力：

```json
{
  "capabilities": {
    "tools": {},
    "computerUse": {
      "hasDisplay": true,
      "platform": "darwin",
      "displayServer": "quartz",
      "displayResolution": {
        "native": [3456, 2234],
        "scaled": [1400, 905]
      },
      "scaleFactor": 2.468,
      "accessibilityGranted": true,
      "isAdmin": false
    }
  }
}
```

无 display server 时 `hasDisplay: false`，所有工具调用返回错误。
macOS 未授权 Accessibility 时 `accessibilityGranted: false`，
a11y 和输入工具返回引导提示：
`"Please grant Accessibility permission: System Preferences → Privacy & Security → Accessibility → Enable AgentBoster"`。

### 1.11 与 Desktop 的代码共享

Desktop 的 `computer_use.rs` 重构为调用 `core` crate：

```toml
# subpackage/cli/packages/desktop/src-tauri/Cargo.toml
[dependencies]
computer-use-core = { path = "../../../computer-use-mcp/core" }
```

Desktop Tauri commands 变为薄包装：

```rust
// desktop/src-tauri/src/computer_use.rs (重构后)
use computer_use_core::{screenshot, input, accessibility, CoordMapper};

#[tauri::command]
async fn screenshot(max_width: Option<u32>) -> Result<String, String> {
    let result = screenshot::capture_and_scale(max_width, true)
        .map_err(|e| e.to_string())?;
    Ok(result.png_base64)
}

#[tauri::command]
async fn mouse_click(x: f64, y: f64, button: Option<String>) -> Result<(), String> {
    let mut ctrl = input::InputController::new()?;
    ctrl.mouse_click(x, y, parse_button(button), ClickType::Single)
        .map_err(|e| e.to_string())
}
// ... 其余 commands 类似
```

从 ~500 行实现代码缩减到 ~100 行胶水代码。

### 1.12 打包

CLI 的 `scripts/package.mjs` 修改：

```javascript
// 在 tarball 打包前，编译 computer-use-mcp binary
const rustTarget = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
}[`${process.platform}-${process.arch}`];

if (rustTarget) {
  execSync(
    `cargo build --release --target ${rustTarget}`,
    { cwd: path.resolve(__dirname, '../../computer-use-mcp/server') }
  );
  // 复制 binary 到 tarball 的 bin/ 目录
  const binaryName = process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
  const src = path.resolve(
    __dirname, '../../computer-use-mcp/server/target', rustTarget, 'release', binaryName
  );
  const dest = path.resolve(distDir, 'bin', binaryName);
  fs.copyFileSync(src, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
}
```

产物结构：

```
agentboster-cli-<platform>-<arch>.tar.gz
├── bin/
│   ├── agentboster-cli          ← Node.js CLI
│   └── computer-use-mcp         ← Rust binary (built-in)
├── lib/
│   └── ...                      ← JS 运行时文件
└── package.json
```

---

## 模块 2：CLI 远程遥控模式（4 天）

### 2.0 目标

CLI 支持远程遥控模式：持久 SSE 连接、进程锁（TUI 只读）、
computer-use MCP 自动启动、会话切换同步。

### 2.1 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/coding-agent/src/core/remote-control.ts` | 新建 | 远程遥控管理器 |
| `packages/coding-agent/src/core/remote-control-lock.ts` | 新建 | 进程锁（TUI 只读） |
| `packages/coding-agent/src/core/computer-use-mcp.ts` | 新建 | MCP binary 生命周期管理 |
| `packages/coding-agent/src/cli.ts` | 修改 | `--remote-control` flag |
| `packages/coding-agent/src/main.ts` | 修改 | 远程模式集成 |
| `packages/coding-agent/src/config.ts` | 修改 | 配置项 + binary 路径解析 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 修改 | TUI 只读模式 |
| `packages/agentboster-adapter/src/auth.ts` | 修改 | Desktop RPC 模式配置路径 |

### 2.2 remote-control.ts — 核心管理器

```typescript
import { EventSource } from 'undici';

interface RemoteControlConfig {
  serverUrl: string;
  authHeaders: Record<string, string>;
  sessionId: string;
  onLockAcquired: () => void;
  onLockReleased: () => void;
  onToolRequest: (request: ToolRequestEvent) => Promise<ToolResult>;
  onSessionFollowed: (newSessionId: string) => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

interface ToolRequestEvent {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  runId: string;
  sessionId: string;
}

interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export class RemoteControlManager {
  private eventSource: EventSource | null = null;
  private sessionId: string;
  private config: RemoteControlConfig;
  private mcpManager: ComputerUseMcpManager | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private enabled = false;

  constructor(config: RemoteControlConfig) {
    this.config = config;
    this.sessionId = config.sessionId;
  }

  // ── 生命周期 ──

  async enable(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;

    // 1. 启动 computer-use MCP (如果有 display)
    this.mcpManager = new ComputerUseMcpManager();
    const mcpStarted = await this.mcpManager.tryStart();

    // 2. 收集可用工具目录
    const tools = this.collectAvailableTools(mcpStarted);

    // 3. 向 Web 注册（POST 工具目录 + 能力信息）
    await this.register(this.sessionId, tools);

    // 4. 建立持久 SSE 连接
    await this.connect(this.sessionId);
  }

  async disable(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;

    this.eventSource?.close();
    this.eventSource = null;

    await this.mcpManager?.stop();
    this.mcpManager = null;

    await this.notifyRelease(this.sessionId);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── 持久 SSE 连接 ──

  private async connect(sessionId: string): Promise<void> {
    const url = `${this.config.serverUrl}/api/cli/session-events/${sessionId}`;

    this.eventSource = new EventSource(url, {
      // undici EventSource 支持自定义 headers
      headers: this.config.authHeaders,
    } as any);

    this.eventSource.addEventListener('tool-request', (event: MessageEvent) => {
      const request: ToolRequestEvent = JSON.parse(event.data);
      this.handleToolRequest(request);
    });

    this.eventSource.addEventListener('lock-acquired', () => {
      this.config.onLockAcquired();
    });

    this.eventSource.addEventListener('lock-released', () => {
      this.config.onLockReleased();
    });

    this.eventSource.addEventListener('session-followed', (event: MessageEvent) => {
      const { newSessionId } = JSON.parse(event.data);
      this.sessionId = newSessionId;
      this.config.onSessionFollowed(newSessionId);
    });

    this.eventSource.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.config.onReconnect();
    });

    this.eventSource.addEventListener('error', () => {
      this.config.onDisconnect();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.enabled) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.sessionId);
    }, delay);
  }

  // ── Tool 请求处理 ──

  private async handleToolRequest(request: ToolRequestEvent): Promise<void> {
    let result: ToolResult;

    try {
      if (request.toolName.startsWith('local_')) {
        // local_* 工具：复用现有 handleLocalToolRequest 逻辑
        result = await this.config.onToolRequest(request);
      } else {
        // MCP 工具（computer-use）：转发给 MCP server
        result = await this.mcpManager!.callTool(
          request.toolName,
          request.toolInput
        );
      }
    } catch (err) {
      result = { ok: false, error: String(err) };
    }

    // POST 结果回 Web
    await fetch(
      `${this.config.serverUrl}/api/ai/${request.runId}/tool-result`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.authHeaders,
        },
        body: JSON.stringify({
          toolCallId: request.toolCallId,
          result,
        }),
      }
    );
  }

  // ── 会话切换 ──

  async switchSession(newSessionId: string): Promise<void> {
    const oldSessionId = this.sessionId;

    // 通知 Web 旧会话释放远程控制
    await this.notifyRelease(oldSessionId);

    // 断开旧 SSE
    this.eventSource?.close();
    this.reconnectAttempt = 0;

    // 更新 session ID
    this.sessionId = newSessionId;

    // 重新注册 + 连接新会话
    const tools = this.collectAvailableTools(!!this.mcpManager?.isRunning());
    await this.register(newSessionId, tools);
    await this.connect(newSessionId);
  }

  // ── 注册 / 释放 ──

  private async register(
    sessionId: string,
    tools: string[]
  ): Promise<void> {
    await fetch(
      `${this.config.serverUrl}/api/cli/session-events/${sessionId}/register`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.authHeaders,
        },
        body: JSON.stringify({
          tools,
          capabilities: {
            hasDisplay: this.mcpManager?.isRunning() ?? false,
            platform: process.platform,
            isAdmin: isAdminUser(),
            scaleFactor: this.mcpManager?.getScaleFactor() ?? 1,
          },
        }),
      }
    );
  }

  private async notifyRelease(sessionId: string | null): Promise<void> {
    if (!sessionId) return;
    await fetch(
      `${this.config.serverUrl}/api/cli/session-events/${sessionId}/release`,
      {
        method: 'POST',
        headers: this.config.authHeaders,
      }
    ).catch(() => {});  // best-effort
  }

  private collectAvailableTools(hasMcp: boolean): string[] {
    const tools = ['local_exec', 'local_read_file', 'local_write_file', 'local_grep'];
    if (hasMcp) {
      tools.push(
        'screenshot', 'mouse_move', 'mouse_click', 'mouse_drag',
        'key_event', 'type_text', 'get_accessibility_tree', 'get_focused_element'
      );
    }
    return tools;
  }
}
```

### 2.3 computer-use-mcp.ts — MCP binary 生命周期

```typescript
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

export class ComputerUseMcpManager {
  private process: ChildProcess | null = null;
  private running = false;
  private pendingCalls = new Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  private requestId = 0;
  private scaleFactor = 1;

  /** 尝试启动 MCP server，如果 binary 不存在或无 display 则返回 false */
  async tryStart(): Promise<boolean> {
    const binaryPath = resolveComputerUseMcpBinary();
    if (!binaryPath) return false;

    try {
      // CWD = 调用者当前目录
      this.process = spawn(binaryPath, [], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          COMPUTER_USE_SESSION_ID: this.sessionId,
          COMPUTER_USE_CONFIG_DIR: getConfigDir(),
        },
      });

      // 读取 stdout (JSON-RPC responses)
      const rl = createInterface({ input: this.process.stdout! });
      rl.on('line', (line) => this.handleResponse(line));

      // MCP initialize 握手
      const initResult = await this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agentboster-cli', version: '1.0.0' },
      });

      // 读取能力信息
      if (initResult?.capabilities?.computerUse) {
        this.scaleFactor = initResult.capabilities.computerUse.scaleFactor || 1;
      }

      this.running = true;
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.process?.kill();
    this.process = null;
  }

  isRunning(): boolean { return this.running; }
  getScaleFactor(): number { return this.scaleFactor; }

  /** 调用 MCP 工具 */
  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: input,
    });
    return { ok: true, output: result.content };
  }

  private async sendRequest(method: string, params: unknown): Promise<any> {
    const id = String(++this.requestId);
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.process!.stdin!.write(request + '\n');

    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pendingCalls.has(id)) {
          this.pendingCalls.delete(id);
          reject(new Error(`MCP call ${method} timed out`));
        }
      }, 30000);
    });
  }

  private handleResponse(line: string): void {
    const msg = JSON.parse(line);
    const pending = this.pendingCalls.get(msg.id);
    if (pending) {
      this.pendingCalls.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }
}

/** 严格同级查找（防止路径投毒），详见「补充：调用路径」章节 */
function resolveComputerUseMcpBinary(): string | null {
  return resolveSiblingBinary('computer-use-mcp');
  // 开发环境 fallback 见 tryStart() 中的 DEV_COMPUTER_USE_MCP 逻辑
}
```

### 2.4 remote-control-lock.ts — 进程锁（TUI 只读）

```typescript
export class RemoteControlLock {
  private locked = false;
  private onChangeCallbacks: Array<(locked: boolean) => void> = [];

  acquire(): void {
    if (this.locked) return;
    this.locked = true;
    this.onChangeCallbacks.forEach(cb => cb(true));
  }

  release(): void {
    if (!this.locked) return;
    this.locked = false;
    this.onChangeCallbacks.forEach(cb => cb(false));
  }

  isLocked(): boolean {
    return this.locked;
  }

  onChange(callback: (locked: boolean) => void): void {
    this.onChangeCallbacks.push(callback);
  }
}
```

锁粒度：per-workflow-run。IM 触发 workflow → Web 推送 `lock-acquired` → workflow 完成 → `lock-released`。
两次 IM 消息之间，本地用户可以操作。

### 2.5 interactive-mode.ts — TUI 只读模式

```typescript
// 在 interactive mode 的输入处理中
function handleInput(input: string): void {
  if (remoteControlLock.isLocked()) {
    // 只读模式：只允许以下操作
    if (input === 'R' || input === 'r') {
      refreshMessages();
      return;
    }
    if (input.startsWith('/remote')) {
      handleRemoteCommand(input);
      return;
    }
    // 其余输入拦截
    displayStatus('[Remote Control Active] Session locked by IM. Press R to refresh.');
    return;
  }

  // 正常输入处理...
}

// 状态栏显示
function renderStatusBar(): string {
  if (remoteControlManager?.isEnabled()) {
    if (remoteControlLock.isLocked()) {
      return '🔒 Remote Control Active — IM is operating';
    }
    return '📡 Remote Control ON — waiting for IM commands';
  }
  return ''; // 正常状态
}
```

### 2.6 cli.ts — 启动参数

```typescript
// 在 CLI 参数解析中新增
const args = parseArgs({
  // 现有参数...
  '--remote-control': { type: 'boolean', default: false },
});

// 在 main() 中
if (args['--remote-control'] || config.remoteControl?.enabled) {
  await remoteControlManager.enable(sessionId);
}
```

### 2.7 运行时命令

```typescript
// 注册 /remote 命令
registerSlashCommand('remote', {
  description: 'Manage remote control mode',
  usage: '/remote [on|off|status]',
  handler: async (args: string) => {
    switch (args.trim()) {
      case 'on':
        await remoteControlManager.enable(currentSessionId);
        display('Remote control enabled. IM users can now /attach to this session.');
        break;
      case 'off':
        await remoteControlManager.disable();
        display('Remote control disabled.');
        break;
      case 'status':
        const status = remoteControlManager.isEnabled()
          ? `ON — session: ${currentSessionId}, ` +
            `computer-use: ${mcpManager?.isRunning() ? 'active' : 'unavailable'}, ` +
            `lock: ${remoteControlLock.isLocked() ? 'locked by IM' : 'free'}`
          : 'OFF';
        display(`Remote control: ${status}`);
        break;
      default:
        display('Usage: /remote [on|off|status]');
    }
  },
});
```

### 2.8 配置文件

```jsonc
// ~/.config/agentboster-cli/config.json (CLI 独立运行)
// 或 ~/.config/agentboster-desktop/config.json (Desktop 调用时)
{
  "url": "https://your-agentboster.vercel.app",
  "token": "...",
  "username": "...",
  "remoteControl": {
    "enabled": false,              // 是否自动启用
    "autoStartComputerUse": true   // 是否自动启动 computer-use MCP
  }
}
```

### 2.9 配置路径统一（Desktop 调用时）

```typescript
// config.ts
function getAgentbosterHome(): string {
  if (process.env.AGENTBOSTER_HOME) return process.env.AGENTBOSTER_HOME;

  // 检测是否被 Desktop 通过 RPC 模式调用
  const dirName = isDesktopRpcMode() ? 'agentboster-desktop' : 'agentboster-cli';

  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', dirName);
    case 'win32':
      return path.join(process.env.APPDATA || os.homedir(), dirName);
    default:
      return path.join(os.homedir(), '.config', dirName);
  }
}

function isDesktopRpcMode(): boolean {
  // Desktop spawn CLI 时设置此环境变量
  return process.env.AGENTBOSTER_DESKTOP_RPC === '1';
}
```

CLI 独立运行 → `agentboster-cli` 配置目录
Desktop 调用 → `agentboster-desktop` 配置目录
computer-use.lock 在对应的配置目录下，天然互斥

---

## 模块 3：Web 端 session-events + 在线追踪（3 天）

### 3.0 目标

Web 新增持久 SSE 端点，追踪 CLI 在线状态，推送 tool-request 到 CLI。

### 3.1 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `app/api/cli/session-events/[sessionId]/route.ts` | 新建 | 持久 SSE 端点 |
| `app/api/cli/session-events/[sessionId]/register/route.ts` | 新建 | 工具注册 |
| `app/api/cli/session-events/[sessionId]/release/route.ts` | 新建 | 远程释放 |
| `lib/cli/remote-control.ts` | 新建 | 在线追踪 + listener 管理 |
| `lib/workflow/agent/sender/writers.ts` | 修改 | tool-request 双路推送 |
| `lib/workflow/agent/tools/local/index.ts` | 修改 | 工具注册条件扩展 |

### 3.2 lib/cli/remote-control.ts — listener 管理

```typescript
import { kv } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('cli-remote-control');

// ── 进程内 listener 注册表 ──
// Key: sessionId, Value: SSE controller
// 注意：Vercel serverless 环境下进程内 Map 不跨实例共享，
// 因此 tool-request 推送需要 fallback 到 KV polling。
// 但在 self-hosted (长驻进程) 下这个 Map 有效。

interface CliListener {
  send: (event: string, data: unknown) => void;
  sessionId: string;
  connectedAt: number;
}

const listeners = new Map<string, CliListener>();

export function registerCliListener(
  sessionId: string,
  listener: CliListener
): void {
  // 如果已有旧连接，关闭它（CLI 重连场景）
  const old = listeners.get(sessionId);
  if (old) {
    logger.info('Replacing existing listener', { sessionId });
  }
  listeners.set(sessionId, listener);
}

export function unregisterCliListener(sessionId: string): void {
  listeners.delete(sessionId);
}

export function getCliListener(sessionId: string): CliListener | null {
  return listeners.get(sessionId) ?? null;
}

/** 向 CLI 推送事件（进程内直推 + KV fallback） */
export async function pushToCliSession(
  sessionId: string,
  event: string,
  data: unknown
): Promise<boolean> {
  const listener = listeners.get(sessionId);
  if (listener) {
    listener.send(event, data);
    return true;
  }

  // Vercel serverless fallback：写入 KV，CLI 通过 SSE 端点的 poll 读取
  // self-hosted 通常不会走到这里
  await kv.lpush(`cli-events:${sessionId}`, JSON.stringify({ event, data }));
  await kv.expire(`cli-events:${sessionId}`, 300);
  return false;
}

// ── KV 在线状态 ──

export interface CliRemoteState {
  online: boolean;
  tools: string[];
  capabilities: {
    hasDisplay: boolean;
    platform: string;
    isAdmin: boolean;
    scaleFactor: number;
  };
  connectedAt: number;
}

export async function markCliOnline(
  sessionId: string,
  state?: Partial<CliRemoteState>
): Promise<void> {
  const value: CliRemoteState = {
    online: true,
    tools: state?.tools ?? [],
    capabilities: state?.capabilities ?? {
      hasDisplay: false,
      platform: 'unknown',
      isAdmin: false,
      scaleFactor: 1,
    },
    connectedAt: Date.now(),
  };
  await kv.set(`cli-remote:${sessionId}`, JSON.stringify(value), { ex: 120 });
}

export async function markCliOffline(sessionId: string): Promise<void> {
  await kv.del(`cli-remote:${sessionId}`);
  logger.info('CLI marked offline', { sessionId });
}

export async function renewCliHeartbeat(sessionId: string): Promise<void> {
  await kv.expire(`cli-remote:${sessionId}`, 120);
}

export async function isCliOnlineForSession(
  sessionId: string
): Promise<boolean> {
  const raw = await kv.get(`cli-remote:${sessionId}`);
  if (!raw) return false;
  const state: CliRemoteState = JSON.parse(raw as string);
  return state.online;
}

export async function getCliCapabilities(
  sessionId: string
): Promise<CliRemoteState | null> {
  const raw = await kv.get(`cli-remote:${sessionId}`);
  if (!raw) return null;
  return JSON.parse(raw as string);
}
```

### 3.3 持久 SSE 端点

```typescript
// app/api/cli/session-events/[sessionId]/route.ts
import { NextRequest } from 'next/server';
import {
  registerCliListener,
  unregisterCliListener,
  markCliOnline,
  markCliOffline,
  renewCliHeartbeat,
} from '@/lib/cli/remote-control';
import { requireCliAuth } from '@/lib/auth/cli-auth';
import { getSession } from '@/lib/core/db/chat';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const user = await requireCliAuth(req);

  // 验证会话存在且属于当前用户
  const session = await getSession(sessionId, user.id);
  if (!session) {
    return new Response('Session not found', { status: 404 });
  }

  // 验证是 CLI 会话
  if (!session.channel?.startsWith('cli:')) {
    return new Response('Not a CLI session', { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller closed
        }
      };

      // 注册 listener
      registerCliListener(sessionId, {
        send,
        sessionId,
        connectedAt: Date.now(),
      });
      markCliOnline(sessionId);

      // 心跳 keepalive 30s
      const heartbeat = setInterval(() => {
        send('ping', { ts: Date.now() });
        renewCliHeartbeat(sessionId);
      }, 30_000);

      // Vercel serverless fallback: 定期检查 KV 队列
      const pollKv = setInterval(async () => {
        const events = await drainKvEvents(sessionId);
        for (const { event, data } of events) {
          send(event, data);
        }
      }, 2_000);

      // 断开处理
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        clearInterval(pollKv);
        unregisterCliListener(sessionId);
        markCliOffline(sessionId);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function drainKvEvents(
  sessionId: string
): Promise<Array<{ event: string; data: unknown }>> {
  const results: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const raw = await kv.rpop(`cli-events:${sessionId}`);
    if (!raw) break;
    results.push(JSON.parse(raw as string));
  }
  return results;
}
```

### 3.4 工具注册端点

```typescript
// app/api/cli/session-events/[sessionId]/register/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCliAuth } from '@/lib/auth/cli-auth';
import { markCliOnline } from '@/lib/cli/remote-control';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  await requireCliAuth(req);

  const body = await req.json();
  // body: { tools: string[], capabilities: {...} }

  await markCliOnline(sessionId, {
    tools: body.tools,
    capabilities: body.capabilities,
  });

  return NextResponse.json({ success: true });
}
```

### 3.5 释放端点

```typescript
// app/api/cli/session-events/[sessionId]/release/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireCliAuth } from '@/lib/auth/cli-auth';
import { markCliOffline, pushToCliSession } from '@/lib/cli/remote-control';
import { kv } from '@/lib/core/kv';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  await requireCliAuth(req);

  // 通知绑定的 IM 线程
  const binding = await kv.get(`cli-im-binding:${sessionId}`);
  if (binding) {
    const { adapter, threadId } = JSON.parse(binding as string);
    await notifyImThread(adapter, threadId,
      `CLI disconnected from session. Session is now frozen (read-only).`
    );
    // 清理绑定
    await kv.del(`im-attach:${adapter}:${threadId}`);
    await kv.del(`cli-im-binding:${sessionId}`);
  }

  await markCliOffline(sessionId);

  return NextResponse.json({ success: true });
}
```

### 3.6 修改 writeLocalToolRequest — 双路推送

```typescript
// lib/workflow/agent/sender/writers.ts
// 现有函数修改

import { pushToCliSession } from '@/lib/cli/remote-control';

export async function writeLocalToolRequest(payload: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  sessionId?: string;
  runId?: string;
}): Promise<void> {
  // 现有逻辑：写入 workflow stream（CLI 直接发起的 workflow）
  writeWorkflowChunk({
    type: 'local-tool-request',
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
  });

  // 新增：同时推送到 session-events SSE listener（IM 触发的 workflow）
  if (payload.sessionId) {
    await pushToCliSession(payload.sessionId, 'tool-request', {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      runId: payload.runId,
      sessionId: payload.sessionId,
    });
  }
}
```

### 3.7 修改 local/index.ts — 工具注册条件扩展

```typescript
// lib/workflow/agent/tools/local/index.ts
// 现有 factory 修改

import { isCliOnlineForSession, getCliCapabilities } from '@/lib/cli/remote-control';

export default defineBuildInTool({
  id: 'local-cli',
  description: `File and shell tools executed on the user's local machine...`,
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source, sessionId }) => {
    // 原有逻辑：CLI 发起的会话直接注册
    if (source?.type === 'cli') {
      return buildLocalTools();
    }

    // 新增：非 CLI 会话，但有在线 CLI 绑定（远程遥控模式）
    if (sessionId && await isCliOnlineForSession(sessionId)) {
      return buildLocalTools();
    }

    // 无 CLI 可用
    return null;
  },
});
```

同理，computer-use MCP 工具也需要类似的条件注册：

```typescript
// 新建 lib/workflow/agent/tools/execute/computer-use.ts

import { getCliCapabilities } from '@/lib/cli/remote-control';

export default defineBuildInTool({
  id: 'computer-use-remote',
  description: 'Computer use tools (screenshot, mouse, keyboard, accessibility) on the user\'s local machine via CLI remote control.',
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source, sessionId }) => {
    // 只在远程遥控模式下注册，且 CLI 有 display 能力
    if (!sessionId) return null;

    const caps = await getCliCapabilities(sessionId);
    if (!caps?.online || !caps.capabilities.hasDisplay) return null;

    // 只对 CLI 会话或已绑定 IM 会话注册
    if (source?.type !== 'cli' && !caps.online) return null;

    return {
      screenshot: tool({ /* ... */ }),
      mouse_move: tool({ /* ... */ }),
      mouse_click: tool({ /* ... */ }),
      mouse_drag: tool({ /* ... */ }),
      key_event: tool({ /* ... */ }),
      type_text: tool({ /* ... */ }),
      get_accessibility_tree: tool({ /* ... */ }),
      get_focused_element: tool({ /* ... */ }),
    };
  },
});
```

这些工具的 `execute` 回调与 `local_*` 工具相同：
通过 `writeLocalToolRequest()` 推送到 CLI → CLI 转发给 MCP server → 返回结果。

### 3.8 workflow 进程锁推送

当 IM 触发的 workflow 开始/结束时，推送锁事件到 CLI：

```typescript
// 在 workflow dispatch 中（routeToCliSession 相关逻辑）

// workflow 开始前
await pushToCliSession(sessionId, 'lock-acquired', {
  runId,
  source: 'im',
  lockedAt: Date.now(),
});
await kv.set(`cli-lock:${sessionId}`, JSON.stringify({ runId, lockedAt: Date.now() }), { ex: 600 });

// workflow 完成后
await pushToCliSession(sessionId, 'lock-released', { runId });
await kv.del(`cli-lock:${sessionId}`);
```

---

## 模块 4：IM → CLI 会话路由（3 天）

### 4.0 目标

IM 支持 `/attach` 绑定到 CLI 会话，消息路由进 CLI 会话的 workflow，
会话切换时 IM 绑定自动跟随，CLI 离线时会话冻结。

### 4.1 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/chat/commands.ts` | 修改 | 新增 `/attach`、`/detach`、`/remote` 命令 |
| `lib/chat/index.ts` | 修改 | `chatMain()` 路由逻辑 |
| `lib/chat/remote-route.ts` | 新建 | IM → CLI 会话路由核心 |
| `lib/bot/index.ts` | 修改 | 注册新命令 |

### 4.2 IM 命令

#### /attach

```typescript
// lib/chat/commands.ts

async function handleAttach(
  args: string,
  payload: AdapterMessagePayload
): Promise<CommandResult> {
  const sessionId = args.trim();
  if (!sessionId) {
    return { text: 'Usage: /attach <sessionId>' };
  }

  // 1. 验证 session 存在且属于当前用户
  const session = await getSession(sessionId, payload.userId);
  if (!session) {
    return { text: `Session "${sessionId}" not found or access denied.` };
  }

  // 2. 验证是 CLI 会话
  if (!session.channel?.startsWith('cli:')) {
    return { text: 'Only CLI sessions can be attached. This is a ' +
                   `${session.channel} session.` };
  }

  // 3. 验证 CLI 在线
  const online = await isCliOnlineForSession(sessionId);
  if (!online) {
    return { text: 'CLI is offline for this session. Cannot attach.' };
  }

  // 4. 检查是否已经 attach 了其他会话
  const existingAttach = await kv.get(
    `im-attach:${payload.adapter}:${payload.threadId}`
  );
  if (existingAttach) {
    // 先解绑旧的
    await detachImThread(payload.adapter, payload.threadId);
  }

  // 5. 绑定
  await kv.set(
    `im-attach:${payload.adapter}:${payload.threadId}`,
    sessionId
  );
  await kv.set(
    `cli-im-binding:${sessionId}`,
    JSON.stringify({
      adapter: payload.adapter,
      threadId: payload.threadId,
    })
  );

  return {
    text: `Attached to CLI session \`${sessionId}\`.\n` +
          `Messages in this thread will be routed to the CLI.\n` +
          `CLI can now execute tools on the remote machine.\n` +
          `Use /detach to disconnect.`,
  };
}
```

#### /detach

```typescript
async function handleDetach(
  _args: string,
  payload: AdapterMessagePayload
): Promise<CommandResult> {
  const sessionId = await kv.get(
    `im-attach:${payload.adapter}:${payload.threadId}`
  );
  if (!sessionId) {
    return { text: 'This thread is not attached to any CLI session.' };
  }

  await detachImThread(payload.adapter, payload.threadId);

  return { text: `Detached from CLI session \`${sessionId}\`.` };
}

async function detachImThread(
  adapter: string,
  threadId: string
): Promise<void> {
  const sessionId = await kv.get(`im-attach:${adapter}:${threadId}`);
  if (sessionId) {
    await kv.del(`im-attach:${adapter}:${threadId}`);
    await kv.del(`cli-im-binding:${sessionId}`);
  }
}
```

#### /remote (IM 侧状态查看)

```typescript
async function handleRemote(
  _args: string,
  payload: AdapterMessagePayload
): Promise<CommandResult> {
  // 检查当前线程是否 attach
  const attachedSessionId = await kv.get(
    `im-attach:${payload.adapter}:${payload.threadId}`
  );

  if (!attachedSessionId) {
    return { text: 'Not attached to any CLI session. Use /attach <sessionId>.' };
  }

  const caps = await getCliCapabilities(attachedSessionId as string);
  if (!caps) {
    return {
      text: `Attached to session \`${attachedSessionId}\` but CLI is OFFLINE.\n` +
            `Session is frozen (read-only).`,
    };
  }

  const toolList = caps.tools.join(', ');
  return {
    text: `Attached to session \`${attachedSessionId}\`\n` +
          `CLI status: ONLINE\n` +
          `Platform: ${caps.capabilities.platform}\n` +
          `Display: ${caps.capabilities.hasDisplay ? 'yes' : 'no'}\n` +
          `Admin: ${caps.capabilities.isAdmin ? 'yes' : 'no'}\n` +
          `Available tools: ${toolList}`,
  };
}
```

### 4.3 chatMain() 路由修改

```typescript
// lib/chat/index.ts - chatMain()

export async function chatMain(payload: ChatMainPayload) {
  // ── 新增：检查 IM 线程是否 attach 到了 CLI 会话 ──
  if (payload.source?.type !== 'cli') {
    const attachedSessionId = await kv.get(
      `im-attach:${payload.adapter}:${payload.threadId}`
    );

    if (attachedSessionId) {
      // 验证 CLI 在线
      const online = await isCliOnlineForSession(attachedSessionId as string);
      if (!online) {
        await replyToIm(
          payload,
          'CLI is offline. Session is frozen (read-only). ' +
          'Use /detach to disconnect.'
        );
        return;
      }

      // 路由到 CLI 会话
      return await routeToCliSession(attachedSessionId as string, payload);
    }
  }

  // ── 现有逻辑：正常 IM 会话创建/继续 ──
  // ...
}
```

### 4.4 remote-route.ts — IM → CLI 会话路由核心

```typescript
// lib/chat/remote-route.ts

import { pushToCliSession, isCliOnlineForSession } from '@/lib/cli/remote-control';
import { startWorkflow } from '@/lib/workflow/agent/dispatch';
import { triggerImStreamConsumer } from '@/lib/bot/im-stream';
import { kv } from '@/lib/core/kv';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('remote-route');

export async function routeToCliSession(
  sessionId: string,
  payload: ChatMainPayload
): Promise<void> {
  logger.info('Routing IM message to CLI session', {
    sessionId,
    adapter: payload.adapter,
    threadId: payload.threadId,
  });

  // 1. 验证 CLI 仍然在线（双重检查）
  if (!await isCliOnlineForSession(sessionId)) {
    await replyToIm(payload, 'CLI went offline. Session frozen.');
    return;
  }

  // 2. 获取进程锁
  const runId = generateRunId();
  await kv.set(
    `cli-lock:${sessionId}`,
    JSON.stringify({ runId, lockedAt: Date.now(), source: 'im' }),
    { ex: 600 }
  );

  // 3. 通知 CLI 进入只读模式
  await pushToCliSession(sessionId, 'lock-acquired', {
    runId,
    source: 'im',
    message: payload.text,
  });

  try {
    // 4. 在 CLI 会话上启动 workflow
    //    关键：sessionId 是 CLI 的会话，但 trigger 是 IM 消息
    //    source 标记为 { type: 'cli', remoteIm: true } 以确保 local_* 工具注册
    const result = await startWorkflow({
      sessionId,
      userId: payload.userId,
      input: payload.text,
      trigger: 'remote-im',
      source: { type: 'cli', remoteIm: true },
      images: payload.images,
    });

    // 5. IM 流式消费（回复到 IM）
    if (result.stream) {
      await triggerImStreamConsumer({
        runId: result.runId,
        adapter: payload.adapter,
        threadId: payload.threadId,
        sessionId,
      });
    }
  } catch (err) {
    logger.error('Remote route workflow failed', { sessionId, error: String(err) });
    await replyToIm(payload, `Remote execution failed: ${String(err)}`);
  } finally {
    // 6. 释放进程锁
    await pushToCliSession(sessionId, 'lock-released', { runId });
    await kv.del(`cli-lock:${sessionId}`);
  }
}
```

### 4.5 会话切换时自动更新 IM 绑定

当 Web 收到 CLI 的 session-switch 通知（通过 release 端点 + 新会话注册）：

```typescript
// lib/cli/remote-control.ts 新增

export async function handleCliSessionSwitch(
  oldSessionId: string,
  newSessionId: string
): Promise<void> {
  // 查找旧会话的 IM 绑定
  const bindingRaw = await kv.get(`cli-im-binding:${oldSessionId}`);
  if (!bindingRaw) return;

  const binding: { adapter: string; threadId: string } = JSON.parse(bindingRaw as string);

  // 解绑旧会话
  await kv.del(`im-attach:${binding.adapter}:${binding.threadId}`);
  await kv.del(`cli-im-binding:${oldSessionId}`);

  // 绑定新会话
  await kv.set(`im-attach:${binding.adapter}:${binding.threadId}`, newSessionId);
  await kv.set(`cli-im-binding:${newSessionId}`, JSON.stringify(binding));

  // 通知 IM 用户
  await notifyImThread(
    binding.adapter,
    binding.threadId,
    `CLI switched sessions. Now following session \`${newSessionId}\`. ` +
    `Previous session is now read-only.`
  );

  // 通知 CLI（通过新会话的 session-events）
  await pushToCliSession(newSessionId, 'session-followed', {
    oldSessionId,
    newSessionId,
  });
}
```

此函数在 CLI 释放旧会话 + 注册新会话时调用：

```typescript
// app/api/cli/session-events/[sessionId]/register/route.ts 修改

export async function POST(req, { params }) {
  const { sessionId } = await params;
  const user = await requireCliAuth(req);
  const body = await req.json();

  // 检查用户是否有其他会话绑定了 IM
  // 如果有，说明 CLI 切换了会话，需要迁移绑定
  const userSessions = await listUserCliSessions(user.id);
  for (const s of userSessions) {
    if (s.id !== sessionId) {
      const binding = await kv.get(`cli-im-binding:${s.id}`);
      if (binding) {
        await handleCliSessionSwitch(s.id, sessionId);
        break;
      }
    }
  }

  await markCliOnline(sessionId, {
    tools: body.tools,
    capabilities: body.capabilities,
  });

  return NextResponse.json({ success: true });
}
```

### 4.6 修改 /sessions 命令（IM 侧）

```typescript
// 现有 /sessions 命令修改

async function handleSessions(payload: AdapterMessagePayload): Promise<CommandResult> {
  const sessions = await listUserSessions(payload.userId);

  const lines = await Promise.all(sessions.map(async (s) => {
    const isCliSession = s.channel?.startsWith('cli:');
    let remoteStatus = '';

    if (isCliSession) {
      const online = await isCliOnlineForSession(s.id);
      const caps = online ? await getCliCapabilities(s.id) : null;
      if (online) {
        remoteStatus = caps?.capabilities.hasDisplay
          ? ' | 🟢 Remote Control (with display)'
          : ' | 🟢 Remote Control';
      } else {
        remoteStatus = ' | ⚪ CLI offline';
      }
    }

    const title = s.title || 'Untitled';
    const channel = s.channel || 'unknown';
    return `\`${s.id.slice(0, 8)}\` ${title} [${channel}]${remoteStatus}`;
  }));

  return {
    text: `Sessions:\n${lines.join('\n')}\n\n` +
          `Use /attach <sessionId> to connect to a CLI session.`,
  };
}
```

---

## 模块 5：L2 安全适配（1 天）

### 5.0 目标

远程遥控的 tool call 走 agentd 现有 L2 IM 审批模式。
CLI 远程模式下 L2 不弹 TUI 确认框，改为 IM 推送审批按钮。

### 5.1 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `lib/workflow/agent/tools/local/security.ts` | 新建 | local tool 安全审查集成 |
| `lib/extra/channels/send-notification.ts` | 修改 | 支持 CLI 远程 L2 通知 |

### 5.2 安全审查流程

远程遥控时，tool call 的安全审查流程：

```
IM 用户消息 → workflow 产生 tool call
    ↓
L0 规则检查（CLI 侧 /api/cli/l0-rules 已有）
    ↓ 通过
L1 评分（CLI 侧 /api/cli/l1-score 已有）
    ↓ 高风险
L2 审批 → 推送到 IM → 用户点击 approve/reject 按钮
    ↓ 批准
tool 执行
```

### 5.3 L2 在远程遥控下的行为

```typescript
// lib/workflow/agent/tools/local/security.ts

import { sendNotification } from '@/lib/extra/channels/send-notification';
import { processL2Decision } from '@/lib/extra/agent/l2-decision';

export async function requestL2ApprovalForRemoteTool(params: {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  decisionId: string;
  riskReason: string;
  requiresAdmin: boolean;
}): Promise<'approved' | 'rejected' | 'timeout'> {
  const { sessionId, toolName, toolInput, decisionId, riskReason, requiresAdmin } = params;

  // 构造 L2 通知
  let message = `🔒 **L2 Authorization Required**\n` +
                `Tool: \`${toolName}\`\n` +
                `Risk: ${riskReason}`;

  if (requiresAdmin) {
    message += `\n⚠️ This operation requires administrator privileges. ` +
               `CLI will request elevation if approved.`;
  }

  if (typeof toolInput === 'object' && toolInput !== null) {
    const preview = JSON.stringify(toolInput, null, 2).slice(0, 500);
    message += `\n\`\`\`\n${preview}\n\`\`\``;
  }

  // 发送 IM 通知（复用 agentd 的 L2 通知管道）
  await sendNotification({
    type: 'l2_decision',
    sessionId,
    taskId: decisionId,
    decisionId,
    title: `Authorize: ${toolName}`,
    message,
    // IM 按钮：pass_once / reject_once / pass_until (30min) / reject_until (30min)
  });

  // 等待用户决策（KV 轮询，复用 agentd 的 L2 等待机制）
  return await waitForL2Decision(decisionId, {
    timeoutMs: 5 * 60 * 1000, // 5 分钟超时
    escalationMs: 3 * 60 * 1000, // 3 分钟后 escalation 到其他通道
  });
}
```

### 5.4 L2 风险级别映射

| 工具 | 默认 L1 级别 | L2 触发条件 |
|------|-------------|-------------|
| `local_read_file` | 低 | 不触发 |
| `local_grep` | 低 | 不触发 |
| `local_write_file` | 中 | 覆盖系统文件、写入敏感路径 |
| `local_exec` | 按命令内容 | 遵循 agentd L0 规则（rm -rf, sudo, dd 等） |
| `screenshot` | 低 | 不触发 |
| `mouse_move` | 低 | 不触发 |
| `mouse_click` | 低 | 不触发 |
| `type_text` | 低 | 不触发 |
| `key_event` | 中 | 危险组合键（Ctrl+Alt+Del 等） |
| `get_accessibility_tree` | 低 | 不触发 |

`local_exec` 的 L0 规则与 agentd 共享同一套规则集（`GET /api/cli/l0-rules`）。

### 5.5 按需提权

当 L2 审批通过且操作需要 admin 权限时：

```typescript
// 在 CLI 侧 tool 执行层

async function executeLocalExecWithElevation(
  command: string,
  requiresAdmin: boolean
): Promise<ToolResult> {
  if (!requiresAdmin) {
    return executeNormally(command);
  }

  // 按平台提权
  let elevatedCommand: string;
  switch (process.platform) {
    case 'darwin':
      // osascript 弹出密码框（用户可能不在电脑前，需要提前输入或配置 sudo NOPASSWD）
      elevatedCommand = `osascript -e 'do shell script "${escapeForAppleScript(command)}" with administrator privileges'`;
      break;
    case 'linux':
      // pkexec 或 sudo（需要 NOPASSWD 配置，否则会挂起）
      elevatedCommand = `sudo ${command}`;
      break;
    case 'win32':
      // PowerShell Start-Process -Verb RunAs
      elevatedCommand = `powershell -Command "Start-Process -Verb RunAs -Wait -FilePath cmd -ArgumentList '/c ${command}'"`;
      break;
    default:
      return { ok: false, error: 'Unsupported platform for elevation' };
  }

  return executeNormally(elevatedCommand);
}
```

注意：远程遥控时用户不在电脑前，macOS/Linux 的密码弹窗可能无法交互。
建议在远程遥控文档中说明：需要预先配置 `sudo NOPASSWD` 或使用 `polkit` 规则。

---

## 模块 6：权限检测 + 首次引导（1 天）

### 6.0 目标

MCP server 启动时检测权限状态，首次使用时提供引导提示。

### 6.1 涉及文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `subpackage/computer-use-mcp/core/src/capability.rs` | 新建 | 运行时能力检测 |

### 6.2 capability.rs

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct Capabilities {
    pub has_display: bool,
    pub platform: String,
    pub display_server: Option<String>,   // "quartz" / "x11" / "wayland" / null
    pub display_resolution: Option<(u32, u32)>,
    pub scale_factor: f64,
    pub accessibility_granted: bool,
    pub is_admin: bool,
    pub issues: Vec<String>,              // 需要用户处理的问题列表
}

pub fn detect_capabilities() -> Capabilities {
    let platform = std::env::consts::OS.to_string();

    let (has_display, display_server) = detect_display_server();
    let display_resolution = if has_display {
        detect_resolution().ok()
    } else {
        None
    };
    let scale_factor = display_resolution
        .map(|(w, _)| if w > 2000 { w as f64 / 1400.0 } else { 1.0 })
        .unwrap_or(1.0);

    let accessibility_granted = check_accessibility_permission();
    let is_admin = check_admin_status();

    let mut issues = Vec::new();

    if !has_display {
        issues.push("No display server detected. Computer use tools unavailable.".into());
    }

    if has_display && !accessibility_granted {
        match platform.as_str() {
            "macos" => issues.push(
                "Accessibility permission required. Grant in: \
                 System Preferences → Privacy & Security → Accessibility → \
                 Enable AgentBoster".into()
            ),
            "linux" if display_server.as_deref() == Some("wayland") => issues.push(
                "Wayland detected. Some input injection features may be limited. \
                 Consider using X11 or granting additional permissions.".into()
            ),
            _ => {}
        }
    }

    Capabilities {
        has_display,
        platform,
        display_server,
        display_resolution,
        scale_factor,
        accessibility_granted,
        is_admin,
        issues,
    }
}

fn detect_display_server() -> (bool, Option<String>) {
    #[cfg(target_os = "macos")]
    { (true, Some("quartz".into())) }  // macOS 始终有 display

    #[cfg(target_os = "windows")]
    { (true, Some("win32".into())) }  // Windows 始终有 display（除 Server Core）

    #[cfg(target_os = "linux")]
    {
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            (true, Some("wayland".into()))
        } else if std::env::var("DISPLAY").is_ok() {
            (true, Some("x11".into()))
        } else {
            (false, None)
        }
    }
}

fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        // AXIsProcessTrusted()
        unsafe {
            let trusted: bool = accessibility_sys::AXIsProcessTrusted();
            trusted
        }
    }

    #[cfg(not(target_os = "macos"))]
    { true }  // Linux/Windows 无需预授权
}

fn check_admin_status() -> bool {
    #[cfg(unix)]
    { unsafe { libc::geteuid() == 0 } }

    #[cfg(windows)]
    {
        // shell32::IsUserAnAdmin
        false // 默认非 admin，实际检测需要 winapi
    }
}
```

### 6.3 首次引导流程

CLI 首次启用远程遥控时，检测 MCP 能力并提示：

```typescript
// 在 RemoteControlManager.enable() 中

const mcpStarted = await this.mcpManager.tryStart();
if (mcpStarted) {
  const caps = this.mcpManager.getCapabilities();
  if (caps.issues.length > 0) {
    for (const issue of caps.issues) {
      display(`⚠️  ${issue}`);
    }
    display('Computer use tools may be limited until these issues are resolved.');
  }
} else {
  display('ℹ️  computer-use-mcp binary not found. Computer use tools unavailable.');
  display('   Only local_* tools (file/shell) will be available for remote control.');
}
```

macOS 权限授予步骤（用户必须在本地操作，无法远程完成）：
1. CLI 提示需要 Accessibility 权限
2. 用户打开 System Preferences → Privacy & Security → Accessibility
3. 添加 `computer-use-mcp` binary（或 AgentBoster Desktop.app）
4. 重新启动远程遥控模式

---

## 数据存储汇总

### KV 键值对

| Key 模式 | 值类型 | TTL | 说明 |
|----------|--------|-----|------|
| `cli-remote:<sessionId>` | `CliRemoteState` JSON | 120s（心跳续期） | CLI 在线状态 + 工具目录 + 能力 |
| `im-attach:<adapter>:<threadId>` | `sessionId` string | 无（手动删除） | IM 线程 → CLI 会话绑定 |
| `cli-im-binding:<sessionId>` | `{ adapter, threadId }` JSON | 无（手动删除） | CLI 会话 → IM 线程反向索引 |
| `cli-lock:<sessionId>` | `{ runId, lockedAt }` JSON | 600s（安全过期） | 远程 workflow 进程锁 |
| `cli-events:<sessionId>` | List of event JSON | 300s | Vercel serverless KV fallback 事件队列 |

### 锁文件

| 路径 | 说明 |
|------|------|
| `~/.config/agentboster-desktop/computer-use.lock` | Desktop 调用时的 computer-use 机器锁 |
| `~/.config/agentboster-cli/computer-use.lock` | CLI 独立运行时的 computer-use 机器锁 |

两个路径互斥检查：MCP 启动时检查两个位置，确保 CLI 独立运行和 Desktop 调用不会同时操控电脑。

### 新 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/cli/session-events/[sessionId]` | GET | 持久 SSE，推送 tool-request/lock/session-follow 事件 |
| `/api/cli/session-events/[sessionId]/register` | POST | CLI 注册工具目录 + 能力 |
| `/api/cli/session-events/[sessionId]/release` | POST | CLI 释放远程控制 |

无数据库 schema 变更。全部用 KV + 进程内 Map 实现。

---

## 工作顺序和依赖关系

```
模块 1 (computer-use MCP, 4天)  ─────────────┐
                                               ├──► 模块 2 (CLI 远程模式, 4天) ──┐
模块 3 (Web session-events, 3天) ─────────────┤                                  │
                                               │                                  ├──► 集成测试 (2天)
模块 4 (IM 路由, 3天) ────────────────────────┤                                  │
                                               │                                  │
模块 5 (L2 安全, 1天) ────────────────────────┘                                  │
                                                                                   │
模块 6 (权限检测, 1天) ───── 依赖模块 1 ────────────────────────────────────────────┘
```

可并行：模块 1 + 模块 3 + 模块 4 + 模块 5（共 4 条并行线）
串行瓶颈：模块 2 依赖模块 1 和模块 3

### MVP 路线（先跑通 local_* 远程遥控，不含 computer-use）

1. 模块 3 (Web session-events) — 3 天
2. 模块 4 (IM 路由) — 3 天
3. 模块 2 (CLI 远程模式，不启动 MCP) — 3 天
4. 模块 5 (L2 安全) — 1 天

MVP 总计 ~10 天，可跑通：IM /attach → 消息路由到 CLI 会话 → local_exec/read/write/grep 远程执行 → IM 回复结果。

### 完整版（含 computer-use）

在 MVP 基础上追加：
5. 模块 1 (computer-use MCP) — 4 天
6. 模块 6 (权限检测) — 1 天
7. 模块 2 补完（MCP 集成） — 1 天

完整版总计 ~16 天。

---

## 补充：涉及 workflow 目录的文件修改（workflow 调度引擎本身不改）

**明确：`startWorkflow()` / `runWorkflow()` / `dispatch.ts` 核心不需要修改。**
只要 `routeToCliSession()` 传入 `source.type = 'cli'`，现有的工具注册、
步骤编排、compaction、subagent 全部照常工作。

以下改动在 `lib/workflow/agent/` 目录下，但属于工具注册层和 sender 层，不是调度引擎：

### W1. source 类型扩展

当前 `source` 类型只有 `'cli'` | `'web'` | `'im'` | `'scheduled'`。
远程遥控需要区分「IM 触发但在 CLI 会话上运行」的场景。

```typescript
// lib/workflow/agent/types.ts (修改)

export interface WorkflowSource {
  type: 'cli' | 'web' | 'im' | 'scheduled';
  /** IM 通过 /attach 远程操控 CLI 会话时为 true */
  remoteIm?: boolean;
  /** 远程操控时的 IM 适配器信息 */
  remoteAdapter?: string;
  remoteThreadId?: string;
}
```

关键：当 `source.type === 'cli' && source.remoteIm === true` 时，
工具注册走 CLI 路径（`local_*` 可用），但 L2 审批走 IM 路径（不弹 TUI）。

### W2. system prompt 注入

当会话处于远程遥控模式时，system prompt 需要告知 LLM：
- 当前在远程操控用户的电脑
- 有哪些额外工具可用（computer-use 截图/鼠标/键盘/a11y）
- 用户不在电脑前，所有交互通过 IM
- 高风险操作需要 L2 审批（用户会在 IM 上收到确认按钮）

```typescript
// lib/workflow/agent/steps/build-prompt.ts (修改)

// 在 buildSystemPrompt() 中新增
async function buildRemoteControlSection(
  sessionId: string,
  source: WorkflowSource
): Promise<string | null> {
  if (!source.remoteIm) return null;

  const caps = await getCliCapabilities(sessionId);
  if (!caps) return null;

  const lines = [
    '## Remote Control Mode',
    '',
    'You are remotely controlling the user\'s computer via IM.',
    'The user is NOT sitting at the computer — they are interacting through a messaging app.',
    `Platform: ${caps.capabilities.platform}`,
    `Display: ${caps.capabilities.hasDisplay ? 'available' : 'unavailable'}`,
    '',
  ];

  if (caps.capabilities.hasDisplay) {
    lines.push(
      '### Computer Use Tools Available',
      '',
      'You have access to computer-use tools for GUI automation:',
      '- `screenshot` — capture the screen (auto-scaled, terminals excluded)',
      '- `mouse_move`, `mouse_click`, `mouse_drag` — mouse control (coordinates match screenshot scale)',
      '- `key_event`, `type_text` — keyboard input',
      '- `get_accessibility_tree`, `get_focused_element` — read UI structure',
      '',
      'Workflow for GUI tasks:',
      '1. Take a screenshot to see the current state',
      '2. Use accessibility tree to identify interactive elements',
      '3. Click/type to interact',
      '4. Screenshot again to verify the result',
      '',
      'All coordinates are in the screenshot\'s coordinate space (auto-scaled).',
      'Do NOT ask the user to look at the screen — they are remote. Always screenshot first.',
      '',
    );
  }

  lines.push(
    '### Security',
    '',
    'High-risk operations (file deletion, sudo, system changes) will trigger an L2 approval.',
    'The user will receive an approval button in their IM app.',
    'Wait for approval before proceeding — do not retry or skip.',
    '',
    'Operations requiring administrator privileges will be noted in the L2 prompt.',
    '',
  );

  return lines.join('\n');
}
```

在 `buildSystemPrompt()` 的 sections 组装中插入：

```typescript
// build-prompt.ts - buildSystemPrompt()

const sections: string[] = [
  // ... 现有 sections ...
];

// 新增：远程遥控模式提示
const remoteSection = await buildRemoteControlSection(sessionId, source);
if (remoteSection) {
  sections.push(remoteSection);
}
```

### W3. 工具注册修改

涉及三处 tool factory 修改：

#### W3a. local/index.ts — local_* 工具

已在模块 3.7 中描述。核心变化：

```typescript
// 原来：source?.type !== 'cli' → return null
// 现在：source?.type !== 'cli' 但 isCliOnlineForSession(sessionId) → 注册
factory: async (_config, { source, sessionId }) => {
  if (source?.type === 'cli') return buildLocalTools();
  if (sessionId && await isCliOnlineForSession(sessionId)) return buildLocalTools();
  return null;
},
```

#### W3b. 新建 computer-use 工具注册

```typescript
// lib/workflow/agent/tools/execute/computer-use.ts (新建)

import { tool } from 'ai';
import { z } from 'zod';
import { defineBuildInTool } from '../define';
import { getCliCapabilities, isCliOnlineForSession } from '@/lib/cli/remote-control';

export default defineBuildInTool({
  id: 'computer-use-remote',
  description: 'Computer use tools on the user\'s local machine via CLI remote control.',
  requiredConfig: [],
  optionalConfig: [],
  factory: async (_config, { source, sessionId }) => {
    if (!sessionId) return null;

    // 只在 CLI 在线且有 display 能力时注册
    const caps = await getCliCapabilities(sessionId);
    if (!caps?.online || !caps.capabilities.hasDisplay) return null;

    // CLI 直连会话 或 远程 IM 会话
    if (source?.type !== 'cli' && !source?.remoteIm) return null;

    return {
      screenshot: tool({
        title: 'Screenshot',
        description: 'Capture the screen. Returns a scaled PNG image. Terminal windows are excluded.',
        parameters: z.object({
          max_width: z.number().optional().describe('Max width in pixels (default: 1400)'),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'screenshot', input, toolCallId);
        },
      }),

      mouse_move: tool({
        title: 'Move mouse',
        description: 'Move the mouse cursor to coordinates (in screenshot scale).',
        parameters: z.object({
          x: z.number().describe('X coordinate (screenshot scale)'),
          y: z.number().describe('Y coordinate (screenshot scale)'),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'mouse_move', input, toolCallId);
        },
      }),

      mouse_click: tool({
        title: 'Click',
        description: 'Click at coordinates. Coordinates are in screenshot scale.',
        parameters: z.object({
          x: z.number(),
          y: z.number(),
          button: z.enum(['left', 'right', 'middle']).optional().default('left'),
          click_type: z.enum(['single', 'double']).optional().default('single'),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'mouse_click', input, toolCallId);
        },
      }),

      mouse_drag: tool({
        title: 'Drag',
        description: 'Drag from one point to another.',
        parameters: z.object({
          from_x: z.number(), from_y: z.number(),
          to_x: z.number(), to_y: z.number(),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'mouse_drag', input, toolCallId);
        },
      }),

      key_event: tool({
        title: 'Key press',
        description: 'Press a key or key combination (e.g. "ctrl+s", "enter", "tab").',
        parameters: z.object({
          key: z.string().describe('Key name (e.g. "enter", "tab", "a", "F5")'),
          modifiers: z.array(z.string()).optional().describe('Modifier keys: "ctrl", "alt", "shift", "meta"'),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'key_event', input, toolCallId);
        },
      }),

      type_text: tool({
        title: 'Type text',
        description: 'Type a string of text as keyboard input.',
        parameters: z.object({
          text: z.string(),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'type_text', input, toolCallId);
        },
      }),

      get_accessibility_tree: tool({
        title: 'Accessibility tree',
        description: 'Get the UI accessibility tree. Useful for finding interactive elements by role/name.',
        parameters: z.object({
          app_name: z.string().optional().describe('Filter to a specific application'),
          max_depth: z.number().optional().describe('Max tree depth (default: unlimited)'),
        }),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'get_accessibility_tree', input, toolCallId);
        },
      }),

      get_focused_element: tool({
        title: 'Focused element',
        description: 'Get the currently focused UI element.',
        parameters: z.object({}),
        execute: async (input, { toolCallId }) => {
          return await dispatchToCliMcp(sessionId, 'get_focused_element', input, toolCallId);
        },
      }),
    };
  },
});

/**
 * 分发 computer-use 工具调用到 CLI。
 * 复用 local tool 的 writeLocalToolRequest + wait 机制。
 */
async function dispatchToCliMcp(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolCallId: string,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  // 与 local_* 工具相同的分发路径：
  // writeLocalToolRequest → push to session-events SSE → CLI 收到 →
  // CLI 转发给 MCP server → 结果 POST 回 /api/ai/[runId]/tool-result
  await writeLocalToolRequest({
    toolCallId,
    toolName,
    toolInput,
    sessionId,
  });

  using hook = localToolResultHookBuilder.create({ token: toolCallId });
  let result = { ok: false, error: 'Timeout waiting for CLI' };
  for await (const payload of hook) {
    result = payload;
    break;
  }

  if (!result.ok) {
    return { content: [{ type: 'text', text: `computer-use error: ${result.error}` }] };
  }

  // screenshot 返回 image content
  if (toolName === 'screenshot' && typeof result.output === 'object') {
    const output = result.output as any;
    if (output.content?.[0]?.type === 'image') {
      return { content: output.content };
    }
  }

  const text = typeof result.output === 'string'
    ? result.output
    : JSON.stringify(result.output, null, 2);
  return { content: [{ type: 'text', text }] };
}
```

#### W3c. 工具注册入口

```typescript
// lib/workflow/agent/tools/index.ts (修改)
// 在工具注册列表中新增 computer-use-remote

import computerUseRemote from './execute/computer-use';

export const builtinTools = [
  // ... 现有工具 ...
  computerUseRemote,
];
```

### W4. startWorkflow 调用参数（不改 dispatch.ts）

`routeToCliSession()` 调用 `startWorkflow()` 时传入正确的 source：

```typescript
// lib/chat/remote-route.ts（已在模块 4.4 描述）

const result = await startWorkflow({
  sessionId,                          // CLI 的会话 ID
  userId: payload.userId,
  input: payload.text,
  images: payload.images,
  trigger: 'remote-im',              // 新增 trigger 类型
  source: {
    type: 'cli',                      // 关键：保持 'cli' 以确保 local_* 工具注册
    remoteIm: true,                   // 标记为远程 IM 触发
    remoteAdapter: payload.adapter,
    remoteThreadId: payload.threadId,
  },
});
```

**`dispatch.ts` 不需要修改。** `startWorkflow` 已经接受任意 source 和 trigger。
lock 推送（`lock-acquired` / `lock-released`）在 `routeToCliSession()` 的
try/finally 中完成（见模块 4.4），不在 workflow 调度层。

### W5. tool-request 分发逻辑

当前 `writeLocalToolRequest` 写入 workflow stream chunk。
远程遥控时，CLI 不在消费这个 workflow stream（IM stream consumer 在消费）。
需要同时推送到 session-events SSE。

已在模块 3.6 中描述，此处汇总完整修改：

```typescript
// lib/workflow/agent/sender/writers.ts

import { pushToCliSession } from '@/lib/cli/remote-control';

export async function writeLocalToolRequest(payload: {
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  sessionId?: string;
  runId?: string;
}): Promise<void> {
  // 路径 A：写入 workflow stream（CLI 直接发起的 workflow，CLI 在消费此 stream）
  writeWorkflowChunk({
    type: 'local-tool-request',
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    toolInput: payload.toolInput,
  });

  // 路径 B：推送到 session-events SSE（IM 触发的 workflow，CLI 通过 SSE 接收）
  // 两条路径同时执行，CLI 侧做幂等去重（按 toolCallId）
  if (payload.sessionId) {
    await pushToCliSession(payload.sessionId, 'tool-request', {
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      runId: payload.runId,
      sessionId: payload.sessionId,
    });
  }
}
```

CLI 侧收到 tool-request 后，按 `toolCallId` 去重（Set 记录已处理的 ID），
避免同一个 tool call 在 CLI 直连 + SSE 两条路径上重复执行。

```typescript
// CLI 侧 remote-control.ts

private processedToolCalls = new Set<string>();

private async handleToolRequest(request: ToolRequestEvent): Promise<void> {
  // 幂等去重
  if (this.processedToolCalls.has(request.toolCallId)) return;
  this.processedToolCalls.add(request.toolCallId);
  // 超过 1000 条时清理最旧的（LRU）
  if (this.processedToolCalls.size > 1000) {
    const first = this.processedToolCalls.values().next().value;
    this.processedToolCalls.delete(first);
  }

  // ... 执行工具 + POST 结果 ...
}
```

---

## 补充：Bundle / Package 移动 binary

CLI 和 Desktop 各有独立的构建流水线，都需要将 computer-use-mcp binary
复制到最终产物中，确保与调用者同级。

### 构建流水线对比

```
                CLI 流水线                          Desktop 流水线
                ──────────                          ──────────────
Step 1    cargo build (computer-use-mcp)      cargo build (computer-use-mcp)
             ↓                                    ↓
Step 2    yarn build (tsgo 编译 TS)            yarn build + yarn bundle (CLI bundle)
             ↓                                    ↓
Step 3    yarn bundle (esbuild → .cjs)        scripts/prepare-resources.sh
             ↓                                    ← 复制 CLI bundle + MCP binary 到 resources/
Step 4    yarn package (组装 tarball)              ↓
             ← 复制 MCP binary 到 bin/        cargo tauri build (组装安装包)
             ↓                                    ← Tauri 把 resources/ 打入 app bundle
          .tar.gz 产物                         .dmg / .msi / .AppImage 产物
```

---

### CLI 侧：yarn bundle + yarn package

#### bundle 阶段（不涉及 binary）

`yarn bundle` 使用 esbuild 将 CLI 打包为单文件 `dist/agentboster.cjs`。
binary 不参与 esbuild。`resolveSiblingBinary()` 使用 `dirname(process.argv[1])`
定位同级目录，在 bundle 后仍正确工作。

不需要修改 `scripts/bundle.mjs`。

#### package 阶段（复制 binary）

```javascript
// subpackage/cli/scripts/package.mjs (修改)

import { execSync } from 'node:child_process';
import { existsSync, copyFileSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const COMPUTER_USE_MCP_CRATE = resolve(__dirname, '..', '..', 'computer-use-mcp', 'server');

function getRustTarget() {
  const targets = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  return targets[`${process.platform}-${process.arch}`] ?? null;
}

function packageComputerUseMcp(binDir) {
  const binaryName = process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
  const rustTarget = getRustTarget();

  if (!rustTarget) {
    console.warn(`⚠️  No Rust target for ${process.platform}-${process.arch}, skipping computer-use-mcp`);
    return;
  }

  if (!existsSync(COMPUTER_USE_MCP_CRATE)) {
    console.warn(`⚠️  computer-use-mcp crate not found at ${COMPUTER_USE_MCP_CRATE}, skipping`);
    return;
  }

  // 优先使用预编译产物（CI 场景）
  const prebuiltPath = resolve(COMPUTER_USE_MCP_CRATE, 'target', rustTarget, 'release', binaryName);
  const defaultPrebuilt = resolve(COMPUTER_USE_MCP_CRATE, 'target', 'release', binaryName);

  let sourcePath = null;

  if (existsSync(prebuiltPath)) {
    sourcePath = prebuiltPath;
  } else if (existsSync(defaultPrebuilt)) {
    sourcePath = defaultPrebuilt;
  } else {
    // 本地构建
    try {
      console.log(`Building computer-use-mcp for ${rustTarget}...`);
      execSync(`cargo build --release --target ${rustTarget}`, {
        cwd: COMPUTER_USE_MCP_CRATE,
        stdio: 'inherit',
      });
      sourcePath = prebuiltPath;
    } catch (err) {
      console.warn(`⚠️  Failed to build computer-use-mcp: ${err.message}`);
      console.warn('    CLI will work without computer-use capabilities.');
      return;
    }
  }

  if (!sourcePath || !existsSync(sourcePath)) {
    console.warn('⚠️  computer-use-mcp binary not found after build, skipping');
    return;
  }

  // 复制到 bin/（与 agentboster-cli 同级）
  const destPath = join(binDir, binaryName);
  copyFileSync(sourcePath, destPath);
  if (process.platform !== 'win32') chmodSync(destPath, 0o755);
  console.log(`✓ Copied computer-use-mcp → ${destPath}`);
}

// ── 在现有打包流程中调用 ──

const binDir = join(distDir, 'bin');
mkdirSync(binDir, { recursive: true });

// CLI 入口
copyFileSync(
  resolve('packages/coding-agent/dist/agentboster.cjs'),
  join(binDir, process.platform === 'win32' ? 'agentboster-cli.exe' : 'agentboster-cli')
);
if (process.platform !== 'win32') chmodSync(join(binDir, 'agentboster-cli'), 0o755);

// computer-use-mcp（同级）
packageComputerUseMcp(binDir);

// ... 继续现有的 tarball 压缩逻辑 ...
```

CLI 最终 tarball 结构：

```
agentboster-cli-darwin-arm64.tar.gz
└── bin/
    ├── agentboster-cli          ← CLI 入口
    └── computer-use-mcp         ← 同级
```

---

### Desktop 侧：prepare-resources.sh + cargo tauri build

Desktop 的构建需要把 **两个** 外部 binary（CLI bundle + computer-use-mcp）
复制到 Tauri 的 `resources/` 目录，Tauri build 会将其打入安装包。

#### prepare-resources.sh（复制 binary）

```bash
#!/bin/bash
# subpackage/cli/packages/desktop/scripts/prepare-resources.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$SCRIPT_DIR/.."
RESOURCES_DIR="$DESKTOP_DIR/src-tauri/resources"
CLI_DIR="$DESKTOP_DIR/../../.."
REPO_ROOT="$CLI_DIR/../.."

mkdir -p "$RESOURCES_DIR"

BINARY_SUFFIX=""
if [ "$(uname)" = "MINGW"* ] || [ "$(uname)" = "MSYS"* ]; then
  BINARY_SUFFIX=".exe"
fi

# ── 1. CLI bundle ──
CLI_BUNDLE="$CLI_DIR/packages/coding-agent/dist/agentboster.cjs"
if [ ! -f "$CLI_BUNDLE" ]; then
  echo "CLI bundle not found. Building..."
  (cd "$CLI_DIR" && yarn build && yarn bundle)
fi

if [ -f "$CLI_BUNDLE" ]; then
  cp "$CLI_BUNDLE" "$RESOURCES_DIR/agentboster-cli${BINARY_SUFFIX}"
  chmod +x "$RESOURCES_DIR/agentboster-cli${BINARY_SUFFIX}" 2>/dev/null || true
  echo "✓ CLI bundle → $RESOURCES_DIR/agentboster-cli"
else
  echo "✗ CLI bundle not found at $CLI_BUNDLE"
  exit 1
fi

# ── 2. computer-use-mcp binary ──
MCP_CRATE="$REPO_ROOT/computer-use-mcp/server"
MCP_BINARY_NAME="computer-use-mcp${BINARY_SUFFIX}"

# 尝试多个可能的路径（cargo build --target vs 无 --target）
RUST_TARGET=$(rustc -vV 2>/dev/null | grep host | awk '{print $2}')
MCP_CANDIDATES=(
  "$MCP_CRATE/target/$RUST_TARGET/release/$MCP_BINARY_NAME"
  "$MCP_CRATE/target/release/$MCP_BINARY_NAME"
)

MCP_SOURCE=""
for candidate in "${MCP_CANDIDATES[@]}"; do
  if [ -f "$candidate" ]; then
    MCP_SOURCE="$candidate"
    break
  fi
done

if [ -z "$MCP_SOURCE" ]; then
  echo "computer-use-mcp binary not found. Building..."
  if [ -d "$MCP_CRATE" ]; then
    (cd "$MCP_CRATE" && cargo build --release)
    # 重新查找
    for candidate in "${MCP_CANDIDATES[@]}"; do
      if [ -f "$candidate" ]; then
        MCP_SOURCE="$candidate"
        break
      fi
    done
  fi
fi

if [ -n "$MCP_SOURCE" ]; then
  cp "$MCP_SOURCE" "$RESOURCES_DIR/$MCP_BINARY_NAME"
  chmod +x "$RESOURCES_DIR/$MCP_BINARY_NAME" 2>/dev/null || true
  echo "✓ computer-use-mcp → $RESOURCES_DIR/$MCP_BINARY_NAME"
else
  echo "⚠️  computer-use-mcp not available. Desktop will work without computer-use."
fi
```

#### tauri.conf.json（声明 resources）

```jsonc
// subpackage/cli/packages/desktop/src-tauri/tauri.conf.json (修改)
{
  "build": {
    "beforeBuildCommand": "bash ../scripts/prepare-resources.sh"
  },
  "bundle": {
    "resources": [
      "resources/*"
    ]
  }
}
```

`beforeBuildCommand` 确保在 Tauri build 前，`resources/` 目录已包含
CLI 和 MCP binary。Tauri 将 `resources/*` 打入安装包。

#### Desktop 安装后的磁盘布局

```
# macOS
AgentBoster Desktop.app/Contents/
├── MacOS/
│   └── AgentBoster Desktop         ← Tauri 主进程
└── Resources/
    ├── agentboster-cli              ← CLI（同级）
    └── computer-use-mcp             ← MCP（同级）

# Windows
C:\Program Files\AgentBoster Desktop\
├── AgentBoster Desktop.exe          ← Tauri 主进程
└── resources\
    ├── agentboster-cli.exe          ← CLI（同级）
    └── computer-use-mcp.exe         ← MCP（同级）

# Linux (.deb)
/usr/lib/agentboster-desktop/
├── agentboster-desktop              ← Tauri 主进程
└── resources/
    ├── agentboster-cli              ← CLI（同级）
    └── computer-use-mcp             ← MCP（同级）
```

CLI 和 MCP 始终在同一个 `resources/` 目录下同级，
Desktop 主进程通过 Tauri 的 `resolveResource()` API 定位 `resources/` 路径，
然后 spawn 时直接拼同级路径（见「调用路径」章节）。

---

### CI 统一构建流程（GitHub Actions）

```yaml
# .github/workflows/build-all.yml

jobs:
  # Step 1: 编译 Rust binary（可与 Step 2 并行）
  build-computer-use-mcp:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: macos-13
            target: x86_64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: '${{ matrix.target }}' }
      - run: cargo build --release --target ${{ matrix.target }}
        working-directory: subpackage/computer-use-mcp/server
      - uses: actions/upload-artifact@v4
        with:
          name: computer-use-mcp-${{ matrix.target }}
          path: subpackage/computer-use-mcp/server/target/${{ matrix.target }}/release/computer-use-mcp*

  # Step 2: 编译 CLI（可与 Step 1 并行）
  build-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd subpackage/cli && yarn install && yarn build && yarn bundle
      - uses: actions/upload-artifact@v4
        with:
          name: cli-bundle
          path: subpackage/cli/packages/coding-agent/dist/agentboster.cjs

  # Step 3: 组装 CLI tarball（依赖 Step 1 + 2）
  package-cli:
    needs: [build-computer-use-mcp, build-cli]
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          # ...
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: 'cli-bundle', path: 'subpackage/cli/packages/coding-agent/dist/' }
      - uses: actions/download-artifact@v4
        with: { name: 'computer-use-mcp-${{ matrix.target }}', path: 'subpackage/computer-use-mcp/server/target/${{ matrix.target }}/release/' }
      - run: cd subpackage/cli && yarn package

  # Step 4: 组装 Desktop 安装包（依赖 Step 1 + 2）
  package-desktop:
    needs: [build-computer-use-mcp, build-cli]
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - uses: actions/download-artifact@v4
        with: { name: 'cli-bundle', path: 'subpackage/cli/packages/coding-agent/dist/' }
      - uses: actions/download-artifact@v4
        with: { name: 'computer-use-mcp-${{ matrix.target }}', path: 'subpackage/computer-use-mcp/server/target/${{ matrix.target }}/release/' }
      # prepare-resources.sh 会从 artifact 路径找到 binary
      - run: cd subpackage/cli/packages/desktop && bash scripts/prepare-resources.sh
      - uses: tauri-apps/tauri-action@v0
        with:
          projectPath: subpackage/cli/packages/desktop
          args: --target ${{ matrix.target }}
```

关键：Step 1（Rust）和 Step 2（TS）并行，Step 3（CLI tarball）和 Step 4（Desktop 安装包）
也可以并行，但都依赖 Step 1+2 的 artifact。

---

### .gitignore 更新

```gitignore
# subpackage/computer-use-mcp/.gitignore (新建)
target/

# subpackage/cli/packages/desktop/src-tauri/.gitignore (修改，新增)
resources/agentboster-cli
resources/computer-use-mcp
resources/agentboster-cli.exe
resources/computer-use-mcp.exe
```

---

## 测试计划

### 单元测试

| 模块 | 测试文件 | 覆盖 |
|------|----------|------|
| computer-use MCP core | `core/src/screenshot.rs` 测试 | 缩放算法、坐标转换 |
| computer-use MCP core | `core/src/lock.rs` 测试 | 锁获取/释放/冲突/stale 清理 |
| CLI remote-control | `src/core/remote-control.test.ts` | 连接/断开/重连/会话切换 |
| CLI computer-use-mcp | `src/core/computer-use-mcp.test.ts` | binary 发现/MCP 协议/工具调用 |
| Web remote-control | `lib/cli/remote-control.test.ts` | KV 在线状态/listener 管理 |
| IM routing | `lib/chat/remote-route.test.ts` | 路由逻辑/绑定/解绑/切换 |

### 集成测试

| 场景 | 验证点 |
|------|--------|
| 基本远程遥控 | CLI --remote-control → IM /attach → 发消息 → local_exec 执行 → IM 收到结果 |
| CLI 掉线 | CLI kill → IM 发消息 → 收到 "CLI offline, frozen" |
| CLI 重连 | CLI 掉线 → CLI 重启 --remote-control → 自动重连 → IM 消息恢复路由 |
| 会话切换 | CLI /switch 新会话 → IM 自动跟随 → IM 通知 "now following session X" |
| 进程锁 | IM 发消息 → CLI TUI 显示只读 → workflow 完成 → TUI 恢复 |
| L2 审批 | IM 发 "rm -rf /tmp/test" → L2 IM 按钮出现 → approve → 执行 |
| computer-use | IM 发 "screenshot" → CLI MCP 截图 → 缩放 → 返回 base64 → IM 显示 |
| 机器锁互斥 | Desktop 运行中 → CLI --remote-control → MCP 启动失败 "Desktop holds lock" |
| macOS 权限 | 未授权 Accessibility → MCP 启动 → 工具返回引导提示 |

### 手动验收测试

| 场景 | 步骤 |
|------|------|
| 生成 PPT | 1. CLI --remote-control + computer-use<br>2. Telegram /attach<br>3. 发 "用 LibreOffice Impress 创建一个关于 AI 的 PPT"<br>4. 验证 CLI 执行截图+鼠标键盘操控流程<br>5. 验证 PPT 文件生成 |
| 跨平台 | macOS/Windows/Linux 各跑一次基本远程遥控流程 |

---

## 补充：Desktop 打包 CLI + computer-use MCP

### Desktop 产物结构

Desktop 是 Tauri 应用，最终打包为平台原生安装包。
CLI 和 computer-use MCP 作为 sidecar / resource 嵌入。

#### macOS (.dmg / .app)

```
AgentBoster Desktop.app/
└── Contents/
    ├── MacOS/
    │   └── AgentBoster Desktop       ← Tauri 主进程 (Rust)
    ├── Resources/
    │   ├── agentboster-cli            ← CLI Node.js bundle (单文件 CJS)
    │   ├── computer-use-mcp           ← Rust binary
    │   └── ... (icons, assets)
    └── Info.plist
```

#### Windows (.msi / .exe)

```
C:\Program Files\AgentBoster Desktop\
├── AgentBoster Desktop.exe            ← Tauri 主进程
├── resources/
│   ├── agentboster-cli.exe            ← CLI bundle
│   └── computer-use-mcp.exe           ← Rust binary
└── ... (WebView2 runtime, etc.)
```

#### Linux (.deb / .AppImage)

```
/usr/lib/agentboster-desktop/           (.deb)
├── agentboster-desktop                 ← Tauri 主进程
├── resources/
│   ├── agentboster-cli                 ← CLI bundle
│   └── computer-use-mcp               ← Rust binary
└── ...

# 或 AppImage 内同样的 resources/ 结构
```

### Tauri 打包配置

```jsonc
// subpackage/cli/packages/desktop/src-tauri/tauri.conf.json
{
  "bundle": {
    "resources": [
      // CLI bundle（由 yarn bundle 产出的单文件 CJS）
      { "path": "../../../packages/coding-agent/dist/agentboster.cjs", "target": "agentboster-cli" },
      // computer-use MCP binary（由 cargo build 产出）
      { "path": "../../../../computer-use-mcp/server/target/release/computer-use-mcp", "target": "computer-use-mcp" }
    ],
    "externalBin": []
  }
}
```

注意：使用 `resources` 而非 `externalBin`，因为 `externalBin` 会自动追加平台后缀
（如 `computer-use-mcp-x86_64-apple-darwin`），而我们要控制确切的文件名。
`resources` 放入 app bundle 的 resources 目录，运行时通过 Tauri 的 `resolveResource()` API 定位。

### Desktop 构建脚本

```bash
# subpackage/cli/packages/desktop/scripts/build.sh

#!/bin/bash
set -euo pipefail

# 1. 构建 CLI bundle
echo "Building CLI bundle..."
(cd ../../../ && yarn build && yarn bundle)

# 2. 构建 computer-use MCP binary (当前平台)
echo "Building computer-use MCP..."
RUST_TARGET=$(rustc -vV | grep host | awk '{print $2}')
(cd ../../../../computer-use-mcp/server && cargo build --release --target "$RUST_TARGET")

# 3. 复制产物到 Tauri 可见位置（如果 tauri.conf.json 用相对路径）
cp ../../../../computer-use-mcp/server/target/release/computer-use-mcp \
   ./src-tauri/resources/computer-use-mcp
cp ../../../packages/coding-agent/dist/agentboster.cjs \
   ./src-tauri/resources/agentboster-cli

# 4. Tauri build
(cd src-tauri && cargo tauri build)
```

### Desktop CI (GitHub Actions)

```yaml
# .github/workflows/desktop-build.yml
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            rust-target: aarch64-apple-darwin
            tauri-target: aarch64-apple-darwin
          - os: macos-13
            rust-target: x86_64-apple-darwin
            tauri-target: x86_64-apple-darwin
          - os: ubuntu-latest
            rust-target: x86_64-unknown-linux-gnu
            tauri-target: x86_64-unknown-linux-gnu
          - os: windows-latest
            rust-target: x86_64-pc-windows-msvc
            tauri-target: x86_64-pc-windows-msvc

    steps:
      - uses: actions/checkout@v4

      # 构建 CLI bundle
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: cd subpackage/cli && yarn install && yarn build && yarn bundle

      # 构建 computer-use MCP
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: '${{ matrix.rust-target }}' }
      - run: |
          cd subpackage/computer-use-mcp/server
          cargo build --release --target ${{ matrix.rust-target }}

      # 复制资源
      - run: |
          mkdir -p subpackage/cli/packages/desktop/src-tauri/resources
          cp subpackage/computer-use-mcp/server/target/${{ matrix.rust-target }}/release/computer-use-mcp* \
             subpackage/cli/packages/desktop/src-tauri/resources/
          cp subpackage/cli/packages/coding-agent/dist/agentboster.cjs \
             subpackage/cli/packages/desktop/src-tauri/resources/agentboster-cli

      # Tauri build
      - uses: tauri-apps/tauri-action@v0
        with:
          projectPath: subpackage/cli/packages/desktop
          tauriScript: cargo tauri
          args: --target ${{ matrix.tauri-target }}
```

---

## 补充：调用路径（谁调用谁，CWD 在哪）

### 安全原则：仅同级目录查找

**所有 binary 查找严格限制为调用者自身所在目录的同级文件。**
不搜索 PATH、不搜索环境变量指定的目录、不搜索其他任何位置。
这防止了路径投毒攻击——攻击者无法通过修改 PATH 或在其他目录放置恶意
binary 来劫持 CLI/Desktop 的子进程。

### 磁盘布局

同级规则分两层：
- **CLI ↔ MCP**：严格同级，用 `resolveSiblingBinary()` 查找
- **Desktop → CLI**：不同级（Tauri binary 和 resources 在不同目录），用 Tauri `resolveResource()` API 查找（app bundle 内部固定路径，不走 PATH，不可外部投毒）

```
# CLI tarball 分发
# CLI 和 MCP 同级 ✓
bin/
├── agentboster-cli              ← CLI 入口
└── computer-use-mcp             ← 同级，resolveSiblingBinary() 找到

# Desktop 安装后 (macOS)
# Desktop binary 和 resources 不同级，通过 Tauri API 定位
# CLI 和 MCP 在 resources/ 内同级 ✓
AgentBoster Desktop.app/Contents/
├── MacOS/
│   └── AgentBoster Desktop      ← Tauri 主进程（不在 resources/ 里）
└── Resources/
    ├── agentboster-cli          ← CLI（resolveResource() 找到）
    └── computer-use-mcp         ← MCP（CLI 的 resolveSiblingBinary() 找到）

# Desktop 安装后 (Windows)
C:\Program Files\AgentBoster Desktop\
├── AgentBoster Desktop.exe      ← Tauri 主进程
└── resources\
    ├── agentboster-cli.exe      ← CLI（resolveResource() 找到）
    └── computer-use-mcp.exe     ← MCP（CLI 的 resolveSiblingBinary() 找到）

# Desktop 安装后 (Linux)
/usr/lib/agentboster-desktop/
├── agentboster-desktop          ← Tauri 主进程
└── resources/
    ├── agentboster-cli          ← CLI（resolveResource() 找到）
    └── computer-use-mcp         ← MCP（CLI 的 resolveSiblingBinary() 找到）

# 开发环境 (yarn dev)
# 例外：开发时通过 DEV_COMPUTER_USE_MCP 环境变量显式指定 cargo 产物路径
# 此变量仅在开发环境设置，生产构建中不存在
```

### 路径总览

```
Desktop (Tauri 主进程, 在 MacOS/ 或安装根目录)
  │
  ├── spawn CLI (RPC 模式)
  │     binary = resolveResource('agentboster-cli')     ← Tauri API，非同级
  │     CWD = 用户工作目录
  │     env: AGENTBOSTER_DESKTOP_RPC=1
  │
  └── CLI (RPC 子进程, 在 resources/ 目录)
        │
        └── spawn computer-use MCP
              binary = dirname(CLI 自身) + '/computer-use-mcp'  ← 同级 ✓
              CWD = process.cwd()（继承用户工作目录）


CLI (独立 TUI 模式, 在 bin/ 目录)
  │
  └── spawn computer-use MCP
        binary = dirname(CLI 自身) + '/computer-use-mcp'        ← 同级 ✓
        CWD = process.cwd()（终端 CWD）
```

### 核心函数：同级查找

```typescript
// subpackage/cli/packages/coding-agent/src/core/resolve-sibling-binary.ts

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 仅从调用者 binary 的同级目录查找目标 binary。
 * 不搜索 PATH、不搜索环境变量路径、不接受外部输入。
 * 防止路径投毒。
 */
export function resolveSiblingBinary(name: string): string | null {
  const binaryName = process.platform === 'win32' ? `${name}.exe` : name;

  // 调用者自身的目录
  // CLI 打包后: bin/agentboster-cli → dirname = bin/
  // CLI 开发时: dist/cli.js → dirname = dist/ （开发环境不适用，见下方）
  const selfDir = dirname(process.argv[1] || __filename);
  const siblingPath = join(selfDir, binaryName);

  if (existsSync(siblingPath)) {
    return siblingPath;
  }

  return null;
}
```

### Desktop → CLI

```typescript
// subpackage/cli/packages/desktop/src/rpc/bridge.ts

async function spawnCliRpc(): Promise<ChildProcess> {
  // Desktop binary 同级的 CLI
  const selfDir = await resolveResourceDir();  // Tauri: resources 目录
  const cliBinary = join(selfDir, 'agentboster-cli');

  if (!existsSync(cliBinary)) {
    throw new Error(
      `CLI binary not found at ${cliBinary}. ` +
      `It must be in the same directory as the Desktop app.`
    );
  }

  const userCwd = await getCurrentProjectDir() ?? process.cwd();

  return spawn('node', [cliBinary, '--mode', 'rpc'], {
    cwd: userCwd,
    env: {
      ...process.env,
      AGENTBOSTER_DESKTOP_RPC: '1',
      AGENTBOSTER_HOME: getDesktopConfigDir(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
```

### CLI → computer-use MCP

```typescript
// subpackage/cli/packages/coding-agent/src/core/computer-use-mcp.ts

import { resolveSiblingBinary } from './resolve-sibling-binary';

async tryStart(): Promise<boolean> {
  // 严格同级查找，不搜索 PATH
  const binaryPath = resolveSiblingBinary('computer-use-mcp');

  if (!binaryPath) {
    // 开发环境 fallback：仅当显式设置了开发环境变量时
    // 生产构建中此变量不存在，所以不会被投毒
    if (process.env.NODE_ENV === 'development' && process.env.DEV_COMPUTER_USE_MCP) {
      const devPath = process.env.DEV_COMPUTER_USE_MCP;
      if (existsSync(devPath)) {
        return this.startWithBinary(devPath);
      }
    }

    logger.info('computer-use-mcp binary not found in sibling directory, skipping');
    return false;
  }

  return this.startWithBinary(binaryPath);
}

private async startWithBinary(binaryPath: string): Promise<boolean> {
  const configDir = getAgentbosterHome();

  this.process = spawn(binaryPath, [], {
    cwd: process.cwd(),  // 继承调用者 CWD
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      // 只传递必要的环境变量，不透传全部 process.env
      // 减少攻击面
      HOME: process.env.HOME,
      PATH: '',  // 空 PATH，MCP binary 不需要调用外部程序
      DISPLAY: process.env.DISPLAY ?? '',
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      COMPUTER_USE_SESSION_ID: this.sessionId,
      COMPUTER_USE_CONFIG_DIR: configDir,
    },
  });

  // MCP 握手...
  return true;
}
```

注意：spawn 时 **不透传全部 `process.env`**，只传必要变量。
MCP binary 是静态链接的 Rust 程序，不需要 PATH 去找其他程序。
这进一步缩小攻击面。

### 打包脚本确保同级

```javascript
// subpackage/cli/scripts/package.mjs (修改)

// CLI tarball：两个 binary 放入同一个 bin/ 目录
const binDir = path.join(distDir, 'bin');
fs.mkdirSync(binDir, { recursive: true });

// 1. CLI 本身
fs.copyFileSync(
  path.resolve('packages/coding-agent/dist/agentboster.cjs'),
  path.join(binDir, 'agentboster-cli')
);

// 2. computer-use MCP（同级）
const mcpBinary = getMcpBinaryForPlatform();
fs.copyFileSync(mcpBinary, path.join(binDir, binaryName('computer-use-mcp')));
if (process.platform !== 'win32') {
  fs.chmodSync(path.join(binDir, binaryName('computer-use-mcp')), 0o755);
}
```

```jsonc
// subpackage/cli/packages/desktop/src-tauri/tauri.conf.json (修改)
// Desktop：CLI 和 MCP 都放入 resources/，确保同级
{
  "bundle": {
    "resources": [
      {
        "path": "../../../packages/coding-agent/dist/agentboster.cjs",
        "target": "agentboster-cli"
      },
      {
        "path": "../../../../computer-use-mcp/server/target/release/computer-use-mcp",
        "target": "computer-use-mcp"
      }
    ]
  }
}
```

### 环境变量传递链

```
Desktop Tauri 主进程
  ↓ spawn CLI，传递：
  env:
    AGENTBOSTER_DESKTOP_RPC=1
    AGENTBOSTER_HOME=~/.config/agentboster-desktop
    HOME, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR (系统/桌面环境)

CLI (RPC 子进程)
  ↓ spawn computer-use MCP，传递（最小化）：
  env:
    COMPUTER_USE_SESSION_ID=abc-123
    COMPUTER_USE_CONFIG_DIR=~/.config/agentboster-desktop
    HOME, DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR (透传)
    PATH=''  ← 空，防止 MCP 调用外部程序
```

### 配置目录选择逻辑（最终版）

```
调用场景                              配置目录                          computer-use.lock 位置
─────────────────────────────────────────────────────────────────────────────────────────────
CLI 独立运行 (TUI)                    ~/.config/agentboster-cli         ~/.config/agentboster-cli/computer-use.lock
Desktop 调用 CLI (RPC)                ~/.config/agentboster-desktop     ~/.config/agentboster-desktop/computer-use.lock
Desktop 直接操作 (Tauri command)      ~/.config/agentboster-desktop     ~/.config/agentboster-desktop/computer-use.lock
```

MCP 启动时检查**两个**锁路径，确保 CLI 独立运行和 Desktop 不会同时操控电脑：

```rust
// core/src/lock.rs
pub fn acquire(session_id: &str, config_dir: &Path) -> Result<Self, LockError> {
    // 检查自己的锁路径
    check_lock_file(&config_dir.join("computer-use.lock"))?;

    // 交叉检查另一个应用的锁路径
    let other_dir = if config_dir.ends_with("agentboster-desktop") {
        config_dir.parent().unwrap().join("agentboster-cli")
    } else {
        config_dir.parent().unwrap().join("agentboster-desktop")
    };
    let other_lock = other_dir.join("computer-use.lock");
    if other_lock.exists() {
        check_lock_file(&other_lock)?;
    }

    // 写入自己的锁
    write_lock_file(&config_dir.join("computer-use.lock"), session_id)?;
    Ok(Self { path: config_dir.join("computer-use.lock") })
}
```
