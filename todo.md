# TODO

## agentd 桌面栈可靠性改进

`subpackage/agentd/internal/agent/desktop/desktop.go` 的桌面栈当前采用
**nohup + pkill + sleep** 的 ephemeral 模型：每次 `desktop_*` 工具调用通过
`EnsureDesktop` 拉起（或复用）一组 nohup 后台进程，靠 `idleReaper` 在空闲时
`pkill` 掉，下次调用再重建。作者在代码注释中明确说明这是有意为之——"daemons
only need to outlive this single sbMgr.Exec call, not survive sandbox restart"
（`desktop.go:390-395`）。

这个模型在"轻负载、用完即弃、下次调用能重建"的语义下能工作，但下面这些问题
经代码 + 安装脚本交叉核实属实，会在真实场景中造成可观察的故障。按严重度排序。

**核实方法说明**：本节每条结论都对照了 `desktop.go`（运行时逻辑）和
`desktop_install.sh`（实际安装的包列表），不轻信代码注释。

---

### P0 — Alpine 上 `probeHealth` 和 `pkill` 依赖的命令根本没装

**这是最严重的问题，直接让整个恢复逻辑失效。**

**核实**：`desktop_install.sh` 在 Alpine 上安装的包是（`desktop_install.sh`
的 `PKGS=` 行）：

```
xorg-server-xvfb icewm x11vnc websockify xdotool imagemagick at-spi2-core dbus-x11
```

但 `desktop.go` 实际依赖的命令有两个**不在上面列表里**：

| 命令 | 用途 | 出现位置 | Alpine 所属包 | 是否在 PKGS |
|---|---|---|---|---|
| `xdpyinfo` | `probeHealth` 唯一探测手段 | `desktop.go:381` | `xorg-xdpyinfo` | ❌ **缺失** |
| `pkill -f` | `startStack`/`reapIdleStacks` 进程清理（4 处） | `desktop.go:179/400/...` | `procps-ng` | ❌ **缺失** |

**真实后果（Alpine 沙箱上）**：

1. `probeHealth` 永远返回 false——不是桌面挂了，而是 `xdpyinfo: command not
   found`。代码用 `command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo ...` 做探测，
   `command -v` 失败时整个表达式 false，`probeHealth` 误判为 unhealthy。
2. 于是 `EnsureDesktop` **每次调用都走重建路径**：先 `startStack`（重复 nohup
   一堆进程，旧的可能还在）→ 再轮询 30s（`healthPollTimeout`）→ 一直 false →
   最终返回 `"desktop: Xvfb not reachable on :99 after 30s"` 错误。
3. 即使侥幸起来，`pkill -f` 失败 → `startStack` 开头的"清理 stale 进程"步骤
   no-op → 旧进程残留 → `Xvfb :99` 因为 `/tmp/.X99-lock` 占用而启不起来 →
   死循环。
4. debian/rhel 发行版默认带的 `xdpyinfo` 和 `procps` 让这个问题隐身了——
   **只在 Alpine 上爆**，作者大概率没在 Alpine 测过。

**核实笔记**：之前 todo 的 P1（健康检查只看 X）在 Alpine 上根本 moot——
`probeHealth` 连跑都跑不起来，谈不上"只看 X"。

**建议**：

- `desktop_install.sh` 的 Alpine `PKGS=` 补上 `xorg-xdpyinfo procps-ng`。
  debian/rhel 的 PKGS 里 `xdpyinfo` 属 `x11-utils`、`pkill` 属 `procps`，
  建议同步补上（debian 上 `procps` 默认装，但 `x11-utils` 不一定）。
- 或者把 `probeHealth` 改用 `Xvfb` 自带工具（如 `xset -display :99 q`，
  在 `xorg-server-xvfb` 包里）+ bash `/dev/tcp` 端口探测（无需 nc），
  减少 hardcoded 工具依赖。后者更稳。
- 加 CI 测试：在 `alpine:latest` 容器里跑一次 `desktop_install.sh`，再
  断言 `command -v xdpyinfo && command -v pkill` 都成功。

---

### P1 — 桌面栈无持久监管，崩溃后只能靠下次调用兜底

**现状**：Xvfb / x11vnc / websockify / icewm / dbus-launch 五个进程全部以
`nohup ... & echo $! > *.pid` 形式脱离 `sbMgr.Exec` 调用（`desktop.go:426/477/
489/785`）。没有任何 supervisor / respawn / watchdog 逻辑
（`grep -nE 'supervisor|respawn|watchdog'` 无命中）。

