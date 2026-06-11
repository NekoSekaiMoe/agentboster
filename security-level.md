# AgentBoster 安全等级详解

## 什么是 AgentBoster 安全系统？

AgentBoster 实现了一套**三层安全审查流水线**（代号 "Gatekeeper"），每一个工具调用和每一段 LLM 输出在执行前都必须通过这三层审查。

你可以把 Gatekeeper 理解为云端大语言模型的"守门员"——它在命令执行前逐层判断。它结合了**确定性规则**（L0）、**AI 风险评估**（L1）和**用户授权**（L2），形成纵深防御。

与 Manboster 的 Hachimi 不同，AgentBoster **不依赖单一模型做最终裁决**，而是将决策权交还给用户。

## 安全架构总览

```
用户请求
    │
    ▼
┌──────────────────┐
│   Web 中间件      │  HMAC-SHA256 Cookie 认证 / AGENTD_API_KEY
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Agent 循环      │  think → act → observe
└────────┬─────────┘
         │
    ┌────┴────┐
    │ 输出审计 │  L0 输出规则 + L1 输出评分
    └────┬────┘
         │
         ▼
┌──────────────────┐
│  Gatekeeper.Audit │
│  ┌─────────────┐ │
│  │ L0 规则引擎  │ │  正则匹配，硬拦截
│  └──────┬──────┘ │
│         │ pass   │
│  ┌──────▼──────┐ │
│  │ L1 AI 评分   │ │  LLM 风险评分 0.0-1.0
│  └──────┬──────┘ │
│         │ high   │
│  ┌──────▼──────┐ │
│  │ L2 用户授权  │ │  Web 界面 用户批准/拒绝
│  └─────────────┘ │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   沙箱执行        │  Docker Light / Docker Strict / LXC
│  + OS 强制策略    │  seccomp + capability drop + 隔离
└──────────────────┘
```

## 三层安全详解

### 第零层（L0）—— 规则引擎：确定性拦截

L0 是一个**纯正则/glob 匹配引擎**，不涉及任何 LLM 调用。它的职责是：对已知危险命令进行**即时硬拦截**。

#### 工作原理

每个 L0 规则包含：

| 字段 | 说明 |
|------|------|
| `ID` | 规则标识符，如 `cmd-rm-rf-root` |
| `Pattern` | 正则或 glob 模式 |
| `Type` | `command`（命令）、`path`（路径）或 `network`（网络） |
| `Action` | 仅支持 `block`（拦截） |
| `Scope` | `workspace`（沙箱内）或 `global`（全局） |

匹配采用**两级级联**：先 glob 匹配（速度快），再正则匹配（更灵活）。

#### 内置规则（30+ 条）

**命令黑名单（19 条）：**

| 规则 | 拦截内容 |
|------|---------|
| `rm -rf /`, `rm -rf /*` | 根文件系统销毁 |
| `mkfs.*` | 格式化文件系统 |
| `dd if=.* of=/dev/` | 原始磁盘写入 |
| `fdisk`, `wipefs` | 磁盘操作 |
| `curl.*\|.*bash`, `wget.*\|.*sh` | 远程代码执行 |
| `sudo\s`, `su\s+-` | 权限提升 |
| `chmod\s+777`, `chown\s+root` | 权限滥用 |
| `shutdown`, `reboot` | 系统关机 |
| `killall`, `pkill` | 进程终止 |
| `iptables\s+-F` | 防火墙清除 |
| `nc\s+-l`, `ncat\s+-l` | 网络监听 |
| `python\s+-m\s+http\.server` | HTTP 服务器 |

**路径黑名单（7 条）：**

| 路径 | 说明 |
|------|------|
| `/etc/shadow` | 密码哈希 |
| `/etc/passwd` | 用户信息 |
| `/etc/ssh/` | SSH 配置 |
| `/proc/`, `/sys/` | 内核接口 |
| `/root/.ssh/`, `~/.ssh/` | SSH 密钥 |

**网络黑名单（3 条）：**

| 工具 | 说明 |
|------|------|
| `nmap` | 网络扫描 |
| `masscan` | 大规模端口扫描 |
| `hydra` | 暴力破解 |

#### 输出安全规则（6 条）

