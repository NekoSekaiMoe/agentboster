---
name: bug-hunter-stage2-parallel-review
description: bug-hunter 阶段 2 技能。负责将随机化后的 diff 按 persona 矩阵分发给 8 个子智能体评审，并收集统一 JSON 结果。
---

# Stage 2 并行评审

## 执行模式选择

读取当前环境能力后选择执行路径：

```
当前环境支持并行 Agent 调度？
  ├─ 是 → 并行模式：在单次响应中并行调用 Agent 工具 8 次
  └─ 否 → 串行模式：逐个 persona 调用，每次调用完成后收集结果，再启动下一个
```

两种模式**产出相同**：`artifacts/raw_findings.json`。

## 全局约束

- ⚠️ **禁止手工编写 findings**
- ⚠️ **禁止跳过评审直接构造 raw_findings.json**
- ⚠️ **禁止使用自己分析代替 persona 评审**
- 每个 Agent/轮次 必须从 `shuffled_passes.json` 的 `passes[*]` 中随机选择 1 个 pass
- 允许不同 persona 抽到同一个 pass，但禁止所有 persona 共用同一个 pass
- 必须记录每个 persona 实际使用的 `pass_id`

## 角色矩阵（固定 8 个）

| # | 角色名 | 权重 | 关注领域 |
|---|--------|------|---------|
| 1 | Security Sentinel | 5.0 | 权限边界、输入校验、越界访问、信息泄漏、路径遍历、注入面 |
| 2 | Concurrency Engineer | 4.0 | 锁顺序、竞态、原子性、可见性、死锁、丢唤醒 |
| 3 | Performance Analyst | 3.0 | 热点路径、复杂度、无谓拷贝、阻塞等待、缓存失效 |
| 4 | Diverse Reviewer A | 2.0 | 核心逻辑正确性、状态迁移、条件分支遗漏 |
| 5 | Diverse Reviewer B | 2.0 | 边界条件、空值/极值、长度与容量、资源上限 |
| 6 | Diverse Reviewer C | 2.0 | 错误处理、返回码传播、回滚与清理路径 |
| 7 | Diverse Reviewer D | 2.0 | Linux 语义一致性、接口契约、行为兼容性 |
| 8 | Diverse Reviewer E | 2.0 | 资源生命周期、引用关系、释放时机、泄漏风险 |

---

## 并行模式（有 Agent 工具时）

### 步骤 1: 准备输入
读取 `shuffled_passes.json`，为 8 个 Agent 各随机分配 1 个 pass_id，记录映射关系。

### 步骤 2: 并行启动 8 个 Agent
在**单次响应**中并行调用 Agent 工具 8 次，每个使用不同 persona 提示词。

每个 Agent 指令要点：
- 你只负责 `[persona 关注领域]`，不要扩展到其他类型的问题
- 输入是随机抽中的 1 份 pass diff
- 纯风格建议（命名偏好、格式）不报告
- 输出纯 JSON 数组

### 步骤 3: 收集并合并
- 等待全部 8 个 Agent 返回
- 验证每个返回是合法 JSON 数组
- 为每条 finding 确保 `agent` 字段正确
- 附加 `pass_id` 元数据
- 合并写入 `artifacts/raw_findings.json`

---

## 串行模式（无 Agent 工具时）

### 步骤 1: 准备输入
读取 `shuffled_passes.json`，为 8 个 persona 各随机分配 1 个 pass_id，记录映射关系。

### 步骤 2: 串行评审
按顺序处理 8 个 persona，每次一个：

**对每个 persona 执行**：
1. 将以下内容作为系统提示：
   ```
   你是 [persona 名称]，权重 [权重]。
   你只关注 [关注领域]。
   纯风格建议不报告。每个发现必须给出 file:line、severity、confidence、fix_code。
   ```
2. 将分配的 pass diff 作为待评审内容
3. 以该 persona 视角评审，生成 findings
4. 将本轮结果追加到临时结果集
5. 继续下一个 persona

### 步骤 3: 合并
- 汇总全部 8 轮结果
- 验证每条 finding 的字段完整性
- 写入 `artifacts/raw_findings.json`

---

## 输出格式

每个 persona 输出纯 JSON 数组：

```json
[
  {
    "file": "path/to/file.py",
    "line": 42,
    "type": "security|concurrency|performance|logic",
    "severity": "critical|major|minor",
    "description": "问题描述",
    "fix_code": "修复代码片段",
    "confidence": 0.9,
    "agent": "Security Sentinel"
  }
]
```

合并后写入 `artifacts/raw_findings.json`：

```json
{
  "schema_version": "1.0",
  "findings": [
    {
      "file": "kernel/src/foo.rs",
      "line": 42,
      "type": "logic",
      "severity": "major",
      "description": "error path forgets to release inode reference",
      "fix_code": "drop(inode);",
      "confidence": 0.81,
      "agent": "Diverse Reviewer E",
      "pass_id": 3
    }
  ]
}
```

## 字段约束

| 字段 | 约束 |
|------|------|
| `file` | 必填，相对路径 |
| `line` | 必填，正整数 |
| `type` | 必填，枚举：security/concurrency/performance/logic |
| `severity` | 必填，枚举：critical/major/minor |
| `description` | 必填，一句话描述 |
| `fix_code` | 建议提供，无则降权 |
| `confidence` | 必填，范围 [0, 1] |
| `agent` | 必填，值必须是本 persona 名称 |
| `pass_id` | 可选，记录输入来源 |

## 违规检测

后续阶段会拒绝以下情况：
- `raw_findings.json` 是手工构造的（无 Agent 调用记录 / 无串行评审过程）
- findings 数量过少（< 3）且无合理解释
- 所有 finding 的 `agent` 字段相同