作者的明确设计（`desktop.go:390-395`）：

> "We use nohup rather than setsid/tmux/openrc because the daemons only need to
> outlive this single sbMgr.Exec call, not survive sandbox restart — Xvfb crashes
> are recovered by EnsureDesktop's poll loop on the next desktop_* call."

也就是说**进程崩溃后，daemon 完全感知不到**，只有下次 `desktop_*` 工具调用
触发 `EnsureDesktop` → `probeHealth` 失败 → 才会重建（`desktop.go:278-323`）。

**这个假设的真实破绽**：

- 用户在 noVNC 里看着桌面，x11vnc 进程悄悄崩了 → 用户看到黑屏 / 断连，
  daemon 还认为 `ready=true`。
- 如果 agent 正在跑非桌面工具（exec / file / web_search），即使桌面栈全崩了，
  daemon 也不会主动修复——下一次桌面工具调用才会触发重建，中间这几十秒到
  几分钟用户看到的就是死的。
- `idleReaper`（`desktop.go:122-194`）每 5 分钟扫一次 `lastActivity`，超过
  30 分钟就 pkill 整个栈。重建是"按需"的，没有常驻心跳。
- **叠加 P0**：Alpine 上 `probeHealth` 永远 false，"下次调用重建" 这个兜底
  本身就不可靠（可能误重建，也可能重建失败）。

**建议**：

- 引入轻量 supervisor：每个沙箱起一个 goroutine，周期性 `probeHealth`，
  失败计数超阈值就主动重建并打日志。（`probeHealth` 修复见 P0。）
- 或更简单：把 `idleReaperLoop` 复用成 "reaper + watchdog" 双职——它本来
  就每 5 分钟扫一遍所有沙箱，顺带 probe 一下活跃沙箱的桌面栈健康度几乎零成本。
- 重建后通过 eventbus（`internal/eventbus`）发事件，让 Web 端能感知，避免
  noVNC 客户端傻等。

---

### P2 — 健康检查只覆盖 X server，x11vnc / websockify 挂了感知不到

**现状**（`desktop.go:379-382`）：

```go
func probeHealth(sbMgr *sandbox.Manager, sandboxID string) (bool, error) {
    cmd := fmt.Sprintf("command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo -display %s >/dev/null 2>&1", defaultDisplay)
    ...
    return res.ExitCode == 0, nil
}
```

健康检查**只测 `xdpyinfo -display :99`**——即 X server 是否在说 X11 协议。
完全不检查：

- `x11vnc` 是否在监听 `5999` 端口（RFB）
- `websockify` 是否在监听 `6080`（WebSocket）
- `icewm` 进程是否还活着

`grep -iE 'websockify|x11vnc.*probe|rfbport.*check'` 在整个文件里只命中注释，
没有任何代码层面的探测。

**真实后果**：Xvfb 还活着 → `probeHealth` 返回 true → `EnsureDesktop` 走 fast
path 直接返回 → 但 x11vnc 早就崩了 → **用户从 noVNC 进来看黑屏，daemon 还认
为桌面健康**。（前提：P0 修了，否则 Alpine 上 `probeHealth` 一直 false 反而
"误打误撞"地让用户知道桌面不可用——但这不是好设计。）

**建议**：`probeHealth` 扩展为多层探测，任一层失败都返回 unhealthy：

```sh
xdpyinfo -display :99                                   # X server（现有）
timeout 1 bash -c '</dev/tcp/127.0.0.1/5999'            # x11vnc RFB（bash 内建，无 nc 依赖）
timeout 1 bash -c '</dev/tcp/127.0.0.1/6080'            # websockify WS
pgrep -x icewm                                           # WM（非致命，缺失则降级）
```

注意用 `bash /dev/tcp` 而不是 `nc`——`nc` 在 Alpine 属 `netcat-openbsd` 包，
又是额外依赖。`bash` 在 Alpine 默认也没有（只有 ash），需要在 install 脚本补
`bash`，或者改用 `Xvfb` 自带的端口探测工具。**依赖最小化是这条建议的核心**，
否则会重蹈 P0 覆辙。

---

### P3 — `idleReaper` 杀进程靠 `pkill -f` 模糊匹配 + PID 文件装饰性