L0 同时检查 LLM **输出**内容，防止：

- 系统提示词泄露（中英文模式匹配）
- 指令注入（"ignore previous instructions"、"DAN mode"）
- 凭据暴露（API key、密码、私钥正则匹配）
- 内部路径泄露（`/etc/shadow`、`/proc/self/environ`）

#### 欺骗机制

当 L0 拦截命令时，返回的是**伪造的 OS 错误**，而非安全层消息：

```
sh: rm: Operation not permitted
```

LLM 看到的是操作系统级别的错误，而非"L0 规则匹配"——这保护了安全系统的抽象层。

#### 热重载

L0 规则通过 `Loader` 从 Web API 定期同步（每 5 分钟），支持动态更新规则而无需重启守护进程。

---

### 第一层（L1）—— AI 评分：LLM 风险评估

L1 是一个**基于 LLM 的风险评分系统**，对命令进行 0.0-1.0 的连续评分。

#### 工作原理

守护进程将命令发送到 Web API `/api/agentd/v1/l1-score`，Web 层调用 Vercel AI SDK 的 `generateObject()` 获取结构化 JSON 输出。

#### 评分维度（10 项）

LLM 从以下维度评估命令风险：

| # | 维度 | 说明 |
|---|------|------|
| 1 | 沙箱外文件修改 | 尝试修改 /etc, /sys, /proc |
| 2 | 敏感路径访问 | ~/.ssh, /etc/shadow |
| 3 | 远程代码执行 | curl \| bash |
| 4 | 权限提升 | sudo, chmod 777, su |
| 5 | 凭据暴露 | 环境变量、密钥文件 |
| 6 | 破坏性操作 | rm -rf, mkfs, dd |
| 7 | 网络扫描/横向移动 | nmap, 端口扫描 |
| 8 | 多重可疑操作链 | 组合多步攻击 |
| 9 | 沙箱逃逸尝试 | mount, ptrace, /proc/self/exe |
| 10 | 路径穿越 | ../.. 访问沙箱外 |

#### 风险等级

| 等级 | 分数范围 | 处理方式 |
|------|---------|---------|
| `low` | 0.0 - 0.39 | 静默放行 |
| `medium` | 0.4 - 0.69 | 放行但通知用户 |
| `high` | 0.7 - 0.89 | 需要 L2 用户授权 |
| `critical` | 0.9 - 1.0 | 需要 L2 高危授权 |

#### 确定性 L2 模式（硬编码保护）

即使 LLM 给出 `low` 评分，以下模式**强制升级为 high**，绕过 AI 判断：

| 模式 | 原因 |
|------|------|
| `shred` | 使用 shred 覆写文件内容 |
| `find -exec rm/shred/dd` | find 配合破坏性命令 |
| `find -delete` | 批量删除 |
| `xargs rm/shred/dd` | 管道传入破坏性命令 |
| 解释器单行脚本（破坏性） | Python/Ruby 一行式文件系统破坏 |

#### 失败策略

- **默认失败关闭**（`fail_open = false`）：L1 不可用时，命令评分默认为 `high`（0.8），强制要求 L2 授权
- **可配置为失败开放**：设置 `fail_open = true` 后，L1 错误时放行命令

#### 批量评分

对 `exec_batch`，命令在**单次 LLM 调用**中批量评分，带有跨命令上下文。设有 token-bomb 防护（4096 字符上限），超出后回退为逐条评分。

---

### 第二层（L2）—— 用户授权：人类最终裁决

L2 是**人在回路**的最终安全层——当 L1 判定命令为 `high` 或 `critical` 时，用户必须亲自批准或拒绝。

#### 工作流程

1. 守护进程发布 `EventL2AuthRequired` 到事件总线
2. Web 界面显示 "允许 / 拒绝" 提示，附带命令 diff 预览
3. 用户点击后，Web 调用 `POST /api/v1/l2-confirm`
4. 四种操作：`pass_once`、`pass_until`（带时长）、`reject_once`、`reject_until`
5. 决策缓存到内存，带可配置 TTL
6. 守护进程恢复或取消任务

#### 缓存策略

