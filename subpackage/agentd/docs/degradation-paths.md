# agentd 降级路径清单（P7 audit 产出）

> 本文件由 P7 可靠性审计生成，作为后续补测试 / 改 fatal 的基线清单。
> 每一条都是**运行时** "失败被吞、继续执行" 的代码路径（不是纯注释）。
> 目标：每条要么有一个故意触发的 e2e 测试，要么被改成 fatal。

## 现状（截至 fix/all 分支）

共 **5 处** 运行时降级路径（grep `slog.Warn.*continuing|best-effort|degrade` 的命中，排除测试文件）：

### 1. desktop: mkdir state dir 失败 — Debug + 继续
- **位置**：`internal/agent/desktop/desktop.go` `ensureInstalled` 内
- **后果**：若 `/tmp/agentd-desktop` 创建失败，install 脚本会自己报错；此处 Debug 级别合理。
- **判断**：✅ 可接受（install 脚本自身会 surface 错误）。保留。

### 2. desktop: dbus/at-spi launch 失败 — Warn + 降级 a11y
- **位置**：`internal/agent/desktop/desktop.go` `startStack` 内
- **后果**：`desktop_inspect` / `desktop_a11y_click` / `desktop_a11y_type` 不可用；截图/点击仍工作。
- **判断**：⚠️ 需测试。已由 P5 的方向覆盖（降级标记 + LLM context）。

### 3. desktop: icewm 启动失败 — Warn + 降级到 raw X
- **位置**：`internal/agent/desktop/desktop.go` `startStack` 内
- **后果**：多窗口应用在 (0,0) 叠加、无焦点管理；a11y 树可能不准。
- **判断**：⚠️ P5 已修正注释 + 加 `degraded=wm-missing` 标记 + 加测试。

### 4. loop: compaction 失败 — Warn + 继续
- **位置**：`internal/agent/loop.go` `Run` 主循环内
- **后果**：消息历史不压缩，继续跑；最坏情况是 token 超限。
- **判断**：✅ 可接受（compaction 本身是优化，非正确性）。保留，但应加 retry 计数避免每步都失败重试。

### 5. worker: workspace 创建失败 — Warn + 继续无 workspace
- **位置**：`internal/worker/dispatcher.go` 任务派发
- **后果**：任务跑但没有 workspace 元数据记录。
- **判断**：⚠️ 需评估。workspace 是组织单元，缺失会影响任务可见性但不影响执行。

## 乐观注释清单（P7 建议项5）

grep `still works|usable|is reliable|always works|guaranteed|is safe` 的命中（排除安全模块的合理用法）：

| 位置 | 原文 | 状态 |
|---|---|---|
| `desktop.go:467` | "raw X without a WM is still usable for full-screen apps" | P5 已修正为准确表述 |
| `desktop.go:463` | "so the noVNC view is usable" | 描述正常路径，保留 |
| `browser/node_install.sh:66` | "so skipping the require is safe" | 描述特定文件跳过逻辑，需独立核实 |
| `security/privilege.go:174` | "Decide whether following it is safe based on the parent" | 描述算法意图，合理 |

## 不在本 PR 范围（明确排除）

P7 的以下子项**仍不在本 PR 处理**（已重新评估，见下方"已重新评估"部分）：

- ~~**建议项1（测试覆盖率到 40%）**~~：**已部分修复** — 给 P8 的 sandbox Exec
  补了真正的集成测试（`docker_exec_test.go`，用 fake docker 二进制验证 streams
  分离 + timeout 分类），os_enforce 补了 3 个测试。但全面达到 40% 仍需独立 effort。
- ~~**建议项4（os_enforce 深度评估）**~~：**已评估并修补** — 加了 `BaselineMaskedPaths`/
  `BaselineReadonlyPaths`（空 L0 也有基线）+ 3 个测试 + 定位文档
  `docs/os_enforce-positioning.md`。更深的提升（allowlist seccomp / 用户态 syscall
  过滤）明确为独立 effort。

真正仍排除的：

- **全面测试覆盖率到 40%**：agent/server/worker/lsp 等模块仍需数千行测试，
  本 PR 只补了 P8/os_enforce 的关键路径测试。应作为分批的独立 effort。
- **allowlist seccomp / 用户态 syscall 过滤**：量级数万 LOC，需先明确产品定位。

## 本 PR 已完成的 P7 部分

- ✅ 建议项2（降级路径清单）：本文件即为清单产出。
- ✅ 建议项3（shell 拼接审计）：browser.go CloseBridge 加引号转义；desktop.go 的 shell 拼接由 P3/P4 清理。
- ✅ 建议项5（注释审查）：desktop.go 的乐观注释由 P5 修正；其余命中已评估。
- ✅ **建议项1（关键路径集成测试）**：给 P8 的 sandbox Exec 补了 `docker_exec_test.go`
  （fake docker 二进制验证 streams 分离 + timeout 分类），抓出并修复了一个真实的
  timeout 误分类 bug（SIGKILL 被 ExitError 抢先匹配）。
- ✅ **建议项4（os_enforce 深度评估）**：加 `BaselineMaskedPaths`/`BaselineReadonlyPaths`
  + 3 个测试 + 定位文档 `docs/os_enforce-positioning.md`。
- ✅ **附带（hostGitBackend 超时）**：`checkpoint.go` 的 host git 操作无超时是
  checkpoint 测试 flaky 的根因，也是生产环境 agent loop 可能卡住的降级路径。
  加了 `hostGitTimeoutSec=30s`。