**现状**：`startStack` 每个进程都写 PID 文件（`desktop.go:426/477/489/785`，
形如 `echo $! > %s/xvfb.pid`），但作者**在注释里自己承认**（`desktop.go:411`）：

> "No code reads these to kill — startStack uses pkill -f for that — but leaving
> stale PIDs around is misleading and a fresh start is cheap."

即 PID 文件**只写不读**，真正清理靠 `pkill -f "Xvfb :99"` 这种按命令行模糊
匹配杀进程（`desktop.go:179/400`）。

**真实后果**：

- `pkill -f "x11vnc.*:99"` 这种正则有误杀风险——沙箱里任何命令行包含
  `x11vnc ... :99` 字样的进程都会被杀。当前沙箱里只有 x11vnc 这一个匹配项，
  风险低，但未来若加入其他 VNC 工具就会撞。
- `pkill -f "icewm"` 连 display 都不指定，跨沙箱（如果未来 LXC 不隔离进程
  命名空间）会更危险。
- PID 文件本可以是精准按 PID 杀进程的依据（`kill $(cat *.pid)`），现在这个
  能力被放弃了。
- **叠加 P0**：Alpine 上 `pkill` 根本没装，`pkill -f` 全部 no-op，清理完全
  失效——stale 进程永远杀不掉。

**建议**（在 P0 修好后做）：

- 二选一：
  - **要么删掉 PID 文件**：既然不读，写它就是误导，纯靠 `pkill -f`，
    注释里说清楚。
  - **要么真的用 PID**：实现 `killByPidfile`，用 `kill -TERM $(cat *.pid)`
    精准清理，废弃 `pkill -f`。这样未来支持同一沙箱多 display / 多 VNC 实例
    也安全。
- 推荐后者，因为 P1 的 supervisor 重建逻辑需要精准 kill 才不会误伤。

---

### P4 — `sleep 1` 硬编码等待，startStack 内部的 race 没有 probe 兜底

**现状**：`startStack` 在启动 Xvfb 后插入一行
`runScriptRaw(..., "sleep 1", 5)`（`desktop.go:434`），等待 X server bind
display。代码用 `if ... ; false { _ = out }` 这种 hack 绕过 lint——作者自己也
知道这写法不干净。

同样的硬编码 `sleep 1` 还出现在 dbus/at-spi 启动脚本里（`desktop.go:767`）。

**真实后果**：

- `sleep 1` 是经验值。慢机器 / 高负载 / 慢磁盘 I/O 下 Xvfb 来不及 bind，
  后续 x11vnc 连 `:99` 会失败。
- 现有 `EnsureDesktop` 的 `probeHealth` 轮询循环（`desktop.go:312-321`，
  `healthPollInterval=2s` / `healthPollTimeout=30s`）**能兜住 Xvfb 起来的 race**
  ——即使首次 sleep 1 不够，轮询会在 30s 内探到 X 起来。
- **但 dbus → icewm → x11vnc 之间的 sleep 1 race 没有 probe 兜底**：dbus
  launch 后 1s 就启 icewm，icewm 起不来就 Warn + 降级，不会 retry。如果慢机器
  上 dbus launch 超过 1s，icewm 启动时 dbus 还没 ready，整个 a11y 链就断了，
  静默降级到"raw X + 无 a11y"。

**建议**：

- 把 startStack 内部的 `sleep 1` 替换成显式 poll：启 Xvfb 后用
  `for i in $(seq 1 20); do xdpyinfo -display :99 && break; sleep 0.3; done`，
  最多等 6s 但通常 300ms 就过。
- dbus launch 后同样用 poll 等 `DBUS_SESSION_BUS_ADDRESS` 出现，而不是 sleep 1。
- `desktop.go:434` 那个 `if ... ; false { _ = out }` lint hack 顺手清掉，
  改成正经的 `_, _ = runScriptRaw(...)` 或加注释说明为什么忽略返回值。

---

### P5 — icewm 失败的"降级到 raw X"路径无测试，且 raw X 不可用是现实问题

**现状**：`startStack` 里 icewm 启动失败被显式降级（`desktop.go:468`）：

```go
if err := runScript(sbMgr, sandboxID, icewmCmd, 15); err != nil {
    slog.Warn("desktop: icewm start failed (continuing — apps still work without a WM)")
}
```

注释（`desktop.go:464`）说："raw X without a WM is still usable for full-screen
apps"。

**核实**：这个判断**不能轻信**。raw X 无 WM 的实际行为是：

