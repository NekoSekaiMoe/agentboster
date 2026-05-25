三个方面，按优先级排。

---

### 1. 记忆可视化

Memoh 的 Web UI 可以浏览、搜索、手动编辑记忆，还有向量流形可视化（Top-K 与 CDF 图）。AgentClaw 的记忆目前只能通过 IM 的 `/memory search` 和 `/memory list` 查询，Web UI 没有记忆管理界面。

可以直接借鉴的是**记忆浏览器**——一个简单的列表页面，显示所有记忆条目（key、value、来源会话、创建时间），支持搜索和手动删除。不需要 Memoh 的向量流形图（AgentClaw 不做语义向量），只需要结构化事实的可视化管理。用户看到 Agent 记住了什么，能手动纠正错误记忆。

---

### 2. 会话级上下文整理

Memoh 的 LLM 事实抽取和记忆整理是 AgentClaw 缺失的。AgentClaw 当前是"每次任务结束后提取关键事实存入记忆"，但没有**会话内的上下文整理**——长时间任务中，对话历史膨胀，Agent 可能忘记任务早期的上下文。

借鉴 Memoh 的思路：AgentClaw 的 DurableAgent 在压缩步骤中，不只提取摘要，还主动识别"这个任务的关键决策点"——用户中途改了一次需求、Agent 选了一个技术方案、某个步骤失败了三次后换了一种方式。这些决策点比普通对话更重要，压缩时应该保留。不需要 Memoh 的 LLM 驱动的复杂整理，只需要在压缩提示词里加一条"保留任务关键决策点"。

---

### 3. Provider/模型的热切换

Memoh 支持按 Bot 选模型、提供方 OAuth、自动拉模型列表。AgentClaw 当前支持模型热切换（`/model` 命令），但 Provider 的配置需要在 Web UI 手动填 API endpoint。

借鉴 Memoh 的**Provider 预设模板**——ClawLess Web UI 的 Config 页面提供 OpenAI、Anthropic、DeepSeek、Ollama 的预设模板（默认 endpoint、默认模型名），用户选模板自动填充，不需要手动输入完整的 API endpoint 和模型列表。这和之前讨论的"借鉴 Manboster 的预设配置"一致。

---

### 不需要借鉴的

- **Qdrant 向量检索**：AgentClaw 走结构化关键词索引，不做语义向量
- **VNC/桌面环境**：AgentClaw 是纯命令行 Task Agent
- **多模态/语音**：AgentClaw 通过 MCP 接入，不做内置
- **Electron 桌面端**：AgentClaw 的 Next.js Web UI + Vercel 部署比 Electron 更轻

三个东西值得借鉴，但需要改造以适配 AgentClaw 的分层架构和安全哲学。

---

### 1. 记忆系统的结构化提取

Memoh 的记忆引擎核心不是向量检索（Qdrant），而是 **LLM 事实抽取 + 结构化存储**。每次对话结束，LLM 从对话中提取结构化事实（用户偏好、项目配置、历史决策），去重后存入数据库。这和 AgentClaw 的"结构化摘要记忆"完全一致。

AgentClaw 可以借鉴的：Memoh 的**记忆提取提示词**。Memoh 的事实抽取提示词经过了生产验证，能准确区分"事实""偏好""临时上下文"。AgentClaw 当前用的是自己写的提取逻辑，可以替换为 Memoh 的提取提示词，减少记忆噪音。

不改 AgentClaw 的架构——AgentClaw 不需要 Qdrant，不需要 BM25。只借鉴提取提示词，记忆仍然存在 Neon Postgres，检索仍然用关键词索引。

---

### 2. 子智能体的独立上下文管理

Memoh 的子智能体有**独立上下文**——不是简单的"主 Agent 调一个工具"，而是子 Agent 有自己的对话历史、自己的记忆检索范围、自己的沙箱环境。这和 AgentClaw 的并行子 Agent 是同一个思路。

AgentClaw 可以借鉴的：Memoh 的**子 Agent 上下文隔离机制**。Memoh 的子智能体在创建时从主 Agent 继承关键上下文，但执行期间独立维护自己的对话历史，结果返回时只回传摘要。AgentClaw 当前的设计是主 Agent 等所有子 Agent 完成后收集结果——借鉴 Memoh 的"摘要回传"可以减少上下文膨胀。

不改 AgentClaw 的架构——AgentClaw 的子 Agent 已经在独立沙箱中运行，有独立上下文。只借鉴"结果回传摘要而非完整对话"的优化。

---

### 3. 容器化 Workspace 的持久化文件系统设计

Memoh 的每个 Bot 有独立的持久化文件系统——重启、升级、迁移都不丢文件。AgentClaw 的 chroot 沙箱已经实现了持久化，但缺少 Memoh 的**文件快照和版本管理**。

AgentClaw 可以借鉴的：Memoh 的**Workspace 快照和导入导出**。Agent 在 chroot 里开发项目，用户可能想保存某个状态的快照（"重构前"），出问题时回滚。Memoh 的容器快照机制可以简化为 chroot 目录的 `tar` 快照，存在 Neon Postgres 或 Vercel Blob 里。

不改 AgentClaw 的架构——chroot 目录是普通文件系统目录，`tar` 快照是标准操作。在 Agent Daemon 的沙箱管理里加一个 `sandbox_snapshot` 工具，Agent 或用户可以手动创建/回滚快照。

---

### 不该借鉴的

- **Qdrant 向量检索**：AgentClaw 不需要语义搜索，关键词索引够用
- **VNC/桌面环境**：AgentClaw 是命令行 Task Agent，不需要 GUI
- **多 Bot 容器编排**：AgentClaw 的任务级沙箱比 Bot 级容器更灵活
- **Electron 桌面端**：ClawLess 的 Next.js Web UI 已经足够
- **Uber FX DI**：Agent Daemon 的依赖简单，不需要 DI 框架