| 时长 | 说明 |
|------|------|
| `once` | 不缓存，一次性授权 |
| `always` | 会话生命周期缓存（到期时间设为 9999 年） |
| `hhddmmyy` | 自定义 TTL 格式（如 `01000000` = 1 小时） |

缓存键由 SHA-256 哈希组合：`UserID + SessionID + ToolName + ArgsHash + SandboxID + PolicyVersion + UserType`。策略版本变更时自动失效所有缓存。

#### 命令审查预览

用户在批准前看到 **diff 风格的命令预览**，高亮危险片段：

```
命令 diff 预览：
! rm -rf /tmp/build
+ cd /workspace
! sudo apt-get install -y build-essential
! L2 level=high score=0.8
! 原因: 使用 sudo 进行权限提升
```

`!` 标记危险片段（shred、mkfs、rm -rf、sudo、curl|bash 等），`+` 标记安全片段。

#### 决策队列特性

- 跨任务决策**串行化**；同任务决策可**并发**（最多 3 个）
- 默认超时 **3 分钟**；L2 请求超时 **5 分钟**
- 状态生命周期：`PENDING` → `SENT` → `RESOLVED` / `EXPIRED` / `TIMEOUT`
- 后台每 5 秒检查超时

---

## 沙箱隔离

AgentBoster 提供**三种沙箱类型**，根据任务风险自动选择：

### Docker Light（默认）

日常任务的轻量沙箱：

```
--rm                              # 自动清理
--cpus 0.25                       # 四分之一 CPU
--memory 256m                     # 256MB 内存
--cap-drop ALL                    # 丢弃所有能力
--security-opt no-new-privileges  # 禁止提权
--read-only                       # 只读根文件系统
--tmpfs /tmp:size=128m            # 可写 /tmp
--tmpfs /workspace:size=512m      # 可写 /workspace
```

### Docker Strict（高风险）

最强隔离，用于不可信/高风险代码：

```
--network none                    # 无网络访问
--memory 512m                     # 512MB 内存
--cpus 1.0                        # 1 核 CPU
--pids-limit 128                  # 进程数限制
--security-opt no-new-privileges  # 禁止提权
--cap-drop ALL                    # 丢弃所有能力
--read-only                       # 只读根文件系统
--tmpfs /tmp:size=256m
--tmpfs /workspace:size=512m
```

额外特性：镜像白名单验证 + 自定义 seccomp 配置文件。

### LXC Persistent（持久化环境）

用于需要跨会话持久状态的任务（构建、包安装）：

- 完整 init 系统支持
- Cgroup CPU/内存限制
- OS 安全配置写入 LXC 配置文件
- 持久化 rootfs（默认 alpine 3.21）

### 自动选择逻辑

| 条件 | 选择的沙箱 |
|------|-----------|
| 用户显式设置 | 使用用户指定的沙箱 |
| 高风险命令 | Docker Strict |
| 需要持久化的命令（git clone, npm install） | LXC |
| 守护进程默认配置 | 使用配置的默认值 |
| 兜底 | Docker Light |

### 权限配置文件

| 配置文件 | 沙箱类型 | 网络 | 用途 |
|---------|---------|------|------|
| `default` | Docker Light | 隔离 | 日常任务 |
| `strict` | Docker Strict | 隔离 | 高风险/不可信 |
| `network` | Docker Light | 启用 | 需要网络 |
| `package-install` | LXC | 启用 | 安装包 |
| `browser` | LXC | 启用 | 浏览器自动化 |
| `persistent` | LXC | 隔离 | 持久化工作区 |

---

## OS 级强制策略

除了沙箱容器隔离，AgentBoster 还在操作系统层面实施强制策略，由 L0 规则自动派生：

### Seccomp 配置文件

阻止 15+ 类危险系统调用：