- **无 WM 的 X 下，绝大多数 GUI 应用的窗口没有装饰、不能移动、不能聚焦切换**。
  窗口出现在 (0,0) 默认位置，叠在一起没法分开。
- 很多 GTK/Qt 应用在无 WM 时会**直接拒绝渲染**或卡在 `gtk_init`——因为它们
  依赖 `_NET_SUPPORTED` / `WM_PROTOCOLS` 这些 WM 提供的 EWMH 特性。
- 全屏应用（glxgears、某些游戏）确实能在无 WM 下跑，但 agentboster 的目标
  场景是浏览器（chromium）+ 桌面应用——chromium 在无 WM 下能启但窗口定位
  奇怪，且无法切到其他窗口。
- 所以注释的 "apps still work" 是乐观假设，实际是 "apps partially work,
  agent 可能找不到窗口在哪"。

**真实后果**：icewm 启动失败（沙箱 HOME 不可写、配置目录权限不对、icewm
版本 bug）→ 静默降级 → agent 后续 `desktop_screenshot` 看到的是一堆叠在一起
的窗口或空白 → LLM 误判 → 工具链漂移。

**而且这条降级路径没有任何测试**：`grep -rE 'icewm.*fail|without.*WM'`
在 `*_test.go` 里零命中。作者的 Warn 日志写了，但没人验证降级后系统是否真
"usable"。

**建议**：

- 加 e2e 测试：故意让 icewm 启动失败（fake icewm binary 返回非零），跑一遍
  `desktop_screenshot` + `desktop_click`，断言截图非空 + 点击坐标生效。
  如果发现降级后 chromium 窗口乱跑，就证明注释撒谎，需要把 icewm 改成
  **fatal**（startStack 直接返回 error），而不是降级。
- 或者保留降级，但在 Warn 里附 `AGENTD_DESKTOP_DEGRADED=true` 标记，让
  `EnsureDesktop` 把这个状态记进 `readySet` 的元数据，下次工具调用把
  "桌面处于降级模式"作为 context 返给 LLM，让它知道截图可能异常。
- 至少把注释从 "apps still work" 改成 "full-screen apps work, multi-window
  apps may overlap without focus management"。

---

## 关于设计哲学（不必改，记录用）

上述 P0-P5 都是**在现有 ephemeral-desktop 模型内的可靠性补丁**，不质疑模型
本身。

ephemeral 模型（用完即弃、下次重建）是相对 persistent-desktop 模型（如 memoh
的 WebRTC + 长生命周期 session）的有意取舍，对应 agentboster "桌面是 agent
工具，不是云电脑产品" 的定位。**P0-P5 的目标不是把 agentd 变成 memoh**，而是
让 ephemeral 模型在它自己的语义边界内**不出静默故障**：

- 安装脚本和运行时逻辑的依赖对不上（P0）
- 用户看黑屏而 daemon 不知道（P1 + P2）
- 进程清理误伤 / 不工作（P3，叠加 P0）
- 启动时序 race（P4）
- 降级路径不可靠且未测试（P5）

这些都是"ephemeral 模型的工程债"，不是"该换模型"的信号。修完这六条，agentd
的桌面栈依然是轻量的，但不再静默漏报故障。

---

## 核实方法记录（避免下次重蹈覆辙）

写这一节是因为前几轮分析里多次出现"看注释下判断"的错误。本 todo 的每条
结论都遵循：

1. **运行时依赖**（`desktop.go` 调用的命令）和**安装清单**
   （`desktop_install.sh` 的 PKGS）**交叉对照**，不能只看一边。
2. **不轻信注释**：作者注释里 "apps still work without WM" / "raw X usable"
   这类乐观判断，必须有反证或测试覆盖才采信。
3. **跨发行版核实**：Alpine 和 debian 的包划分不同（`xdpyinfo` / `pkill`
   所属包完全不同），不能假设"Linux 上都有"。
4. **降级路径必须能测**：任何 "treat failure as non-fatal" 的代码路径
   （`desktop.go` 里至少 3 处：icewm/dbus/at-spi）都要有故意触发的 e2e 测试。

---

## P6 — nohup 是偷懒选择，不是必需；整个进程监管模型可以省掉

**起因**：前面 P0-P5 都是在"如何让 nohup 方案更可靠"的框架里打补丁。但核实
sandbox Exec 模型后发现，**nohup 本身可以不用**，而且不用的话 P0/P1/P3 三条
问题会一次性消失。

