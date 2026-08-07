# os_enforce 安全定位（P7 audit 产出）

> 回应可靠性审计 P7 建议项 4："os_enforce 481 LOC，远不如专业容器运行时的隔离深度"。
> 本文不回避这个问题，给出诚实定位 + 已采取的措施 + 明确的不在范围项。

## 诚实定位

agentd 的 `os_enforce`（seccomp + capabilities + masked/readonly paths）**不是**一个独立的
容器运行时安全边界，**而是**在 Docker / LXC 已经提供的隔离之上加的一层"收紧 + L0 规则
动态映射"。

### 它是什么

- **capabilities**：drop 31 个危险 cap（SYS_ADMIN/SYS_PTRACE/NET_ADMIN/NET_RAW/MKNOD 等），
  keep 10 个功能性 cap（CHOWN/DAC_OVERRIDE/FOWNER 等，构建工具需要）。这是标准的
  "drop-all-except-baseline" 策略，量级与 Docker 默认 profile 相当。
- **seccomp**：16 组规则，阻挡模块加载 / 内核执行 / ptrace / namespace 创建 / BPF /
  keyring / memfd_create / TIOCSTI 等关键攻击面。合理基线，但**不是** gVisor 那种
  完整用户态 syscall 实现。
- **masked/readonly paths**：L0 规则动态生成 + **基线（Docker 默认的内核信息泄露向量）**
  合并。基线覆盖 `/proc/kcore`、`/proc/sched_debug`、`/sys/firmware`、`/etc/ssh`、
  `/root/.ssh` 等，即使 L0 规则为空也生效。

### 它不是什么

- **不是 gVisor / Firecracker 级别的隔离**。那些是完整的用户态 syscall 实现 / 微 VM，
  量级是数万到数十万 LOC。agentd 的 seccomp 是 blocklist（阻挡已知危险 syscall），
  不是 allowlist（只放行已知安全 syscall），更不是用户态内核。
- **不是 Kata Containers / nsjail 那种独立沙箱运行时**。agentd 依赖 Docker / LXC 提供
  namespace + cgroup 隔离，os_enforce 只是在这个基础上收紧。

### 为什么这个定位是合理的

agentd 的威胁模型是**半可信的 agent 执行用户授权的代码**，不是"运行不可信的恶意二进制"。
- Docker/LXC 的 namespace + cgroup 已经提供了进程/网络/文件系统隔离的主边界。
- os_enforce 在此基础上：阻挡 agent 被 prompt injection 后执行 `modprobe`/`mount`/`ptrace`
  这类提权操作；屏蔽内核信息泄露向量。
- 真正的不可信代码应该跑在 `docker-strict` profile（独立网络 + cap-drop ALL + seccomp），
  而非依赖 os_enforce 单独兜底。

## 本次（fix/all）采取的措施

### 1. BaselineMaskedPaths / BaselineReadonlyPaths（新）

之前 masked/readonly paths 完全从 L0 path 规则派生 —— 如果 L0 规则没覆盖某个内核信息
泄露向量（`/proc/kcore`、`/sys/firmware` 等），就有缺口。现在加入与 L0 规则无关的基线：

```go
BaselineMaskedPaths()  // /proc/kcore, /proc/sched_debug, /sys/firmware, /etc/ssh, ...
BaselineReadonlyPaths() // /proc, /sys
```

`FromL0Rules` 总是合并基线，即使 L0 规则集为空。测试
`TestFromL0Rules_AppliesBaselineEvenWithNoPathRules` 锁定这一行为。

### 2. 测试覆盖（新）

之前 os_enforce 0 个测试文件。新增 `policy_test.go`：
- `TestBaselineMaskedPaths_CoversKeyInfoLeaks`：锁定关键信息泄露向量
- `TestFromL0Rules_AppliesBaselineEvenWithNoPathRules`：锁定"空 L0 也有基线"
- `TestDangerousCaps_CoversEscapePrimitives`：锁定关键 cap 被 drop

### 3. 安全定位文档（本文）

明确"是什么 / 不是什么"，避免对 os_enforce 的隔离深度产生错误预期。

## 明确不在范围（需要独立 effort）

以下提升是真实的但工作量大，不在本 PR：

1. **seccomp 从 blocklist 转 allowlist**：当前是"阻挡危险 syscall"，更安全的模式是
   "只放行已知安全 syscall"。需要枚举 agentd 所有合法 syscall 路径，工作量与
   Docker 默认 seccomp profile 相当（~300 行 JSON），且容易误伤。可作为 follow-up。

2. **用户态 syscall 过滤（gVisor 模式）**：量级数万 LOC，相当于嵌入一个用户态内核，
   超出 agentd 定位。如果需要这个级别的隔离，应该直接用 gVisor runtime，而非在
   agentd 内重新实现。

3. **file access allowlist（nsjail 模式）**：当前用 masked/readonly paths + L0 path 规则，
   没有完整的文件系统访问白名单。需要 per-sandbox 的文件访问策略，涉及 L0 规则引擎
   重构。

## 结论

os_enforce 的定位是"Docker/LXC 隔离之上的 L0 驱动收紧层"，不是独立的安全边界。
本 PR 修补了"基线缺口"（空 L0 也有 masked/readonly）并补了测试和文档。
更深的提升（allowlist seccomp / 用户态 syscall 过滤）需要独立 effort，
且应先明确产品定位是否需要。