| 类别 | 被阻止的系统调用 | 动作 |
|------|----------------|------|
| 内核模块加载 | `init_module`, `finit_module`, `delete_module` | ERRNO |
| 内核执行 | `kexec_load`, `kexec_file_load` | ERRNO |
| 关机/重启 | `reboot` | ERRNO |
| 挂载操作 | `mount`, `umount2`, `pivot_root` | ERRNO |
| 进程追踪 | `ptrace`, `process_vm_readv`, `process_vm_writev` | ERRNO |
| 交换分区 | `swapon`, `swapoff` | ERRNO |
| 命名空间创建 | `unshare`, `clone3` | ERRNO |
| BPF/JIT | `bpf`, `perf_event_open` | ERRNO |
| 密钥环操作 | `add_key`, `request_key`, `keyctl` | ERRNO |
| 内存绕过 | `memfd_create` | ERRNO |
| 命名空间逃逸 | `setns` | ERRNO |
| 终端注入 | `ioctl` + `TIOCSTI` (0x5412) | ERRNO |

### Linux 能力管理

**丢弃的能力（31 项）：**
`CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_SYS_RAWIO`, `CAP_SYS_BOOT`, `CAP_SYS_MODULE`, `CAP_NET_ADMIN`, `CAP_NET_RAW`, `CAP_MKNOD`, `CAP_SYS_CHROOT`, `CAP_BPF`, `CAP_PERFMON`, `CAP_SYSLOG` 等。

**保留的能力（10 项）：**
`CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_FSETID`, `CAP_SETGID`, `CAP_SETUID`, `CAP_SETPCAP`, `CAP_NET_BIND_SERVICE`, `CAP_KILL`, `CAP_SETFCAP`。

### 路径保护

- **Masked paths**：`/dev/null` 绑定挂载覆盖敏感文件（`/etc/shadow`、`/etc/passwd`）
- **Read-only paths**：`/proc`、`/sys` 以只读方式挂载
- **网络隔离**：默认启用 `NetworkNone`

---

## 通信安全

### mTLS 双向认证

守护进程与 Web 之间使用 **ECDSA P-384** 证书的双向 TLS 认证：

| 证书 | 有效期 | 用途 |
|------|--------|------|
| CA 证书 | 10 年 | 自签名根 CA |
| 服务端证书 | 1 年 | 守护进程监听（localhost/127.0.0.1） |
| 客户端证书 | 1 年 | Web → 守护进程通信 |

### API Key 认证

双方交换 API Key 进行额外认证：

- Web 发送 `AGENTD_API_KEY` 环境变量
- 守护进程发送 `clawless_api_key`
- 支持 `X-API-Key` 头或 `Authorization: Bearer` 头
- 使用**恒定时间比较**防止时序攻击

### 权限下降

守护进程启动时需要 root 权限（用于 cgroup/命名空间设置），初始化完成后**自动下降到非特权用户**：

1. 通过 `getent passwd` 解析用户
2. 设置补充组（`syscall.Setgroups`）
3. 降低 GID → UID（顺序不可逆）
4. 验证已非 root，否则中止

---

## 工具安全

### 路径穿越防护

所有文件操作工具（`read`, `write`, `edit`, `ls`, `glob`）调用 `safePath()` 验证路径不超出工作区边界：

```go
func safePath(workspace, userPath string) (string, error) {
    clean := filepath.Clean(filepath.Join(workspace, userPath))
    if !strings.HasPrefix(clean, filepath.Clean(workspace)+string(os.PathSeparator)) &&
       clean != filepath.Clean(workspace) {
        return "", fmt.Errorf("path traversal denied: %q escapes workspace", userPath)
    }
    return clean, nil
}
```

### Shell 注入防护

Git 和包管理工具使用 `safeShellArg` 正则验证所有输入：

```go
var safeShellArg = regexp.MustCompile(`^[a-zA-Z0-9_./:@=+,-]+$`)
```

### 输出审计

LLM 的每一段输出都经过 `AuditOutput()` 检查：

1. L0 输出规则检测凭据泄露、系统提示词泄露
2. L1 输出评分检测异常内容
3. 高危/严重输出**直接拦截**（不放行）

### 限制参数

| 参数 | 值 | 说明 |
|------|-----|------|
| `exec_batch` 最大命令数 | 16 | 防止批量滥用 |
| L1 批量 token-bomb 防护 | 4096 字符 | 超出后逐条评分 |
| CodeAct 最大轮次 | 30 | 硬性上限 |
| Web fetch 响应大小 | 1MB | 防止内存耗尽 |
| 后台任务输出尾部 | 4KB | 防止内存耗尽 |

---

## 与 Manboster 的安全差异