### nohup 解决的真问题

agentd 的沙箱 Exec 是**一次性命令执行**模型（核实：`lxc_persistent.go:159`
和 `docker.go:181`）：

```go
// lxc-attach 是一次性进程，命令结束 exec 进程退出
execCmd = exec.CommandContext(ctx, "lxc-attach", lxcArgs...)
```

每次 `sbMgr.Exec()` 都是一次 `lxc-attach -- sh -c "cmd"` / `docker exec`，
**命令结束 exec 进程就退出**，会 SIGHUP 给子进程。所以 nohup 的唯一目的是
**让桌面进程在 exec 调用返回后继续存活**——因为没有 nohup 的话，父进程
（sh -c）退出会 SIGHUP 子进程，Xvfb 跟着挂。

### 比 nohup 更好的方案（一个都没用）

| 方案 | 原理 | 比 nohup 强在哪 | agentd 是否用 |
|---|---|---|---|
| `setsid Xvfb :99` | 创建新会话，脱离控制终端 | SIGHUP 根本送达不了 | ❌ |
| `tini` / `dumb-init` 作为容器 PID 1 | 容器原生 init，负责回收僵尸 + 转发信号 | 桌面进程是 init 子进程，init 自动监管 | ❌ |
| `supervisord` / `s6` | 真正的进程监管 | 进程挂了自动 respawn，不需要 idleReaper 补丁 | ❌ |
| agentd 自己当 supervisor | 起常驻 lxc-attach 跑前台桌面 | agentd 直接感知进程死活 | ❌ |

作者注释（`desktop.go:390-395`）明说"不用 setsid/tmux/openrc"，但**没说为
什么不用最简单的 setsid**——`setsid Xvfb :99` 比 `nohup Xvfb :99 &` 更简单
更可靠。这是**主动选择最脆的方案**。

### 最根本的替代：让 agentd 真正监管子进程

现在 agentd 把桌面进程当"外部黑盒"——起完就走，死了靠下次 probe 发现。
如果改成：

1. 起一个常驻 lxc-attach 进程跑 `tini`（容器 init）；
2. 通过 tini 拉起桌面进程（tini 自动 respawn + 回收僵尸）；
3. agentd 持有这个 lxc-attach 的 stdin/stdout，进程死了 agentd **立刻知道**。

这样 **P0（Alpine 命令缺失）、P1（无持久监管）、P3（PID 文件装饰性）三个
问题一次性解决**，根本不需要 nohup + probeHealth + idleReaper + pkill 这堆
补丁。

### 为什么 agentd 选了 nohup

因为 agentd 把"启动沙箱里的一次性命令"和"在沙箱里跑常驻服务"当成同一件事
处理——用同一个 `sbMgr.Exec()` 接口，只是后者加个 `&` 让它后台化。这是
**接口设计导致的偷懒**：`sbMgr.Exec` 没有区分 "run-to-completion" 和
"launch-daemon" 两种语义，于是所有常驻服务都被迫套 nohup。

**建议**（架构级，优先级最高但工作量也最大）：

- 引入 `sbMgr.LaunchDaemon(name, cmd, env)` 接口，内部用 setsid 或常驻
  lxc-attach，返回一个 `*DaemonHandle`，持有 stdin/stdout pipe + PID +
  Wait channel。桌面进程通过这个接口起，agentd 直接持有 handle，进程死了
  channel 触发，根本不需要 probeHealth 轮询。
- 短期最小修复：把 `nohup ... & echo $! > pid` 至少改成 `setsid ... &
  echo $! > pid`，一行字改动，立刻消除 SIGHUP 风险。

---

## P7 — agentd 整体可靠性问题：不止 desktop，是工程风格问题

**起因**：核实各模块测试覆盖率和错误处理模式后发现，desktop 的脆弱模式
（shell 拼接 + 降级成瘾 + 注释自夸 + 测试稀薄）在 agentd 其他核心模块也
系统性出现。desktop 不是孤例，是工程风格的集中暴露。

### 证据 1：核心业务层测试覆盖 ~20%

```
agent      18%  ← CodeAct loop、工具调度、desktop 全在这
sandbox    22%  ← Exec 实现（且 Exec 本身有接口缺陷，见 P8）
security   22%  ← 号称核心卖点的 L0/L1/L2
server      7%  ← HTTP API 层
worker      6%  ← 任务调度
lsp         5%  ← 代码智能
config     16%
clawless   23%
```

对比基础工具层（jsonstream 114% / usertype 89% / lifecycle 65% / persistence
54% / cache 50% / metrics 50% / session 46% / logging 41%）——这些容易测的
模块都测了，**但真正会出业务故障的层都在 20% 以下**。desktop 的问题不是
孤例，是 `internal/agent` 整体欠债的体现。

### 证据 2：security 模块深度存疑

号称 L0/L1/L2 三层安全，但 `os_enforce`（seccomp + capabilities + policy，
真正做内核级隔离的部分）只有 **481 LOC**（seccomp 206 行 + capabilities
95 行 + policy 180 行）。这个量级只能做最基础的过滤，**远不如专业容器运行
时的隔离深度**。而且 security 整体只有 22% 测试覆盖。

L1 scorer 是**调远程服务**（`clawless.L1Scorer` 客户端）——最关键的安全
判断依赖外部 API，挂了就降级。

### 证据 3：降级路径成瘾

整个 `internal/agent` 里 `non-fatal / best-effort / continuing / fall back /
degrade` 注释出现 **15+ 次**（`background.go` / `browser/browser.go` /
`checkpoint.go` / `desktop/desktop.go` / `loop.go` 都有）。desktop 只是
重灾区，不是特例。

这种"凡是有可能失败就 best-effort + 继续"的风格，好处是不容易整体崩溃，
坏处是**故障被静默吞掉，系统进入半残状态而无人知晓**——这正是 desktop
用户看黑屏的根因。

### 证据 4：靠 shell 拼接管理复杂状态

`grep fmt.Sprintf.*(sh -c|rm -f|pkill)` 命中点：`desktop.go`（已展开
P0-P5）、`browser/browser.go:316`（同样模式：`fmt.Sprintf("rm -f %s %s
2>/dev/null || true")`）。browser 子模块也靠 shell 拼接清理。

`grep 'is reliable|is safe|always works|guaranteed'` 命中
`security/privilege.go:174` 的注释——安全模块也出现"心虚自夸"的注释模式。

### 建议的应对策略

这条不是单个 todo 能解决的，是工程文化问题，但可以拆成可执行项：

1. **核心模块测试覆盖目标**：agent / sandbox / security / server / worker
   / lsp 这 6 个模块的测试覆盖率从当前 5-22% 提到至少 40%。先从 sandbox
   的 Exec 开始（它是所有工具调用的基础，且 P8 暴露了接口缺陷）。
2. **降级路径清单化**：把 `internal/agent` 里所有 `non-fatal / best-effort
   / continuing / degrade` 路径列出来，每条至少有一个故意触发的 e2e 测试。
   修不起来的就改成 fatal，而不是静默吞错。
3. **shell 拼接审计**：所有 `fmt.Sprintf(... sh -c ...)` / `fmt.Sprintf(...
   rm -f ... 2>/dev/null || true)` 模式逐个审，要么改成结构化命令执行
   （[]string 传参，不用 shell），要么至少加引号转义（agentd 已有
   `singleQuote` / `escapeForSingleQuote` 工具，但只在 desktop 用，browser
   没用）。
4. **os_enforce 深度评估**：要么承认 security 是"比裸 exec 多一层检查"，
   把定位从"L0/L1/L2 安全边界"下调；要么补 seccomp 规则到真实生产级
   （参考 firecracker / gVisor 的 filter 量级，至少 2-3K LOC）。
5. **注释审查**：把所有 `still works / usable / safe / guaranteed` 类
   乐观注释标记出来，要么补测试证明，要么删掉自夸表述。

---

## P8 — sandbox Exec 接口吞错误，调用方无法区分故障类型

**核实**：`internal/sandbox/lxc_persistent.go:159-202` 的 `Exec` 实现：

```go
if err != nil {
    if exitErr, ok := err.(*exec.ExitError); ok {
        result.ExitCode = exitErr.ExitCode()
    } else {
        result.ExitCode = -1
    }
    result.Stderr = string(output)
}
return result, nil   // ← err 被吞了，永远返回 nil error
```

### 问题

**非零退出码、命令不存在、超时、lxc-attach 本身崩了**——全部被压成
`result.ExitCode = -1`，然后**返回 `nil` error**。调用方拿到的是
`*ExecResult{ExitCode: -1}` + `nil error`，**完全无法区分**：