> NOTE
>
> AgentBoster 的安全哲学源自 Manboster。Manboster 的 Hachimi 守门员证明了 AI 可以评估工具调用的安全性。AgentBoster 借鉴了这一理念，但走了不同的路线。

### 核心理念对比

| 维度 | Manboster (Hachimi) | AgentBoster (Gatekeeper) |
|------|---------------------|--------------------------|
| **信任对象** | 信任 AI 模型 | 信任用户 |
| **裁决者** | Hachimi 模型（本地） | 三层流水线 + 用户最终裁决 |
| **架构** | 单层守门员 | 三层纵深防御（L0 → L1 → L2） |
| **模型角色** | 最终决策者 | 风险评估辅助 |

### 安全层对比

| 安全层 | Manboster | AgentBoster |
|--------|-----------|-------------|
| **L0 规则** | 无 | 30+ 条正则/glob 规则，确定性拦截 |
| **L1 AI 评分** | Hachimi 模型（Qwen3Guard 0.6B） | 通用 LLM（gpt-4o-mini）10 维度评分 |
| **L2 用户授权** | 无（Hachimi 自行决定） | 人在回路，用户批准/拒绝 |
| **确定性保护** | 无 | 6 种模式强制升级，绕过 AI 评分 |
| **失败策略** | 回退到人工处理 | 可配置失败关闭/开放 |

### 沙箱对比

| 维度 | Manboster | AgentBoster |
|------|-----------|-------------|
| **容器隔离** | 无 | Docker Light / Docker Strict / LXC |
| **OS 强制** | 无 | seccomp + 31 项能力丢弃 + 路径保护 |
| **网络隔离** | 无 | 默认隔离，可配置 |
| **权限下降** | 无 | root → 非特权用户自动下降 |

### 模型运行方式

| 维度 | Manboster (Hachimi) | AgentBoster (L1) |
|------|---------------------|------------------|
| **运行位置** | 设备端本地（llama.cpp + FFI） | 云端 Web API |
| **模型** | Qwen3 Guard Gen 0.6B（专用守门员） | gpt-4o-mini（通用模型） |
| **格式** | GGUF | 通过 Vercel AI SDK 调用 |
| **内存占用** | 150MB - 850MB（取决于上下文） | 由云端承担 |
| **延迟** | 本地推理，毫秒级 | 网络调用，秒级 |
| **离线可用** | 是（本地 GGUF 模型） | 否（依赖云端 API） |
| **懒加载** | 是（15 分钟空闲自动卸载） | N/A |

### 决策模型对比

**Manboster 的方式：**
```
工具调用 → Hachimi 模型评估 → 安全/不安全 → 执行或挂起
```
Hachimi 是一个 0.6B 参数的专用守门员模型，在本地运行，对每个工具调用进行二元判断（安全/不安全）。如果判断为不安全，交给用户处理。

**AgentBoster 的方式：**
```
工具调用 → L0 正则匹配 → L1 LLM 评分 → L2 用户授权 → 执行
         （即时拦截）   （风险量化）   （人类裁决）
```
AgentBoster 使用通用 LLM（非专用模型）进行风险量化评分（0.0-1.0），但最终裁决权在用户手中。

### 安全哲学总结

> **Manboster 相信 Hachimi；AgentBoster 相信用户。**

Manboster 的 Hachimi 是一个"AI 法官"——它在本地执行前先进行判断，能有效降低单一模型产生的幻觉问题，但无法应对高级且复杂的提示词工程攻击。

AgentBoster 的 Gatekeeper 是一个"多层防线"——L0 规则处理已知威胁（零成本），L1 AI 评分处理未知威胁（量化风险），L2 用户授权处理高危决策（人类判断）。三层互补，任何单一层面的失败都不会导致安全事故。

AgentBoster 额外增加了：
- **确定性 L2 模式**：即使 AI 被骗，已知危险模式仍会被强制拦截
- **OS 级强制**：seccomp + capability drop，即使沙箱逃逸也有最后一道防线
- **mTLS + API Key**：守护进程与 Web 之间的双向认证
- **权限下降**：最小权限原则，初始化后不再使用 root
- **输出审计**：不仅检查命令，还检查 LLM 输出（防泄露、防注入）