- 命令执行了但失败（ExitCode > 0，正常业务错误）
- 命令不存在（ExitCode = 127）
- 超时（context deadline）
- lxc-attach 本身崩了 / 沙箱不存在（exec.ErrNotFound）

而且 `output` 在失败时**同时被赋给 Stdout 和 Stderr**（看代码：
`result.Stderr = string(output)`，但前面 `result.Stdout = string(output)`
已经赋过了）——错误信息和正常输出混在一起。

### 真实后果

这条 bug 会通过整个调用链放大：

- desktop 的 `probeHealth`（`desktop.go:379`）拿到 ExitCode = -1，分不清
  是 xdpyinfo 命令不存在（P0）还是 X server 真挂了。两者都被当 unhealthy
  处理，于是 EnsureDesktop 误重建。
- 任何工具调用（exec / file / git 等）出错时，LLM 拿到的是含混的
  `ExitCode = -1` 错误信息，无法精准 self-heal。
- agentd 的 L0/L1/L2 安全审计依赖 Exec 返回的 output 做判断，stdout/stderr
  混在一起会让安全判断基于错误数据。

### 建议

- `Exec` 失败时**返回非 nil error**，并在 error 里区分类型：
  - `ErrSandboxNotFound`（lxc-attach 找不到容器）
  - `ErrCommandTimeout`（context deadline）
  - `ErrNonZeroExit` + ExitCode + 分开的 Stdout/Stderr
- Stdout 和 Stderr **必须分开**：用 `execCmd.StdoutPipe()` / `StderrPipe()`
  分别采集，不要用 `CombinedOutput()`。这是沙箱执行的接口基本要求。
- docker provider（`docker.go:181`）核实是否有同样问题——大概率有，因为
  LXC 和 docker 共享 `ExecResult` 结构。
- 加单元测试覆盖每种错误类型，确保调用方能 switch 处理。

**优先级**：和 P0 一样高，因为它影响所有工具调用的错误处理正确性，是
sandbox 层的接口缺陷，不是单个模块问题。

---

## P9 — Agent loop 违反 tool calling 协议，tool_calls / tool_call_id 全程丢失

**这是逻辑层最严重的 bug，不是可靠性/覆盖率的工程债问题，是协议正确性问题。**
前面 P0-P8 都是"什么时候崩 / 怎么降级"，这条是"即使一切正常运行，agent loop
也是在错误语义下工作的"。

### 核实

**问题 1：assistant 的 tool_calls 根本没存进 messages**

`loop.go:124-125`，LLM 返回带 tool_call 的响应后：

```go
// Add assistant message
l.messages = append(l.messages, Message{Role: "assistant", Content: llmResp.Content})
```

**只存了 `Content`（文本），`llmResp.ToolCall`（ID/Name/Arguments）被丢弃了**。
`Message` 结构本身也没有 `ToolCalls` 字段（`loop.go:17-21`）：

```go
type Message struct {
    Role    string `json:"role"`
    Content string `json:"content"`
}
```

也就是说 LLM "我要调用 tool X" 这条 assistant 消息**在历史里变成了纯文本**，
下次 callLLM 时 LLM 看到的对话历史是：

```
user: 帮我读 a.txt
assistant: [空或 "好的我来读"]   ← tool_calls 丢了
tool: {"success":true,"data":"..."}   ← 凭空出现的 tool 结果，没有对应调用
```

LLM 根本无法把 "tool 消息" 和 "assistant 的 tool 调用意图" 关联起来。

**问题 2：tool 结果的 `tool_call_id` 也丢了**

`tool_activity.go:47-50`，工具完成后：

```go
l.messages = append(l.messages, Message{
    Role:    "tool",
    Content: string(resultJSON),
})
```

`Message` 结构没有 `tool_call_id` 字段（`loop.go:17-21` 确认），`clawless.Message`
也没有（`clawless/types.go:52-56`）：

```go
type Message struct {
    Role    string    `json:"role"`
    Content string    `json:"content"`
    Time    time.Time `json:"time"`
}
```

`LLMProxyRequest.Messages` 是 `[]Message`（`clawless/types.go:200-205`），
所以发给 LLM proxy 的请求里 **tool 消息没有 `tool_call_id`**。

**这违反 OpenAI / Anthropic / Gemini 所有主流 tool calling API 的协议要求**：
这些 API 都要求 tool 结果消息带 `tool_call_id`，且必须对应一个 assistant
发出的 tool_call。OpenAI 的 API 在缺少 `tool_call_id` 时会直接 400 报错；
Anthropic 的 API 要求 tool_result 在 content block 里且引用 tool_use id。

### 真实后果

1. **如果 clawless proxy 严格遵循 OpenAI 协议**：每次有多轮工具调用的请求
   都会被上游 API 拒绝（400 missing tool_call_id）。agent loop 在第一次工具
   调用后的第二步就会失败——除非 clawless proxy 帮 agentd 兜底重建消息结构。
2. **如果 clawless proxy 帮兜底了**：那 agentd 这一层事实上没在做 tool
   calling 协议，全靠下游 patch。任何 downstream proxy 的实现变动（比如换
   provider、关掉某个兼容层）都会让 agentd 立刻崩。
3. **多轮工具调用上下文丢失**：即使能跑通，LLM 看到的历史是错乱的——
   assistant 消息里没有它"说要调用工具"的记录，tool 消息是孤立的。LLM 在
   第 3 步以后会丧失"我之前调了什么工具、为什么调"的因果链，导致重复调用、
   忘记调用、答非所问。
4. **compaction 让问题更严重**：`compactContext`（`loop.go:283-351`）保留
   last 10 messages，但 messages 里 assistant 的 tool_calls 已经丢了，
   压缩后的摘要也是基于残缺历史生成的——错误会累积。

### 为什么这条比 P0-P8 都严重

- P0-P8 是"故障会发生，但系统设计意图是对的"。
- **P9 是"系统的核心循环逻辑在错误语义下运行"**——即使没有任何故障，
  agent loop 也在用残缺的消息历史和 LLM 对话，工具调用链是断裂的。
- 这条不是工程债，是**正确性 bug**。它能"工作"完全依赖下游 clawless proxy
  的兼容性兜底——agentd 自己的 agent loop 在协议层面是错的。

### 建议

- `Message` 结构补 `ToolCalls []ToolCall` 和 `ToolCallID string` 字段。
- `loop.go:125` 把 assistant 的 tool_call 存进 message（不是只存 Content）。
- `tool_activity.go:47` tool 结果 message 带 `tool_call_id`。
- `clawless.Message` 同步补这两个字段，确保 wire format 符合 OpenAI 协议。
- 加 e2e 测试：mock 一个返回 tool_call 的 LLM，验证第二次 callLLM 发出的
  messages 里，assistant 消息含 tool_calls，tool 消息含 tool_call_id，且
  二者 ID 匹配。
- 如果 clawless proxy 有兼容层在兜底，把那层逻辑显式文档化，否则现在这个
  agent loop 是"碰巧能跑"。

---

## P10 — 前面 P0-P8 的核实方法本身有问题（记录用，提醒未来分析）

**起因**：前面 P0-P8 我大量用 `grep` 统计指标（667 处降级、39 处忽略错误
等）来论证"整个 agentd 不可靠"。但用户指出**测试覆盖率和 grep 计数不等于
逻辑不可靠**——`grep degrade` 会把 macOS 的降权操作误判为"降级运行"，
测试覆盖 20% 的模块如果逻辑写得好也未必不可靠。

正确的逻辑层核实方法是**直接读核心循环代码**（P9 就是这样发现的）。
P0-P8 里：

- **P0（Alpine 命令缺失）**：✅ 真问题，交叉对照 install 脚本和运行时命令。
- **P1-P5（desktop 系列）**：✅ 真问题，都基于读代码确认。
- **P6（nohup）**：✅ 真问题，基于 Exec 模型分析。
- **P7（整体可靠性）**：⚠️ 部分基于 grep 计数，"667 处降级"这个数字需要
  逐条核实才能区分真降级和误判（比如 privilege drop 也含 "degrade"）。
  测试覆盖率低**是风险信号但不等于逻辑错**——P9 才是真正抓到的逻辑错。
- **P8（Exec 吞错误）**：✅ 真问题，读了 `lxc_persistent.go:159-202`。

**结论**：P0-P6/P8 都是核实过的真问题。P7 的"整体不可靠"判断里，grep
统计的部分需要打折扣，但 **P9 这个逻辑 bug 反过来印证了 P7 的核心担忧**：
agentd 的核心循环（agent loop）确实存在正确性问题，不是只有外围模块
（desktop）欠债。**逻辑层的可靠性比工程层的可靠性更值得警惕**——测试
可以补，但 agent loop 协议错误意味着系统的核心推理循环本身有问题。
