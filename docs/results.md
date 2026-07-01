# memoh · manboster · picoclaw · astrbot · agentboster 五项对比

> 本文档由 4 个并行 subagent 分别从「架构与定位」「AI/Agent 能力与安全」「多端接入与部署」「持久化与扩展生态」四个维度调研后合并而成。
>
> 资料来源：外部 4 个项目均来自其 GitHub 官方仓库 README/LICENSE（已查证），仓库实际地址为：
> - memoh → `memohai/Memoh`
> - manboster → `manboster/manboster`
> - picoclaw → `sipeod/picoclaw`（实为 `sipeed/picoclaw`）
> - astrbot → `AstrBotDevs/AstrBot`
>
> agentboster 来自本仓库 README/AGENTS.md 已知信息。
> 标注约定：✅ 已查证 · 🔎 推测 · ❓ 未找到可靠资料 · 🟡 部分实现/Planned

---

## 一、架构与定位

### 对比表格

| 项目 | 核心定位 | 整体架构形态 | 主要技术栈 | 部署形态 | 进程/服务边界划分 |
|---|---|---|---|---|---|
| **memoh** | 多智能体平台：给每个 Agent 一台专属"云电脑"（容器 + 文件系统 + 桌面 + 浏览器 + 网络 + 长期记忆），7×24 在线，可托管外部编码 Agent（Claude Code / Codex）| 平台 + 容器化工作区（每 Agent 一容器），单体仓库内多组件（`apps`/`cmd`/`internal`/`packages`/`crates`/`db`） | Go 65% + Vue 17% + TypeScript 14%，Postgres/PLpgSQL，Cargo（Rust crates），pnpm workspace | 一键脚本 `curl memoh.sh \| sh`、Docker Compose（含 sqlite/kata 变体）、自托管服务器；Memoh Cloud（SaaS，规划中）+ 原生桌面客户端 | 平台进程编排多个独立"工作区容器"，每容器隔离文件系统/网络/桌面/浏览器，按 Agent 独立沙箱 |
| **manboster** | 个人 AI 助手「Manbo 龙虾」，灵感来自 IronClaw/OpenClaw，强调安全（零信任 + Hachimi 守护模型评估工具调用）与 wasm 插件 | 单体可执行文件 + 插件化（wasm/extism）+ 守护进程模式（`manboster start`） | Go（99%），goreleaser，Docker，go-rod（headless 浏览器搜索），extism/wasm 插件 | 单二进制开箱即用（下载或 `go install`），支持 Docker，独立 daemon 进程 | 单体二进制内部模块（`cmd`/`internal`/`spec`）；插件以 wasm 沙箱隔离；规划 Hachimi 守护模型作为旁路评估器 |
| **picoclaw** | 超轻量个人 AI 助手，"$10 硬件 / <10MB 内存 / <1s 启动"，覆盖 RISC-V/ARM/MIPS/x86 与安卓，灵感来自 NanoBot | 单二进制 + Gateway（多渠道接入）+ WebUI Launcher，channel/provider/tools/skills/mcp 高度模块化配置 | Go 90% + TypeScript 9.5%（WebUI Launcher 前端），Node/pnpm 构建 Launcher，Docker Compose | 预编译单二进制（picoclaw.io 自动识别平台）、Docker、Android APK、Termux、嵌入式板（LicheeRV-Nano 等）；纯本地为主 | 单进程核心二进制 + 可选 WebUI Launcher（独立前端）；Gateway 统一接 webhook；MCP server 为外部独立进程 |
| **astrbot** | 一体化 IM 聊天机器人 / Agent 开发框架：聚合主流 IM 平台 + LLM + 插件 + 知识库，定位 OpenClaw 替代品 | 单体应用 + 插件化（1000+ 社区插件）+ WebUI/ChatUI + Agent Sandbox | Python 70% + Vue 22%（dashboard）+ TypeScript，ruff/pre-commit，uv 安装 | uv 一键、Docker Compose（含 k8s、宝塔、1Panel、CasaOS、AUR、RainYun 云、Replit、桌面 App） | 单 Python 进程 + 内置 Agent Sandbox（隔离代码/shell）；适配器（adapter）插件式接入各 IM；dashboard 为独立 Vue 前端 |
| **agentboster** | 多端协作 AI 平台（浏览器 UI + IM Bot + 终端编码 + Linux 沙箱执行） | 硬分层三分架构：Web（唯一权威）+ agentd（Go 沙箱执行端）+ CLI（pi 瘦客户端）；窄 HTTP 契约，强异步 Workflow 编排 | Next.js 15 + React 19 + TS + Postgres/pgvector + Workflow DevKit；Go 1.26（agentd）；CLI 独立 yarn monorepo（pi + biome + tsgo） | 多组件独立部署：Web 云端、agentd 节点（可水平扩缩）、CLI 本地终端；mTLS + AGENTD_API_KEY | Web = 权威（会话/编排/凭证/审计），agentd/CLI = 无本地权威状态、可丢弃、可扩缩；三层仅经窄 HTTP 契约通信 |

### 各项目简评

- **memoh**：定位"为每个 Agent 提供一台专属云电脑"，是典型**多租户多智能体托管平台**。架构上以容器化工作区为核心隔离单元，单体仓库但内部分层（Go 后端 + Vue/TS 前端 + Rust crates + DB），强调 Browser Use / Computer Use 与长期记忆，并支持通过 ACP 托管 Claude Code、Codex 等外部 Agent。
- **manboster**：定位**个人 AI 助手 + 安全守护**，单体 Go 二进制 + daemon 模式 + wasm 插件化。差异化卖点是零信任工具调用与 Hachimi 守护模型；规模小（MVP，20 star），偏单用户/单机，与 agentboster 名字相近但属完全独立的项目。
- **picoclaw**：定位**极致轻量化的边缘 AI 助手**，把"单二进制跑在 $10 RISC-V/ARM 板上"作为核心叙事（29.5k star）。架构是单进程 Go + 模块化配置（channel/provider/tools/skills/mcp），外加可选 WebUI Launcher；与 OpenClaw（TS）、NanoBot（Python）形成明确替代关系。
- **astrbot**：定位**一体化 IM 聊天机器人 / Agent 开发框架**（35.6k star），是五个项目里最偏"框架 + 插件生态"的一个。Python 单体 + Vue dashboard + 1000+ 社区插件 + Agent Sandbox，覆盖 IM 平台最广（QQ/微信/TG/Discord/Slack 等 18+），强调在 IM 工作流内快速搭建生产级 AI 应用。
- **agentboster**：定位**多端协作 AI 平台**，是五个里唯一明确做"硬分层 + 多端协作 + 权威中心"架构的项目。Web 是唯一权威（会话/编排/凭证/审计），agentd（Go 沙箱执行）与 CLI（pi 终端编码）为无状态执行端，三层经窄 HTTP 契约 + Workflow DevKit 强异步编排，强调水平扩缩与审计，而非单机助手。

### 定位差异总结

从定位谱系看：**AstrBot** 和 **Manboster** 偏**框架/个人助手**（一个重 IM 插件生态、一个重安全守护的单机 Agent）；**PicoClaw** 偏**边缘/嵌入式 CLI 工具**（极致轻量、单二进制、硬件优先）；**Memoh** 偏**多智能体托管平台**（容器化工作区 + 云电脑隐喻 + 多用户多 bot）；**Agentboster** 偏**多端协作的权威编排平台**（Web 唯一权威 + 可丢弃执行端 + 强异步工作流），与 Memoh 同属"平台"梯队但走的是"窄契约硬分层"而非"每 Agent 一容器"的路线。

换言之：**Manboster / PicoClaw** 是"单进程助手"，**AstrBot** 是"IM 机器人框架"，**Memoh** 是"Agent 云主机平台"，**Agentboster** 是"多端协作编排平台"——后两者面向多端/多用户/规模化的生产场景，前三者面向个人/单机/边缘场景。

---

## 二、AI/Agent 能力、工具调用与安全

### 对比表格

| 维度 | **agentboster** | **memoh** | **picoclaw** | **astrbot** | **manboster** |
|---|---|---|---|---|---|
| Agent / 对话循环 | 多步 CodeAct 工具循环；Workflow DevKit 编排、子代理、可恢复步骤、工作流可视化 | 多 Agent 平台；每 Agent 一台云电脑（容器+桌面+浏览器）；ACP 托管 Claude Code/Codex；计划任务/心跳 | 单 Agent + SubTurn/Hooks/Steering/EventBus；spawn 子代理与异步任务；Cron 调度 | 对话机器人框架；LLM 多轮+Agent+MCP+Skills；可接 Dify/Bailian/Coze 编排；自带 Agent Sandbox | MVP：个人聊天助手，目标支持 Skills/插件，目前主要是单轮/多轮 chat |
| 工具调用机制 | 内置工具 + MCP + Skills；CodeAct 在 agentd 沙箱内执行 | MCP（每 Bot 自管连接）+ 插件 + Skills/Supermarket + Browser/Computer Use | MCP 原生 + 内置工具（Web 搜索、文件、cron）+ Skills(ClawHub) + 模型路由 | MCP + 1000+ 社区插件 + Skills + Web 搜索；Agent Sandbox 内跑代码/shell | Wasm 插件（extism，规划中）；内置 Web 搜索（go-rod headless）；MCP 标记为 Planned |
| 安全模型 | 三层：L0 规则黑名单 / L1 LLM 风险评分 / L2 用户授权；docker / docker-strict / lxc 三档沙箱；CLI `--yolo` 仅本机跳过 | 每 Agent 独立容器隔离（fs/network/desktop）；AGPL-3.0，无显式风险评分/审批 | `.security.yml`、敏感数据过滤、Cron 安全 gating、isolation；自承"v1.0 前勿上生产" | **Agent Sandbox**：隔离执行代码/shell，会话级资源复用；无明确三层审批/风险评分 | Hachimi 本地守护模型评估工具调用，不安全则交用户裁决；零信任 gatekeeper + TTL；规划 wasm 沙箱；vault 隔离凭据 |
| 多 Provider 支持 | 多 Provider（含 MCP） | 自研 Twilight AI SDK，Provider-agnostic + BYO Key + 托管外部 Agent | 30+ Provider（OpenAI/Anthropic/Gemini/OpenRouter/Bedrock/Azure/Ollama/vLLM 等）+ 模型路由 | 20+ LLM 服务（OpenAI/Anthropic/Gemini/DeepSeek/Ollama 等）+ LLMOps（Dify/Coze/Bailian）+ STT/TTS | OpenRouter/Kimi/DeepSeek/OpenAI 兼容（小集合） |
| 记忆 / RAG / 长期上下文 | 内置 RAG / 记忆 + Skills | 内置长期记忆（跨会话/跨平台），集成 Mem0、OpenViking | JSONL 记忆存储；规划中的 RAG；长上下文压缩 | 知识库 + RAG + 人格设定 + 自动上下文压缩 | 规划中：可插拔 RAG + mem0 理论适配 |

### 各项目简评

**agentboster**：在工具执行安全上最体系化——L0/L1/L2 三层评估与三档沙箱是其标志性设计，工作流引擎又把 LLM 调用、工具循环、子代理都做成可恢复步骤，工程严谨度最高。代价是架构较重，安全链路对延迟和体验有影响（所以提供 `--yolo` 逃生阀）。它在"安全 + 编排"两端都靠前，是少有的兼顾型设计。

**memoh**：定位"给每个 Agent 一台云电脑"的多 Agent 平台，强在容器化工作空间（独立 fs/network/desktop/browser）+ 长期记忆 + 多渠道接入 + 托管 Claude Code/Codex（ACP）。安全主要靠"每 Agent 一容器"的强隔离，README 未提及显式的命令风险评分或人工审批链——隔离替代了细粒度审核。编排偏平台型而非 workflow 引擎。

**picoclaw**：极致轻量（<10MB、$10 硬件、Go 单二进制）+ 30+ Provider + 19+ 渠道 + MCP，SubTurn/Hooks/Steering 给了它不弱于重型框架的 Agent 编排能力。安全侧有 `.security.yml`、敏感数据过滤、Cron gating，但 README 自己警告"v1.0 前勿上生产、近期合并多 PR 可能存在未解决安全问题"——能力丰富但安全成熟度低。

**astrbot**：5 个里生态最大（35.6k★、1000+ 插件）、IM 渠道与 LLM/STT/TTS 覆盖最全，定位是"聊天机器人 + Agent 框架"。亮点是独立的 **Agent Sandbox**（隔离跑代码/shell、会话级资源复用），但 README 未描述风险评分/人工审批/沙箱档位等细粒度安全链路。强在生态与多模态，工具安全以沙箱为主。

**manboster**：仍处于早期 MVP（20★，v0.2.3），核心设计理念反而最接近 agentboster 的安全思路——本地 Hachimi 守护模型评估工具调用 + 零信任 gatekeeper + TTL + wasm(extism) 沙箱 + vault 隔离凭据。但绝大多数关键能力（wasm 沙箱、MCP、RAG、Skills 兼容）都还在 Planned/WIP，实际可用安全深度有限。

### 总结：谁最强、各自取舍

- **工具执行安全最强：agentboster**。三层独立评估（规则→LLM 评分→人工授权）+ 三档可收紧沙箱是 5 个项目里唯一成体系的纵深防御；manboster 设计理念最像，但还在 MVP；memoh 靠容器强隔离但缺细粒度审核；picoclaw/astrbot 主要靠沙箱但都自承安全未成熟或未提供审批/评分。
- **Agent 编排能力最强：memoh（平台型）与 agentboster（引擎型）并列但取向不同**。memoh 胜在"每 Agent 一台云电脑 + 桌面/浏览器 + ACP 托管外部 Agent"的富执行环境与多 Agent 编排；agentboster 胜在 Workflow DevKit 的可恢复、可可视化、子代理编排的工程化深度。picoclaw 在轻量化约束下做到了令人意外的编排密度（Hooks/SubTurn/spawn），是"小身材强编排"的代表；astrbot 强在生态编排（插件 + LLMOps 接入）而非自研编排内核；manboster 编排能力目前最弱。
- **取舍**：要"安全优先 + 可恢复编排"选 agentboster；要"多 Agent 富执行环境"选 memoh；要"IM 生态 + 多模态"选 astrbot；要"边缘/嵌入式部署"选 picoclaw；manboster 适合关注 wasm 沙箱 + 守护模型思路的早期实验者。

---

## 三、多端接入、客户端与部署体验

### 对比表格

| 项目 | 客户端 / 接入渠道 | 部署方式 | 部署难度与依赖 | 配置体验 | 多用户 / 多租户 |
|---|---|---|---|---|---|
| **agentboster** | Web UI（Next.js 流式聊天/搜索/斜杠命令）；IM Bot：Telegram、Discord、Slack、飞书、Teams；CLI（pi，TUI + `--print`） | Web → Vercel；agentd → Linux（`go build`，sudo，支持 docker/lxc 沙箱）；CLI → 本机 npm | 中。Web 需 `DATABASE_URL`（如 Neon）、`AUTH_SECRET`、BLOB 等；agentd 需 Linux + 可选沙箱 | UI 配置 Provider/Skills/工具/MCP/Soul；CLI 登录写入 `~/.agentboster/config.json`，无需 env | 三层硬分层可独立升级/部署（含账号体系，支持多用户） |
| **AstrBot** | WebUI + 内置 ChatUI；IM 最广：QQ、企业微信、微信公众号、飞书、钉钉、Telegram、Slack、Discord、LINE、KOOK、Satori、Misskey、Mattermost、WhatsApp(规划)、Matrix/Rocket.Chat/VoceChat(社区)；无官方 CLI；桌面 App | 一键 `uv tool install astrbot`；Docker/Compose；宝塔/1Panel/CasaOS 面板；RainYun 云；Replit；AUR；源码 | 低-中。Python 3.12，`uv` 一键最简；Docker 适合生产；外部依赖主要是 LLM API key 与可选向量库 | WebUI 配置为主，1000+ 插件一键装 | 定位"个人/团队/企业"，偏单实例多平台接入；无明显多租户隔离 |
| **PicoClaw** | WebUI Launcher + CLI（`picoclaw agent` / `gateway`）；19+ Channel：Telegram、Discord、WhatsApp、Weixin、QQ、Slack、Matrix、钉钉、飞书/Lark、LINE、企业微信、VK、IRC、OneBot、MQTT、MaixCam、Pico、Pico Client；Android APK | 单二进制（picoclaw.io 自动识别平台）；GitHub Releases；Docker Compose；Termux；`make build` 源码 | 极低。<10MB RAM、亚秒启动、$10 RISC-V 板可跑；仅一个自包含二进制；无强制数据库 | WebUI Launcher 或 `~/.picoclaw/config.json`（敏感信息分离到 `.security.yml`）；CLI 子命令管理 | 单用户个人助手定位，无多租户 |
| **Memoh** | Web UI；桌面 App（macOS/Windows/Linux 原生）；IM：Telegram、Discord、Lark/飞书、微信、QQ、Email 等 10+；无 CLI | `curl -fsSL https://memoh.sh \| sh` 一键脚本；`docker compose up -d`；Memoh Cloud（SaaS，waitlist） | 中。多容器（agent 容器+桌面+浏览器+记忆），含 Postgres（sqlc）、可选 Kata 容器沙箱；可用 SQLite 变体降依赖 | `config.toml`（基于 `app.docker.toml`）+ DEPLOYMENT.md；UI 配置 | **强多用户/多 Bot**：每个 agent 独立容器 + 跨平台身份绑定 + 团队成员分配 |
| **Manboster** | 单二进制（双击或 `./manboster`）；`manboster config` 命令；当前仅 Telegram（飞书/Lark 为下一计划）；无 Web UI、无桌面/移动端 | GitHub Releases 预编译二进制；`go install ...@latest`；Dockerfile；源码 | 极低。单个 Go 可执行、低内存、首次运行交互式配置；无强制数据库 | 首次启动交互配置；`manboster config` 启停内置工具；`manboster skills install`（WIP） | 单用户个人助手，无多租户 |

### 各项目简评

**agentboster** — 三层架构（Web/IM-Bot/CLI）各自独立、可分开部署和升级，是本对比中唯一把"硬分层"作为一等公民的设计。Web 走 Vercel + Next.js 15，体验最接近现代 SaaS；agentd 用 Go 编译为单进程、可选 docker/lxc 沙箱；CLI 借 `agentboster login` 与 Web 配对，把"配一次用多处"做到了无 env 变量。IM 渠道偏国际化（Telegram/Discord/Slack/飞书/Teams），但宽度不及 AstrBot/PicoClaw。

**AstrBot** — **IM 多平台接入的事实标杆**：官方维护 13+ 主流 IM、社区再加 3+，覆盖中国系（QQ/企业微信/公众号/飞书/钉钉）与国际系（Telegram/Slack/Discord/LINE/KOOK 等）。部署路径最丰富：`uv` 一键、Docker、宝塔/1Panel/CasaOS 面板、RainYun 云、Replit、AUR、桌面 App/Launcher，对非开发者友好。短板是偏"单实例多渠道"，没有明确的多租户隔离，且无官方 CLI 形态。

**PicoClaw** — **极致轻量与可移植**是其杀手锏：单 Go 二进制 <10MB RAM、亚秒级启动，能在 $10 RISC-V 板、旧安卓手机、Termux 上跑。接入渠道 19+，覆盖度仅次于 AstrBot，且包含 MQTT/OneBot/MaixCam 等物联网向适配器。配置走 WebUI Launcher 或 JSON+`.security.yml` 敏感信息分离，体验在轻量级项目里算很完善。单用户定位，无多租户。

**Memoh** — **多租户/多 Agent 容器化**是最鲜明的差异化：每个 agent 拥有独立容器（fs/网络/桌面/浏览器/长期记忆），可托管外部 Claude Code/Codex，是面向"团队/机群"的架构。接入渠道 10+（Web/桌面原生/Telegram/Discord/飞书/微信/QQ/Email），并自带 Browser Use + Computer Use。部署用 `memoh.sh` 一键脚本或 Docker Compose，依赖比 PicoClaw/Manboster 重（Postgres、容器栈、可选 Kata 沙箱），但比 agentboster 更自包含。Memoh Cloud SaaS 在 waitlist。

**Manboster** — 五个项目中**最早期、最极简**：单 Go 二进制、双击即用，主打"wasm 插件沙箱 + Hachimi 守护模型 + 零信任 gatekeeper"的安全卖点。当前接入渠道仅 Telegram（飞书在规划中），LLM 支持 openrouter/kimi/DeepSeek/OpenAI 兼容。Star 仅 20、多项关键能力（MCP、RAG、vault、wasm 插件、MamboHub）尚处 WIP/Planned，目前更像 MVP。配置靠首次启动交互 + `manboster config` 命令，无 Web UI、无桌面/移动端。

### 总结：两个强项维度

- **IM 多平台接入最强：AstrBot > PicoClaw > Memoh > agentboster > Manboster。** AstrBot 是唯一官方覆盖中国主流 IM（QQ/企业微信/公众号/飞书/钉钉）并同时支持十余种国际 IM 的项目，外加 1000+ 插件生态，渠道宽度断层领先；PicoClaw 凭 19+ channel 紧随其后，且在物联网/嵌入式渠道（MQTT/MaixCam）上独有优势；Memoh 因每 agent 独立容器，多渠道天然适配但渠道数量略少；agentboster 走精品国际化路线（5 个 IM + Web + CLI），Manboster 目前仅 1 个 IM。
- **开箱即用的部署体验最强：PicoClaw ≈ Manboster（极简单二进制）> AstrBot（一键脚本+面板+桌面）> Memoh（一键脚本+容器栈）> agentboster（三层分别部署）。** PicoClaw 与 Manboster 都是单 Go 二进制、亚秒级启动、无需数据库，是"下载即跑"的典范；PicoClaw 还能在 $10 硬件和旧安卓上跑，部署门槛全场最低。AstrBot 的部署路径数量最多（uv/Docker/三种面板/云/Replit/AUR/桌面），对非技术用户最友好。Memoh 的一键脚本虽便利，但依赖较重（Postgres + 容器栈），适合愿意运维的团队。agentboster 因为坚持 Web/IM-Bot/CLI 三层独立部署，部署体验最"工程化"——灵活但需要分别配置 Vercel、Linux 主机、本机环境，门槛在五者中最高，换来的是最强的架构解耦与升级独立性。

---

## 四、持久化、扩展生态与开源治理

### 对比表格

| 维度 | agentboster | AstrBot | picoclaw | memoh | manboster |
|---|---|---|---|---|---|
| **持久化方案** ✅ | Postgres + pgvector（会话/消息/向量记忆/Workflow 状态/凭证/审计/节点表）；CLI 仅 tmpdir 临时镜像；agentd 无状态 | ✅ 内置数据库（README 列出 WebUI/数据持久化，🔎 推测 SQLite/文件混合） | ✅ JSONL 文件存储 + `~/.picoclaw/config.json` + workspace 目录；JSONL memory store（v0.2.1 引入）；无外部 DB | ✅ 容器化 workspace（每 agent 一容器 = 独立文件系统/网络/桌面）；内置长期记忆，并支持 Mem0/OpenViking 外接 | 🔎 README 未明确持久化层；MVP 状态，推测本地文件/配置，无外部 DB |
| **记忆 / 向量检索** ✅ | pgvector 向量记忆 + Workflow delta 持久化 | ✅ Knowledge Base + Auto Context Compression；向量检索插件化（如 livingmemory 长期记忆插件 272★） | ✅ JSONL memory store（追加式日志）；🔎 未提及原生向量索引/embedding | ✅ "Long-term memory across sessions and platforms, out of the box"，并显式兼容 Mem0、OpenViking | ❌ 仅 [Planned] RAG memory + mem0 theory，尚未实现 |
| **扩展机制** ✅ | Skills / Provider / 工具 / MCP / Soul（人格）/ 多渠道 Bot adapter 插件 | ✅ **1000+ 社区插件** + 官方插件市场 + MCP + Skills + Agent Sandbox + Dify/Coze/Bailian LLMOps 集成 | ✅ MCP（原生，含 CLI 管理）+ Skills（ClawHub 注册中心 + GitHub registry）+ Cron + 多 Provider 路由 + 19+ Channels | ✅ MCP（每 bot 自管连接）+ Plugins + Skills & Supermarket（`memohai/supermarket`）+ Agent Hosting（ACP 托管 Codex/Claude Code）+ 10+ Channels | 🟡 MVP：内置工具可插拔 + wasm/extism 插件 + OpenClaw skills 兼容（WIP）；MCP / MamboHub / `.manboplugin` 均 [Planned] |
| **多节点 / 集群 / HA** ✅ | agentd 多节点注册/心跳/资源指标上报，Web 统一调度（见 `MULTI-NODE-SCHEDULING.md`） | 🔎 README 未提集群；单实例 + Docker 部署为主 | 🔎 单 binary/单机导向（"$10 hardware"），无集群叙述；有 experimental Gateway hot-reload | ✅ **多用户多 bot fleet**（一台机跑一个舰队）+ 容器隔离 + scheduled tasks；🔎 无显式多节点调度协议 | ❌ 无集群能力（MVP 单进程，daemon 模式） |
| **开源协议** ✅ | MIT | ✅ **AGPLv3**（强 copyleft + 网络服务条款） | ✅ MIT | ✅ **AGPLv3** | ✅ Apache-2.0 |
| **活跃度（star / 更新）** ✅ | WIP，本地仓库，未公开 star 数据 | ✅ **35.6k★**，4 小时前更新；6k+ 相关仓库；14 个 QQ 群 + Discord；Trendshift 上榜 | ✅ **29.5k★**，1 小时前更新；17 天破 20k★；多语言 README（10 种） | ✅ **2k★**，4 小时前更新；新项目（2026）；有 Desktop 客户端 + Cloud waitlist | ✅ **20★**，7 天前更新；461 commits、9 releases；极早期 |
| **文档完整度** ✅ | README / README.EN.md / AGENTS.md / MULTI-NODE-SCHEDULING.md + cli/agentd 各自 README | ✅ astrbot.app 独立文档站 + DeepWiki + 多语言 README（6 种）+ 活跃 Blog/Roadmap | ✅ docs.picoclaw.io + DeepWiki + 10 种语言 README + 细分 docs/ 目录（架构/操作/参考） | ✅ docs.memoh.ai 独立文档 + DEPLOYMENT.md + DeepWiki | 🟡 manboster.dev/docs（外链）+ README/zh_CN；THANKING/SECURITY/CONTRIBUTING 齐全但浅 |

### 各项目简评

**agentboster** — 唯一以 **Postgres + pgvector** 为权威存储、并把 Workflow 每步 delta 写入 messages 表实现可恢复/可续跑的项目；agentd 无状态、CLI 仅临时镜像的设计，把"真相源"统一在 Web 层。扩展面铺得很广（Skills/Provider/工具/MCP/Soul/多 adapter），多节点调度协议有专门文档。代价是三套独立技术栈（Web/Go/CLI）的发版与类型检查需各自维护，WIP 状态下接口稳定性弱。

**AstrBot** — 5 个项目里**社区生态最成熟**：1000+ 插件、35.6k★、官方插件市场徽章实时计数、14 个 QQ 群 + Discord。持久化由框架自带（WebUI 管理），记忆与向量检索通过 Knowledge Base 与第三方插件（如 livingmemory）实现。**AGPLv3** 是显著区别点——对二次商用构成强约束。无多节点能力，定位是单实例强能力的 IM chatbot 平台。

**picoclaw** — 主打"$10 硬件 / <10MB RAM / <1s 启动"的**极致轻量 Go 单 binary**，持久化走 JSONL 文件 + workspace 目录路线，无外部 DB 依赖。扩展生态靠 MCP（原生 + CLI 管理）+ ClawHub/GitHub 双 registry 的 Skills。29.5k★、迭代极快（4 个月到 v0.2.9），但 README 自承"v1.0 前勿用于生产"，且**无集群/HA 叙述**，是单机边缘场景导向。

**memoh** — 思路最独特：**每个 agent 一个独立容器**（自带文件系统/桌面/浏览器/网络/记忆），fleet 化运行，并可通过 ACP 托管外部 Claude Code/Codex agent。记忆"开箱即用 + 兼容 Mem0/OpenViking"，扩展走 MCP + Plugins + Supermarket。AGPLv3 + 2k★ + 有 Cloud waitlist，定位偏"always-on 个人/团队 agent 主机"。文档与部署（`curl -fsSL https://memoh.sh`）较完善。

**manboster** — 早期 MVP（20★，9 releases），卖点是**安全**：Hachimi 本地 guard model + 零信任 gatekeeper + TTL + wasm/extism 沙箱插件。但持久化层、RAG 记忆、MCP、MamboHub 等关键能力均标注 [Planned]/[WIP]，目前只有 Telegram 单渠道 + 少数 LLM provider。Apache-2.0 是 5 个里最宽松的协议，适合二次闭源商用，但功能成熟度还无法与前四者对齐。

### 总结：两个核心差异轴

**持久化与可恢复性** —— 走向两极：agentboster 与 memoh 代表"**重持久化**"路线（关系库+向量 / 容器化 workspace + 外接记忆服务），天生为多会话/多 agent/可恢复设计；picoclaw 与 manboster 代表"**轻持久化**"路线（JSONL 文件 / 本地配置），优先级是 footprint 与部署简单度，可恢复性弱、无 HA；AstrBot 居中，框架内置持久化但非集群导向。**只有 agentboster 把"Workflow 编排的逐步 delta 落库 + 多节点调度"作为一等公民**，这是它在可恢复性上的独占位。

**扩展生态成熟度** —— AstrBot 一档（1000+ 插件 + 官方市场 + 活跃社区，但 AGPLv3 限制商用），picoclaw 二档（MCP 原生 + ClawHub，生态起步但迭代极快，MIT 友好），memoh 二档偏上（Supermarket + ACP 托管外部 agent 是差异化亮点，但 AGPLv3），agentboster 二档（扩展点广且自研完整，但生态尚未对外规模化，MIT），manboster 三档（多数扩展点仍是 Planned，Apache-2.0 最宽松但 MVP 仅）。**协议选择呈现明显分野**：AGPLv3（AstrBot/memoh，保护网络服务场景）vs MIT/Apache（picoclaw/manboster/agentboster，吸引商用与闭源衍生）。

---

## 五、横向速查矩阵

| 维度 | memoh | manboster | picoclaw | astrbot | agentboster |
|---|---|---|---|---|---|
| 定位 | Agent 云主机平台 | 个人安全助手 | 边缘轻量助手 | IM 机器人框架 | 多端协作编排平台 |
| 主语言 | Go + Vue + TS | Go | Go + TS | Python + Vue | TS + Go |
| 部署门槛 | 中（容器栈） | 极低（单二进制） | 极低（单二进制） | 低（uv/面板） | 中-高（三层部署） |
| IM 渠道数 | 10+ | 1 | 19+ | 18+ | 5 |
| 工具安全 | 容器隔离 | 守护模型+wasm（WIP） | 沙箱+配置（未成熟） | Agent Sandbox | **L0/L1/L2 三层 + 三档沙箱** |
| Agent 编排 | 平台型多 Agent | 弱（MVP） | SubTurn/Hooks | 生态编排 | **Workflow 可恢复** |
| 持久化 | 容器+长期记忆 | 🔎 文件（推测） | JSONL 文件 | 内置 DB | **Postgres+pgvector** |
| 多租户/集群 | ✅ 多 bot fleet | ❌ | ❌ | ❌ | ✅ 多节点调度 |
| 开源协议 | AGPLv3 | Apache-2.0 | MIT | AGPLv3 | MIT |
| 活跃度 | 2k★ | 20★ | 29.5k★ | 35.6k★ | WIP（本地） |

---

## agentboster 深度剖析

> 本节基于对本地仓库 `/home/user/repo/agentboster`(commit 状态、文件时间 2026-06-30)的实际源码读取,所有结论均可在引用的 `path:line` 处复核。AgentBoster 由三部分组成:**Web**(Next.js 15 + Postgres/pgvector,唯一权威)、**agentd**(Go 1.26.2 Linux 执行面)、**CLI**(基于 pi 的 Yarn Classic monorepo 瘦客户端)。三者通过窄 HTTP 契约协作,无共享代码路径、无共享 schema。

### 目录结构

仓库根刻意把三个独立模块并列,而非 yarn workspace。根 `tsconfig.json`/Vitest 都显式 exclude `cli` 和 `agentd`,所以根 `tsc --noEmit` 不会触及子项目。

```text
agentboster/
├── app/                      # Next.js 15 App Router(路由、API、RSC)
│   ├── (auth)(chat)(config)(files)(memory)(schedule)(skill)/  # 路由组(括号不入 URL)
│   ├── api/                  # 见下文「API 契约」
│   └── layout.tsx, globals.css, icon.png, robots.ts
├── components/               # React 组件(shadcn/ui + 自定义)
│   ├── chat/                 # chat-container / chat-input / message-list / model-picker
│   ├── config/               # config-forms / agentd-config / knowledge-management / users-management
│   ├── ui/                   # shadcn 原子组件(button, dialog, tabs, table…)
│   └── *.tsx                 # app-sidebar / adaptive-chat-layout / markdown / tool-timeline / workflow-timeline / decision-card
├── lib/                      # 业务逻辑(见下文「Web 层关键模块」)
├── subpackage/               # 独立 build 单元集合（每个子项目自带 go.mod / package.json）
│   ├── agentd/               # 独立 Go module(`github.com/clawless/agentd`)
│   │   ├── cmd/agentd/       # main.go + tui/(交互式配置向导)
│   │   ├── internal/         # 见下文「agentd 架构」
│   │   ├── agentd.toml.example   # 配置模板
│   │   ├── LAYOUT.MD, AGENTS.md, README.md
│   │   └── go.mod / go.sum
│   ├── cli/                  # 独立 Yarn Classic monorepo(packageManager yarn@1.22.22)
│   │   ├── packages/
│   │   │   ├── coding-agent/     # `agentboster` bin + TUI + login + session
│   │   │   ├── agentboster-adapter/  # auth / web-stream / models / preferences / security
│   │   │   ├── agent/            # pi-agent-core 会话原语
│   │   └── ai/               # pi-ai 类型层(无 provider SDK)
│   ├── scripts/              # bundle.mjs / package.mjs
│   └── package.json, tsconfig*.json, AGENTS.md, README.md
├── hooks/                    # React hooks(根 TS 包含)
├── types/                    # 共享 TS 类型(config, workflow, security)
├── public/, scripts/         # 静态资源 + vercel-postbuild/ensure-vector
├── middleware.ts             # 全局 Next 中间件(见 API 契约)
├── drizzle.config.ts         # schema: ./lib/core/db/schema/index.ts
├── next.config.ts, biome.jsonc, tsconfig.json, vitest.config.ts
└── README.md, README.EN.md, AGENTS.md, SECURITY.md, MULTI-NODE-SCHEDULING.md
```

`lib/` 一级子目录职责:

| 目录 | 职责 | 关键文件 |
|------|------|----------|
| `lib/ai/` | Provider 工厂、模型解析、preset | `providers.ts:17` `getProvider`, `presets.ts` |
| `lib/auth/` | 用户名/密码登录、Cookie/JWT、配对码 | `session.ts`, `pair-code.ts` |
| `lib/chat/` | 会话生命周期、消息序列化、流式、斜杠命令 | `index.ts`(chatMain), `persistence.ts`, `stream.ts`, `commands/` |
| `lib/cli/` | CLI Bearer 鉴权包装 | `auth.ts:50` `withCliAuth` |
| `lib/core/` | DB(drizzle)、Blob、KV、Sandbox 运行时 | `core/db/schema/`, `core/sandbox/runtime.ts` |
| `lib/extra/` | 「重」模块:agentd client、cron、安全、channels、sandbox | `extra/security/`, `extra/agent/`, `extra/channels/` |
| `lib/i18n/` | 多语言(completeness 自检) | `locales/`, `server.ts` |
| `lib/knowledge/` | RAG providers | `providers/` |
| `lib/mcp/` | 内置 MCP 与工具桥接 | `builtin/`(context7, firecrawl, github, web), `tools/web-fetch.ts` |
| `lib/memory/` | 内置/会话/长期记忆、cross-reranker | `recall.ts`, `long-term.ts`, `extract.ts`, `cross-reranker.ts` |
| `lib/security/` | L1 评分模型、L2 决策队列 | `l1-scorer.ts`, `l2-decision-queue.ts` |
| `lib/vault/` | 加密 vault 读写 | `index.ts` |
| `lib/workflow/` | Workflow agent 编排 | `agent/`, `scheduled/` |
| `lib/audio/`, `lib/bot/`, `lib/utils/` | TTS 缓存、IM 适配器、logger/health | — |

### Web 层关键模块

#### Workflow 编排(`lib/workflow/agent/`)

整个对话不是直接跑在请求线程,而是落地为 **Workflow DevKit**(`workflow@^4.3.1` + `@workflow/ai@^5.0.0`)的可恢复 `chatWorkflow`。入口 `lib/workflow/agent/index.ts:170` 标注 `'use workflow'`,核心结构:

- `steps/`:`build-prompt.ts`(system prompt 拼装)、`persist.ts`(`persistStepDeltaAndUsageStep` 把每步 delta 写 `messages` 表)、`resolve-model.ts`(模型 + providerOptions 解析)、`compress.ts`(上下文压缩)。
- `tools/`:工具注册中心 `index.ts:30` 的 `BUILT_IN_TOOLS` 数组聚合了 9 类工具:`execute/sanbox.ts`(沙箱执行)、`memories/local.ts`(记忆)、`skills/local.ts`(技能)、`tasks/schedule.ts`(定时)、`tasks/summary.ts`(任务总结)、`tasks/sub-agent.ts`(子代理)、`agentd/nodes.ts`(节点管理)、`local/index.ts`(CLI 本机工具)、`questions/ask-question.ts`(L2 提问)。另有 `mcp.ts` 动态合并 MCP 工具。
- `hooks/`:`instructionHook.ts`(运行中注入用户/系统/控制消息)、`approvalHook.ts`、`localToolHook.ts`(CLI `local_*` 工具结果回灌)、`registry.ts`。所有 hook 由 `getWorkflowMetadata()` 拿到的 `runId` 鉴权。
- `security/`:`engine.ts` + `rules.ts` 在 workflow 沙箱内做工具调用前的安全评估。
- `sender/`:`writers.ts`(`createWritable` + `writeStreamClose/Error`)、`bot-steps.ts`(IM 通道步进)。
- `utils/`:`agent-config.ts`、`shouldCompress.ts`、`model-context.ts`(`resolveModelContextLimit`)。

#### 会话管理(`lib/chat/`)

- `index.ts` 暴露 `chatMain`,被 `/api/cli/chat`、`/api/ai`、IM webhook 共用,接受 `trigger: 'submit-message' | 'regenerate-message' | 'route-message'` 三种触发(`app/api/cli/chat/route.ts:34`)。
- `persistence.ts`/`message-utils.ts`:`serializeUserMessage`、`toModelMessage`、`modelMessagesToPrompt` 处理 DB↔Model 转换。
- `session-events.ts`、`session-title.ts`、`session-cleanup.ts`:会话元事件、自动标题、清理。
- `commands/`:斜杠命令(`/new`、`/compact`、`/model`、`/approve` 等)。
- `transport-request.ts` + `use-chat-transport.ts`:useChat 传输层。

#### IM Adapter(`lib/bot/` + `lib/extra/channels/`)

- `lib/bot/` 是平台无关的核心:`adaptor.ts`(消息适配)、`core.ts`、`webhook.ts`、`reply.ts`、`voice.ts`、`capabilities.ts`。
- `lib/extra/channels/` 是具体平台:`discord.ts`、`feishu.ts`、`slack.ts`、`telegram.ts`(根 package.json 还引了 `qq-official-bot`、`@chat-adapter/*` 4.29.0、`@larksuiteoapi/node-sdk`)。
- `notification-manager.ts` + `send-notification.ts`:统一通知出口,L2 决策、任务完成、tidy 报告都走这里。

#### Provider(`lib/ai/`)

`providers.ts:17` 的 `getProvider` 支持 4 种 `format`:`anthropic`、`openai`、`google`、`openaicompatible`。`getLanguageModel` 有 `useChatApi` 开关——第三方 OpenAI 兼容端点(GLM/DeepSeek)只实现 `/v1/chat/completions`,强制走 `provider.chat()`(README 注释在 `providers.ts:82-93`)。`presets.ts` 提供预设 base_url。

#### 安全 L0/L1/L2

三层独立、任一层可否决:

| 层 | 代码位置 | 作用 |
|----|----------|------|
| L0 | `lib/extra/security/l0_rules/`(engine.ts + presets.ts) | 静态正则黑名单(command/path/network),DEFAULT_L0_RULES |
| L1 | `lib/extra/security/l1_scorer/` + `lib/security/l1-scorer.ts` + `l1-model.ts` | LLM 风险评分,LocalScorerProvider / RemoteScorerProvider(`createScorerProvider`) |
| L2 | `lib/extra/security/l2_auth/manager.ts` + `lib/security/l2-decision-queue.ts` + `l2-index.ts` | 用户授权,持久化到 `l2_decisions` 表(P0.2 起从纯内存改为 DB backed) |

`gatekeeper.ts` 的 `SecurityGatekeeper` 串起三层。`lib/extra/security/types.ts` 还定义了 `UserType` 权限分级。

#### MCP、Skills、Soul、Memory

- **MCP**:`lib/mcp/builtin/` 提供 context7、firecrawl、github、web、index 等内置 MCP;`lib/mcp/tools/web-fetch.ts` 是工具桥;workflow 侧 `lib/workflow/agent/tools/mcp.ts` 动态加载用户配置的 MCP。
- **Skills**:`lib/extra/agent/skills/`(loader.ts + types.ts)负责磁盘技能加载;workflow 侧 `tools/skills/local.ts` 注册 `local_skill` 工具;根 `.agents/skills/` 是 OpenCode 技能(独立体系)。
- **Soul**:`app/api/soul/`(route.ts + `[sessionId]/route.ts`)写入 `sessions.soulContent`;`lib/memory/builtin.ts` 处理 `builtin_memories.key = 'SOUL'`。
- **Memory**:`lib/memory/` 三层:`builtin.ts`(AGENTS/SOUL/IDENTITY/USER)、`session.ts`(会话摘要版本)、`long-term.ts` + `recall.ts` + `search.ts` + `cross-reranker.ts`(向量召回 + 重排)。`extract.ts` 在 `afterResponse` 中异步抽取记忆(`lib/workflow/agent/index.ts:499`)。

#### 多节点调度(`lib/workflow/agent/dispatch.ts`)

`selectBestNode`(dispatch.ts:61)按 5 条规则选 agentd 节点:① 心跳 2 分钟内在线 ② 沙箱类型匹配 ③ `allowedNodes` 白名单 ④ 资源评分 CPU 35% + 内存 35% + 磁盘 20% + 负载 10% ⑤ 活跃任务数。返回 null 则 fallback 到 Vercel Sandbox。`AgentNodeStatus` 还带 P3.3 引入的 cgroup v2 聚合指标 `sandboxMemPeakTotal`(dispatch.ts:42-46)。详见 `MULTI-NODE-SCHEDULING.md`。

### API 契约

`middleware.ts` 是统一鉴权入口:除 `isLoginPath`、`isAlwaysBypassPath`(`/.well-known/workflow/*`、`/api/internal/im-stream`、静态资源)、`/api/bot/*`(IM webhook 自鉴权)、`/api/agentd/v1/*` 与 `/api/soul/*`(用 `AGENTD_API_KEY`)外,**所有路由强制用户 session**(Cookie 或 Bearer,middleware.ts:128)。`constantTimeEqual` 防时序攻击。503 表示 AUTH_SECRET 未配。

| 分组 | 端点示例 | 用途 | 鉴权 |
|------|----------|------|------|
| `/api/auth/*` | `login`, `pair-generate`, `pair-exchange`, `pair-revoke`, `cli-devices`, `users` | 登录、设备配对全流程、用户管理 | login 公开;其余 session |
| `/api/cli/*` | `chat`(POST)、`models`、`sessions`、`sessions/[id]/{messages,compact}`、`messages/[id]/metadata`、`preferences` | CLI 主通道:SSE 流、模型目录、会话镜像、消息版本 | Bearer + 设备吊销检查(`lib/cli/auth.ts:18`) |
| `/api/agentd/v1/*` | `nodes/{register,heartbeat,status}`、`tools/{exec,mcp-exec}`、`health`、`sessions/*`、`l1-score{,-batch}`、`l2`,`l2-confirm`、`review-logs`、`memories`、`sandboxes`、`agent-config`、`l0-rules`、`llm-proxy`、`blob`、`capabilities`、`knowledge`、`notifications`、`task-summaries`、`tool-activity-logs`、`vault`、`workspaces`、`decisions` | agentd 全量回调(register 见 `app/api/agentd/v1/nodes/register/route.ts:11`) | `AGENTD_API_KEY`(middleware.ts:76 `hasValidAgentdApiKey`) |
| `/api/soul/*` | `route.ts`、`[sessionId]/route.ts` | Soul 内容读写 | `AGENTD_API_KEY` |
| `/api/bot/*` | `[authSecret]/...`(IM webhook)、`test-connection` | IM 平台回调 | 各 adapter 自鉴权 |
| `/api/sessions/*` | `[id]/revert` | Web UI 会话操作 | session |
| `/api/messages/*` | `[messageId]` | 消息 CRUD | session |
| `/api/config/*` | `route.ts`、`audit-logs`、`l0-rules`、`monitoring`、`tool-activity-logs` | 配置读写、审计 | session |
| `/api/files/*`, `/api/vault/*`, `/api/knowledge/*` | `[id]`、`list/read`、`search` | 附件、加密 vault、RAG | session |
| `/api/notifications/*`, `/api/tasks/*`, `/api/sandbox/*`, `/api/internal/*`, `/api/pair/*` | — | 通知、任务历史、Vercel Sandbox、IM 内部流、配对 | session / 特殊 |

注:`/api/agentd/v1/nodes/register` 返回 `{ success, node_id, interval: 30 }`(`register/route.ts:53`),约定心跳间隔。

### 数据模型

Drizzle 配置(`drizzle.config.ts`):PostgreSQL、schema 入口 `lib/core/db/schema/index.ts`,13 张表 + 迁移在 `lib/core/db/migrations/`。需要 pgvector(`yarn db:ensure-vector`)。主要表:

```ts
// lib/core/db/schema/chat.ts:12
sessions: id(uuid pk), title, channel default 'web', externalThreadId,
  userId, model, systemPrompt, soulContent, status('active'|'completed'|'stopped'|'error'),
  workflowRunId, sandboxId, totalTokens default 0, latestTokenUsage(jsonb),
  metadata(jsonb), archived bool, createdAt, updatedAt

// chat.ts:41
messages: id(uuid pk), sessionId(→sessions cascade), uiMessageId,
  visibleInChat bool, role('user'|'assistant'|'summary'|'tool'|'system'),
  stepNumber int, payload(jsonb 非空), createdAt
  uniqueIndex (sessionId, uiMessageId)

// agentd.ts:13 — 工具执行任务
agentTasks: id, agentId, sessionId, userId, command, sandboxType default 'auto',
  sandboxId, source(jsonb), env(jsonb), timeout default 300,
  status('pending'|'reviewing'|'running'|'completed'|'failed'|'cancelled'),
  result, createdAt, updatedAt

// agentd.ts:45 — 三层审计
agentReviewLogs: id, taskId, userId, roles[], command, level('L0'|'L1'|'L2'),
  score int, decision('allowed'|'allowed_with_warning'|'blocked'|'pending_confirm'
    |'pending_l2'|'pending_l2_critical'|'approved'|'rejected'|'expired'),
  reason, createdAt

// agentd.ts:72 — 工具活动明细(索引丰富)
agentToolActivityLogs: id, taskId, sessionId, agentId, userId, roles[], source,
  sandboxId, model, step, toolCallId, toolName, action('read'|'write'|'execute'
    |'search'|'network'|'other'), target, arguments(jsonb), result(jsonb),
  outputText, success, error, durationMs, startedAt, completedAt, createdAt

// agentd.ts:119 — L0 规则库
agentL0Rules: id, agentId default 'global', pattern, type('command'|'path'|'network'),
  action('block'|'warn'), scope('workspace'|'global'), enabled bool, timestamps

// agentd.ts:137
agentSandboxes: id, agentId, type('docker'|'docker-strict'|'lxc'), path,
  status('creating'|'ready'|'destroyed'), persistent bool, timestamps

// agentd.ts:154 — 流式任务输出
agentTaskOutputs: id, taskId(text), sessionId, output, streamPosition default 0, createdAt

// agentd.ts:165
agentMemories: id, agentId, sessionId(cascade), userId, key, value, source,
  accessCount, createdAt   (idx: agent+user+created, agent+session+created)

// agentd.ts:202
workspaces: id, projectId unique, agentId, name, sandboxId, sandboxType,
  status('active'|'archived'), timestamps

// agentd.ts:222,256 — 任务摘要双表(active + archived,带 version)
taskSummaries / archivedTaskSummaries: id, taskId, agentId, sessionId, workspaceId,
  status('active'|'paused'|'completed'), progress, decisions(jsonb Decision[]),
  pending(jsonb string[]), knownIssues(jsonb string[]), version, isCurrent bool, lastUpdated, createdAt
  (archived 多 archivedAt)

// agentd.ts:277 — 节点注册表(多节点调度核心)
agentdNodes: nodeID(text pk), ip, port, sandboxes(jsonb string[]), version,
  status('online'|'offline'), cpuModel, cpuUsage, memAvail, diskAvail,
  activeTasks, activeSandboxes,
  sandboxMemCurrentTotal, sandboxMemPeakTotal, sandboxCpuUsecTotal,  // P3.3 cgroup 聚合
  lastHeartbeat, registeredAt

// l2-decisions.ts:22 — L2 持久化(P0.2 从内存改 DB)
l2Decisions: id, decisionId(unique), taskId, sessionId, agentId,
  type('l2_auth'|'question'|'conflict'|'branch'),
  status('pending'|'sent'|'resolved'|'denied'|'expired'|'timeout'),
  payload(jsonb), resolution(jsonb), resolvedBy, resolvedAt, nodeId, expiresAt(非空), timestamps

// memory.ts — 三层记忆
builtinMemories: key('AGENTS'|'SOUL'|'IDENTITY'|'USER') pk, content, updatedAt
sessionMemories: id, sessionId(cascade), content, summaryVersion, isCurrent, createdAt
longTermMemories: id, userId default 'system', key, content, memoryType('fact'|'preference'
    |'decision'|'conversation'), importance default 5, timestamps   (unique userId+key)
longTermMemoryChunks: id, memoryId(cascade), chunkIndex, content,
  embedding(vector), embeddingModel, embeddingDimensions, tsv(tsvector), lastAccessedAt, createdAt

// knowledge.ts — RAG(结构与 memory chunks 对称)
knowledgeBases: id, agentId, ownerUserId, visibility('team'|'private'), kind('local'|'remote'),
  priority, name, description, emoji, embeddingModel, embeddingDimensions, chunkSize, chunkOverlap, enabled
knowledgeDocuments: id, knowledgeBaseId(cascade), title, sourceType, sourceUri, contentHash, metadata
knowledgeConnectors: id, knowledgeBaseId(cascade), provider('url'|'mem0'|'http'), name, sourceUri,
  enabled, syncStatus('idle'|'syncing'|'failed'), lastDocumentId, lastSyncedAt, lastError, config
knowledgeChunks: id, knowledgeBaseId, documentId, chunkIndex, content, embedding(vector), tsv, ...

// 其他
scheduledTasks(scheduled.ts): id, sessionId, type('delay'|'daily'), title, prompt, timezone,
  dailyTime, nextRunAt, lastTriggeredAt, lastFiredFor, scheduleWorkflowRunId, lastChatRunId, active, metadata
cliDevices(cli-devices.ts): id, clawlessUserId(→users cascade), label, tokenJti(unique),
  pairedAt, lastSeenAt, revokedAt   // token 不入库,只存 jti 用于吊销校验
imAccounts(im-accounts.ts): id, clawlessUserId, adapter, imUserId, imUserName, pairedAt, unpairedAt
notifications(notification.ts): id, taskId, decisionId, notificationType('decision'|'completion'|'tidy_report'),
  payload, status('pending'|'sent'|'delivered'|'failed'|'fallback'|'expired'),
  channel, targetChatId, targetUserId, errorMessage, sentAt, deliveredAt, expiresAt
vaultEntries(vault.ts): id, key(unique), encryptedValue, nonce, createdByUserId, updatedByUserId
vaultAuditLogs: id, key, action, userId, createdAt
users, files(略)
```

`vector` 与 `tsvector` 通过 `customType` 自定义(`memory.ts:17-37`),依赖 pgvector 扩展。

### agentd(Go)架构

独立 module `github.com/clawless/agentd`,**Linux only**(`//go:build linux`),Go 1.26.2,依赖 Gin + Viper + charmbracelet(huh/lipgloss 用于 `-tui` 向导)。源码地图见 `subpackage/agentd/LAYOUT.MD`,关键源码:`internal/`。

#### 进程生命周期(`internal/lifecycle/`)

启动需 root(cgroup/namespace/sandbox),完成后 `internal/security/privilege.go` `DropPrivileges` 到 `[security].run_as_user`。三层 singleton 锁防止重复启动:`/var/run/agentd.sock`(主互斥)+ `/var/run/agentd.pid`(带活性探针)+ `server.listen` 端口探针;`kill -9` 后下次启动检测到 PID 死会自动清理。

#### 节点注册/心跳

启动后向 Web `POST /api/agentd/v1/nodes/register` 注册(`identity/` 持久化 `node_id_file`),之后每 `heartbeat_interval`(默认 30s)上报 CPU/内存/磁盘/活跃任务/沙箱数 + cgroup 聚合。Web 用 `agentdNodes` 表存储,`selectBestNode` 评分挑选。节点身份文件保留则重启后身份不变。

#### 沙箱(`internal/sandbox/`)

三档 provider(`manager.go` + `registry.go`):`docker_light.go`(Alpine,默认 `network_isolate`)、`docker_seccomp.go` + `docker_cli.go`(`docker-strict`,pinned images + `os_enforce`)、`lxc_persistent.go`(长生命周期,浏览器/git/多步开发)。配置见 `agentd.toml.example`:`[sandbox].default`、`docker_socket`(推荐 rootless,rootful 需 `allow_rootful_docker = true`)、`allowed_images`、`os_enforce`、`network_isolate`。辅助:`cgroup.go`(v2 采样)、`egress.go`(出网审计)、`health_check.go`、`reaper.go`(僵尸回收)、`workspace.go`、`media.go`、`skills.go`、`availability.go`。

#### L0/L1/L2 安全(`internal/security/`)

- `gatekeeper.go`:编排 L0→L1→L2 + 输出审计;`fail_open`(默认 false)控制 L1 出错时是否放行。
- `l0_rules/`:正则引擎 + command/path/network/output 默认预设。
- `l2_auth/`:L2 缓存 + 通知格式化,通过 Web `POST /api/agentd/v1/l2-confirm` 拿用户决定。
- `os_enforce/`:seccomp + capabilities drop + mount policy(strict 档位启用)。
- `privilege.go`:启动后降权。

#### Worker pool + 事件总线(`internal/eventbus/`, `internal/worker/`)

`eventbus/bus.go` 进程内 pub/sub。`worker/dispatcher.go` 把事件路由到多个动态 goroutine pool(`pool.go`,Asika-style,按 CPU/通道利用率 auto-scale)。`workers/` 按事件类型分:`exec_worker.go`(单 exec)、`batch_collector.go`(并行 `exec_batch`)、`tidy_worker.go`(周期任务摘要整理)。`writer.go` 缓冲输出。

#### Agent loop + 工具(`internal/agent/`)

CodeAct 风格:`loop.go` + `codeact.go` 实现 think→act→observe。工具注册在 `tools_register.go`,每个家族一个文件:`tools_exec.go`、`tools_file.go`、`tools_git.go`、`tools_web.go` + `tools_web_rendered.go`(渲染型搜索,LXC 装 Chromium)、`tools_memory.go`、`tools_knowledge.go`、`tools_browser_v2.go`(Playwright,与 Web `lib/mcp/tools/browser.ts` 对齐)、`tools_subagent.go`(`subagent_runner.go` goroutine 跑子代理)、`tools_task_summary.go`、`tools_sandbox_destroy.go`、`tools_skills.go`、`tools_media.go`、`tools_mcp.go`、`tools_vault.go`、`tools_deliver.go`、`tools_codeact.go`、`tools_misc.go`。`context.go` 上下文压缩,`question.go` 模型提问,`tool_activity.go` 写活动日志。`browser/` 是 Playwright 桥(`bridge.js` 通过 unix socket 通信,`node_install.sh` TUNA 镜像引导 node + SHA256 校验)。

#### HTTP 服务(`internal/server/`)

`routes.go` 在 Gin 上注册:`/health`、`/metrics`(无鉴权)+ `/api/v1` 组(`middleware.go` 顺序 CORS → RequestLogger → **MTLSMiddleware** → **APIKeyMiddleware**)。`/api/v1` 下 tasks/sessions/tools(read/write/edit/ls/grep/glob/patch/git/web-fetch/web-search/memory-search/memory-save/sandbox-install)/memories/agent-config/l0-rules/sandboxes/llm-proxy/l2-confirm。统一响应壳 `{ success, data, error }`。`exec_stream.go` 提供 SSE 流式长命令输出。

#### 其他模块

`internal/cache/`(本地 session blob + gzip + 上游同步重试,P0.4)、`internal/certs/`(`-gen-certs` CA+server+client)、`internal/clawless/`(Web REST client + `l1_client.go` L1 评分 client)、`internal/config/`(Viper TOML + 校验 + 热加载未在 main 启用)、`internal/persistence/`(任务后台存储 + kvstore + 任务流)、`internal/metrics/`(写 `/tmp/agentd/metrics.json`)、`internal/logging/`(slog `[module] [func:line] level message kv`)、`internal/session/`(LRU 淘汰 + 子代理状态)、`internal/system/`、`internal/usertype/`、`internal/i18n/`。

### CLI 架构

独立 Yarn Classic monorepo,Node `>=22.19.0`,4 个 package 构建顺序固定(ai → agent → agentboster-adapter → coding-agent)。基于 [pi](https://github.com/earendil-works/pi),bin 名 `agentboster`。**无直接 provider 模式**——所有 LLM 调用走 `POST /api/cli/chat`,SDK 包从 `packages/ai` 剥离约 90MB。

#### packages 职责

| Package | 关键源码 | 职责 |
|---------|----------|------|
| `@earendil-works/pi-coding-agent` | `coding-agent/src/cli.ts`(bin 入口)、`main.ts`、`modes/`、`core/`、`cli/`、`config.ts`、`migrations.ts`、`rpc-entry.ts` | bin、TUI、登录、session 管理、`--print` 模式、HTML export、扩展/技能/主题加载、RPC 自动化 |
| `@agentboster/adapter` | `agentboster-adapter/src/{auth,stream-fn,web-stream,models,preferences,security}.ts` | 替换 pi OAuth 为 `agentboster login`;`createAgentbosterStreamFn`/`openAgentbosterStream`(SSE→pi `AssistantMessageEvent`);`fetchRemoteModels`;`evaluateLocalCommand`(本机 L0/L2 策略) |
| `@earendil-works/pi-agent-core` | `agent/src/{agent,agent-loop,proxy,uuid,types}.ts` | 会话原语 |
| `@earendil-works/pi-ai` | `ai/src/{compat,models,types,index}.ts` + `utils/` | 类型层 + compat 桩(无 SDK) |

#### login 配对

`agentboster login [-u url] [--username/--password | --pair-code ABCD-1234]` → 写 `~/.agentboster/config.json`(server URL + bearer token + username)。token 的 `jti` 写入 Web `cli_devices` 表,UI 可吊销;每次请求 `withCliAuth`(`lib/cli/auth.ts:50`)查 DB 验证未吊销 + 更新 `lastSeenAt`。

#### `--print` 与 local_* 工具

非交互 `-p`/`--print` 跳过 TUI,只输出最终文本。CLI 仅执行 3 个本机工具:`local_exec`、`local_read_file`、`local_write_file`——Web workflow 通过 SSE `local-tool-request` chunk 下发,CLI 跑完 `POST /api/ai/[runId]/tool-result` 回传。每个 `local_*` 经 `evaluateLocalCommand` L0 拦截 + L2 TUI 确认。`--yolo` 跳过两层(仅本机工具,经 Web 派发到 agentd 的工具仍走完整 L0/L1/L2)。

#### session 镜像

CLI **不持久化**会话权威状态。`--continue/--resume/--session/--fork` 都通过 `/api/cli/sessions/{,messages}` 拉远程重建。本地 `$(tmpdir)/agentboster-sessions/`(注意不是 `~/.agentboster/`)仅存树状态(分支/回退)+ LLM 上下文窗口,退出即清;启动时清理上次崩溃残留。压缩经 adapter 流本地摘要后 `POST /api/cli/sessions/[id]/compact` 同步 Web。消息版本统一 `metadata.versions[] + currentVersionIndex`,旧 `editHistory/generationHistory` 由 `scripts/migrate-message-versions.ts`(postbuild 幂等)迁移。

#### 构建/打包

`yarn build`(tsgo 顺序编译)→ `yarn bundle`(esbuild 单文件 `agentboster.cjs`,主题/HTML 模板/marked/highlight 内联)→ `yarn package`(`agentboster-cli-<version>.tar.gz`,含 wrapper + cjs)。目标机只需 Node ≥22。

### 配置与依赖

#### Web 环境变量(README §环境变量)

| 变量 | 说明 |
|------|------|
| `AUTH_SECRET` | 登录 Cookie/JWT 签名密钥(必填) |
| `USERNAME` / `PASSWORD` | 内置登录账号(必填) |
| `DATABASE_URL` | Postgres 连接串(生产必填,Neon 等) |
| `BLOB_ACCESS` / `BLOB_READ_WRITE_TOKEN` | Vercel Blob 附件存储 |
| `AGENTD_API_KEY` | 与 daemon `[server].clawless_api_key` 一致;逗号分隔支持多 daemon/轮换 |
| `AGENTD_CLIENT_CERT_PATH` / `AGENTD_CLIENT_KEY_PATH` / `AGENTD_CA_PATH` | 仅 Web 主动访问 daemon 时启用 mTLS |
| `TAVILY_API_KEY` | 可选,联网搜索 |

#### CLI 环境变量(`subpackage/cli/README.md` §环境变量)

| 变量 | 用途 |
|------|------|
| `AGENTBOSTER_HOME` | 覆盖 `~/.agentboster`(config + sessions 根) |
| `AGENTBOSTER_SESSION_ID` | 固定 session id(调试) |
| `AGENTBOSTER_CLIENT_ID` | 覆盖设备标签 |
| `AGENTBOSTER_MODEL` | 默认模型 |
| `PI_OFFLINE=1` | 跳过启动网络 |
| `PI_PACKAGE_DIR` / `PI_TIMING=1` | 资源根 / 计时诊断 |

#### agentd 配置(`agentd.toml`,Viper + `AGENTD_<SECTION>_<KEY>` 覆盖)

`[server]`(listen、tls_cert_path/tls_key_path、ca_path、clawless_api_key);`[clawless]`(base_url、client_cert_path/client_key_path/ca_path、heartbeat_interval);`[security]`(l1_enabled、fail_open、l1_provider、l1_endpoint/model/api_key、run_as_user、`l1_threshold.{low=0.3,medium=0.7,high=0.9}`);`[tools]`(disabled[]);`[sandbox]`(default、docker_socket、allow_rootful_docker、docker_image、docker_default_cpu/memory、docker_strict_cpu/memory、lxc_default_distro/release/rootfs_base、allowed_images[]、os_enforce、seccomp_profile_path、network_isolate);`[cache]`、`[session]`、`[worker]/[worker_pool]`、`[logging]`。详见 `agentd/agentd.toml.example`。

#### 关键依赖

**Web(`package.json`)**:
- 框架:`next@15.5.9`、`react@^19.2.6`、`react-dom@^19.2.6`
- AI:`ai@^6.0.197`、`@workflow/ai@^5.0.0`、`workflow@^4.3.1`、`@ai-sdk/{anthropic,google,openai,openai-compatible,mcp,react}`
- DB:`drizzle-orm@^0.45.2`、`@neondatabase/serverless@^1.0.2`
- IM:`chat@4.29.0` + `@chat-adapter/{discord,gchat,slack,telegram,teams,state-redis}@4.29.0`、`@larksuiteoapi/node-sdk`、`qq-official-bot`
- Vercel:`@vercel/{blob,queue,sandbox,analytics,speed-insights}`、`@upstash/redis`
- UI:shadcn(`@radix-ui/*`)、`tailwindcss@^3.4.19`、`framer-motion`、`lucide-react`、CodeMirror 6、`react-markdown` + `remark-gfm`
- 其他:`isomorphic-git`、`bcryptjs`、`zod@^4.3.6`、`ofetch`、`gray-matter`、`cron@^4.4.0`
- dev:`typescript@^6.0.2`、`@biomejs/biome@2.4.16`、`drizzle-kit@^0.31.10`、`vitest@^3.0.0`、`shadcn@^4.2.0`、`tsx`

**agentd(`go.mod`)**:Go 1.26.2;直接依赖 `gin-gonic/gin@v1.12.0`、`spf13/viper@v1.21.0`、`fsnotify/fsnotify@v1.9.0`、`google/uuid@v1.6.0`、`nicksnyder/go-i18n/v2`、`charmbracelet/{huh,lipgloss}`;间接含 `charmbracelet/bubbletea`(TUI)、`quic-go/quic-go`、`golang.org/x/{net,text,crypto,sys,sync,arch}`。无 ORM——通过 `internal/clawless` REST client 与 Web 同步,本地不存 Postgres。

**CLI(`cli/package.json`)**:`packageManager yarn@1.22.22`、TypeScript ESM、Biome 2.3.5、`@typescript/native-preview@7.0.0.0-dev`(tsgo)、Node `>=22.19.0`;dev 依赖 `@anthropic-ai/sandbox-runtime@0.0.26`、`esbuild@0.28.1`、`jiti@2.7.0`、`shx@0.4.0`、`tsx@4.22.1`、`husky@9.1.7`。运行时依赖在各子 package(基于 pi:`@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui}`)。

---


## memoh 深度剖析

> 仓库:`memohai/Memoh`(通称 Memoh)。版权 `Copyright (C) 2026 MemohAI`,AGPLv3。所有结论基于实际抓取的 GitHub README/DEPLOYMENT/目录树/LICENSE、`docs.memoh.ai`、`memohai/supermarket`、`memohai/twilight-ai` 等页面。截至 2026-06-30,主仓 ~2k star / 185 fork / 53 releases(v0.14.0 最新,2026-06-24)、1140 commits。

### 1. 项目背景、定位与目标用户

| 维度 | 内容 |
|---|---|
| 一句话定位 | "Give every AI agent its own cloud computer" — 每个 agent 拥有独立的容器化"云电脑":文件系统 + 桌面 + 浏览器 + 网络 + 长期记忆 |
| 自我分类 | 开源多 agent 平台(open-source multi-agent platform) |
| 解决的核心问题 | AI agent 通常无状态、不常驻、无独立执行环境;Memoh 让 agent **7×24 在线**,即使笔记本关机也能持续服务;并解决隔离(每 bot 一容器)、记忆跨会话/跨平台、多渠道接入三大痛点 |
| 灵感/类比 | "agent as a computer" + 个人助理(AI companion / personal-assistant);副仓 `twilight-ai` 明确对标 Vercel AI SDK |
| 目标用户 | 个人(一个 bot)、家庭(一人一个)、团队(成员各配一个)、车队(fleet,一台机器跑一群) |
| Topics 标签 | `agent` `ai` `personal-assistant` `ai-memory` `ai-companion` |

### 2. 完整架构

Memoh 是**单进程平台 + 容器化工作区**的混合架构:

```
┌─────────────────────────────────────────────────────────────┐
│  Platform 进程 (memoh-server,Go,默认 8080 API / 8082 Web)   │
│  ─ accounts / bots / acl / auth(jwt)/ oauthclients          │
│  ─ channel(10+ IM 接入) + messaging + conversation          │
│  ─ agent(内置) + acpagent/acpclient/acpprofile/acpfeedback  │
│  ─ memory(+ Qdrant 向量检索 / Mem0 / OpenViking)            │
│  ─ skills / plugins / mcp / hooks / pipeline / capabilities │
│  ─ container / workspace / display / network(管理 bot 容器)│
│  ─ schedule / heartbeat / decision / toolapproval           │
│  ─ in-process Twilight AI SDK 作为推理引擎                   │
└─────────────────────────────────────────────────────────────┘
              │ 每-bot 启动一个隔离容器(containerd/docker/apple/kata)
              ▼
┌─────────────────────────────────────────────────────────────┐
│  Bot Workspace(container)                                    │
│  独立 FS / 独立网络(CNI + 可选 Tailscale/NetBird overlay) │
│  可选:headed Chrome(CDP)、Xvnc/RFB 桌面、WebRTC 投屏        │
│  运行:内置 agent 工具 / ACP 托管的外部 coding agent        │
└─────────────────────────────────────────────────────────────┘
```

要点拆解:

- **平台进程**:`internal/` 下约 60 个子模块(`accounts`/`bots`/`acl`/`channel`/`conversation`/`memory`/`schedule`/`toolapproval`…),AI agent 直接 in-process 跑在 `server` 内(DEPLOYMENT.md 原文)。
- **工作区容器(Workspace)**:`internal/container` + `internal/workspace` 管理;每个 bot 独立文件系统、网络、桌面、浏览器。
- **Twilight AI SDK**:`github.com/memohai/twilight-ai`(Apache-2.0,Go 1.25+,45 star)。提供 `GenerateText/StreamText/Embed/GenerateImage/EditImage/GenerateVideo/GenerateSpeech/StreamSpeech`,Provider-agnostic(OpenAI Chat Completions / Responses / Codex / OpenRouter / Anthropic / Google Gemini / Edge TTS / Deepgram / ElevenLabs / MiniMax / CosyVoice / Volcengine 等),内建 tool calling、MCP 客户端、approval 流程。
- **ACP(Agent Communication Protocol)托管**:见 `internal/acpagent`、`acpclient`、`acpfeedback`、`acpprofile`。把外部 coding agent 当作 ACP 兼容端点接入,会话类型 `acp_agent`,与普通 chat/discuss 隔离。当前明确支持 **Codex** 与 **Claude Code**,官方说明这些是"已支持的接入路径"而非排他。
- **Browser Use / Computer Use**:容器内跑 headed Chromium(经 CDP)+ Xvnc/RFB 桌面,Web UI 通过 WebRTC 投屏;Headless Playwright 仍可当普通工具用。

### 3. 技术栈细节

| 语言 | 占比 | 职责 |
|---|---|---|
| **Go** | 65.5% | 平台后端 `memoh-server`、`internal/*`、所有 `cmd/*` 二进制、Twilight AI 引擎 |
| **Vue** | 16.7% | Web UI(`apps/web`)与桌面端(`apps/desktop`);Supermarket 前端也用 Vue |
| **TypeScript** | 13.9% | `packages/{sdk,ui,icons,config}`、Supermarket 前端与 Nitro API、openapi-ts 生成 |
| CSS | 1.1% | UI 样式 |
| Shell | 1.0% | `curl -fsSL https://memoh.sh \| sh` 安装脚本、CN mirror 覆盖层 |
| PLpgSQL | 0.9% | `db/` 迁移与 sqlc 生成的查询 |
| Other | 0.9% | 配置/Markdown 等 |

- **Rust crates**:`crates/` 目录下目前仅有一个 `a11y-cli`(无障碍/辅助命令行工具,空目录提示处于早期)。属于探索性嵌入,并非核心。
- **Postgres + sqlc**:`sqlc.yaml` + `db/`(PLpgSQL 迁移),编译期生成类型安全 Go 查询;`database.driver` 可选 `postgres`(默认)或 `sqlite`(单节点轻量部署)。
- **pnpm workspace**:`pnpm-workspace.yaml` 统管前端与 TS 包,workspace 成员为 `apps/{web,desktop}` 与 `packages/{config,icons,sdk,ui}`;后端走 Go module + `mise.toml`。
- **容器运行时**:首选 `containerd`(官方镜像内嵌),其次 `docker`、`apple`(macOS 本地实验)、Kata(`io.containerd.kata.v2`,需 Linux/KVM)。
- **记忆栈**:Qdrant(向量)+ Sparse(神经稀疏检索)为 Compose profile,可换成 SaaS 的 Mem0 / OpenViking。

### 4. 目录结构职责

| 路径 | 角色 |
|---|---|
| `apps/web` | Vue Web UI(localhost:8082) |
| `apps/desktop` | macOS/Windows/Linux 原生桌面客户端(自带本地 server + 内嵌 Qdrant) |
| `cmd/memoh` | 主平台二进制入口 |
| `cmd/agent` | 独立 agent 进程入口 |
| `cmd/bridge` | mTLS 桥接进程(配合 `gen-bridge-mtls`);与外部/多节点通信 |
| `cmd/synccaps` | capabilities 同步工具 |
| `internal/*` | 平台核心(~60 子模块),见 §2 架构清单 |
| `packages/{sdk,ui,icons,config}` | 前端共享 TS 包;`sdk` 为对外 TypeScript SDK |
| `crates/a11y-cli` | Rust 无障碍 CLI(占位/早期) |
| `db/` | Postgres 迁移 + sqlc 生成代码 |
| `conf/` | 配置模板:`app.docker.toml`、`app.kata.docker.toml` |
| `docker/` | `docker-compose.cn.yml`(CN 镜像覆盖层)等 |
| `spec/` | 协议/接口规范 |

### 5. 部署方式

| 方式 | 命令/产物 | 说明 |
|---|---|---|
| 一键脚本 | `curl -fsSL https://memoh.sh \| sh` | 交互式生成 `config.toml`,默认 containerd 后端;CN 加速:`USE_CN_MIRROR=true`;**不要 sudo 整体执行** |
| SQLite 轻量 | `curl … \| MEMOH_DATABASE_DRIVER=sqlite sh` | 单节点,数据落 `memoh_data` 卷 |
| Docker Compose 手动 | `cp conf/app.docker.toml config.toml && docker compose up -d` | 启动 `postgres/migrate/server/web`,可选 `--profile qdrant --profile sparse` |
| Kata 强隔离 | `-f docker-compose.yml -f docker-compose.kata.yml` | Linux/KVM + Kata Containers,VM 级隔离 |
| Compose profile | `qdrant`(向量库)、`sparse`(稀疏检索) | AI agent 始终 in-process 跑在 server |
| Memoh Cloud SaaS | `memoh.ai/waitlist` | "coming soon",零运维 always-on |
| 桌面客户端 | `memoh.ai/desktop` | 启动本地 `127.0.0.1:18731` 的 `memoh-server` + 内嵌 Qdrant |

- 默认口令 `admin/admin123`,**生产必须改**。Web UI `:8082`,API `:8080`。

### 6. 容器隔离与长期记忆

**隔离机制(按 agent)**

| 维度 | 实现 |
|---|---|
| 文件系统 | 每 bot 独立容器 + overlayfs 快照;`data_root`/`runtime_dir` 分离;Bot Files 功能在 UI 直接浏览/编辑工作区 |
| 网络 | 双层:Runtime(CNI 或 Docker 桥接)+ Overlay(可选 Tailscale / NetBird,**每 bot 私有 overlay**) |
| 桌面 | Xvnc/RFB 提供 VNC 桌面,WebRTC 投到前端 |
| 浏览器 | 容器内 headed Chrome/Chromium via CDP,与宿主完全隔离 |
| 强隔离(可选) | Kata Containers + KVM,把 workspace 塞进轻量 VM |
| 本地受信模式 | `[local] enabled=true` 时跑在宿主,**无容器隔离**,仅限桌面/本地实验 |

**长期记忆(跨会话/跨平台)**

- 内置 memory:每 bot 持久化记忆条目,Qdrant 做语义检索,Sparse 做神经稀疏检索。
- 可插拔 provider:`Mem0`(SaaS)、`OpenViking`(SaaS 或自托管)。
- 跨 IM 平台身份绑定:同一 bot 绑多个渠道后,记忆与上下文跨 Telegram/Discord/微信/Web 共享。
- 上下文压缩:`internal/compaction` + `contextlimit` + `prune` 主动裁剪。

### 7. 多渠道接入清单

共 **11 个官方文档渠道**(README 宣称 "10+"):

| # | 渠道 | # | 渠道 |
|---|---|---|---|
| 1 | Slack | 7 | Misskey |
| 2 | Telegram | 8 | DingTalk |
| 3 | Feishu / Lark | 9 | WeCom(企业微信) |
| 4 | Discord | 10 | WeChat(微信) |
| 5 | QQ | 11 | WeChat Official Account(公众号) |
| 6 | Matrix | + | Email / Web UI(内置) |

### 8. 扩展机制

| 机制 | 说明 |
|---|---|
| **Skills** | 模块化提示词包,带 YAML frontmatter,可委派给子 agent;装在 bot 工作区 |
| **Supermarket** | `memohai/supermarket`(Apache-2.0,8 star),官方 Plugin & Skill & MCP Registry |
| **Plugins** | `plugin.yaml` manifest + 可选 `hooks.json`/`scripts/`/`skills/`;声明 `capabilities`、`install`、`auth_requirements`、内嵌 `mcps` |
| **MCP** | 一等公民:Twilight AI 内建 MCP 客户端;Memoh 平台层让每个 bot 自管 MCP 连接 |
| **Hooks** | `internal/hooks` + 插件级 `hooks.json`,绑定自动化规则 |

### 9. 安全模型

- **容器隔离为主**:`containerd` 默认 + CNI 网络隔离 + 可选 Tailscale/NetBird overlay + Kata VM 强隔离。
- **细粒度审批为辅**:`internal/toolapproval` + `internal/policy` + Twilight AI 的 approval flow 实现 human-in-the-loop。
- **特权容器警告**:DEPLOYMENT.md 明确主服务为特权容器,生产必须改默认口令、上 HTTPS、设防火墙。
- **LICENSE 含义(AGPLv3)**:强 copyleft + 网络服务条款(第 13 条):任何通过网络提供服务的**修改版**必须向其用户公开对应源码。

### 10. 活跃度与文档完整度

| 指标 | 数值 |
|---|---|
| Stars / Forks | ~2k / 185 |
| Commits / Releases | 1,140+ / 53(v0.14.0 @ 2026-06-24) |
| 子项目 | twilight-ai(45★)、supermarket(8★) |
| 文档完整度 | 高:`docs.memoh.ai`(Guides 18 篇 / Integrations / Self-hosted),中英双语 |
| 多语言 README | English / 简体中文 / 日本語 |
| 社区 | Telegram `t.me/memohai`、X `@memoh_ai` |

### 11. 与 agentboster 的本质差异

| 维度 | Memoh | agentboster |
|---|---|---|
| 核心范式 | **每 agent 一容器**(计算机即隔离单元);agent = 常驻个体 | **硬分层权威中心**:Web + `agentd` 守护节点 + `cli` 子仓 |
| 隔离边界 | 容器(containerd/Docker/Kata)+ per-bot overlay 网络 | Workflow 沙箱 + mTLS daemon(`agentd`)+ 多节点调度 |
| 推理引擎 | 自研 `twilight-ai`(Go 版 Vercel AI SDK)内嵌 | 直接用 Vercel AI SDK + Workflow DevKit(TS) |
| Agent 编排 | 单 bot 内置 agent + ACP 托管外部 coding agent | `.agents/skills`(多智能体流水线)+ Workflow `'use step'` |
| 数据层 | Postgres/SQLite + sqlc + Qdrant + Sparse | Postgres + Drizzle + pgvector |
| License | AGPLv3(主仓强 copyleft,商业 SaaS 受限) | MIT |

**一句话总结**:Memoh 把"每个 agent 拥有自己的一台云电脑"作为卖点,以**容器即隔离**为核心抽象,偏个人/常驻助理;agentboster 则以**硬分层权威中心 + 多节点调度 + Workflow 沙箱**为核心抽象,偏工程化的多 agent 编排与分布式部署。两者在隔离哲学(横向每-agent 容器 vs 纵向分层权威)上呈结构性差异。

---

## manboster 深度剖析

### 1. 项目背景与定位

**Manboster**(Manbo + Lobster)自称「Meet Your Personal AI Agent Manbo Lobster」,由 `chihuo2104` 主导,代号「龙虾」。

- **灵感来源**:README 明确「Inspired by IronClaw and OpenClaw, we've built a lobster more securely!」。命名风格(Claw→Lobster)显示它是对 OpenClaw 系的「更安全替代方案」回应。
- **目标用户**:文档 `why.html` TL;DR——「designed for individual or small team use, not suitable for big companies」。
- **当前阶段**:README 自述「only shows as a MVP now」,最新 `v0.2.3`(2026-06-22)。Quickstart 警告「It's not production-ready until `v1.0.0` releases in about September 2026」。
- **手工打造姿态**:强调「code is mainly written by human, with AIs written in helper functions and boilerplate」,核心安全模块绝不 vibe coding——鲜明的工程伦理宣示。

### 2. 核心差异化:安全(Hachimi + Gatekeeper)

文档 `why.html` 原话:「Hachimi is the most innovative point in all AI agents」。

#### 2.1 Hachimi 本地守护模型

- **本质**:运行在用户设备本地的「判官模型」(guard model),评估云端 LLM 提出的工具调用是否安全。
- **运行方式**:默认 GGUF 模型(`Qwen3 Guard Gen 0.6B`,约 400MB),通过 `llama.cpp` + CGO FFI(自研 `yzma` 加载器)本地加载。
- **懒加载 + TTL 卸载**:15 分钟无请求自动卸载,空闲 40~50MB,加载后视上下文 250MB~1.1GB。
- **上下文档位**:Low(1k,150MB)/ Medium(2k,250MB)/ High(4k,450MB)/ x-High(8k,850MB),超长消息 fallback 回人类决策。
- **可视化状态**:emoji 标注——`🐱➖`(未激活)、`🐱✅`(安全)、`🐱❓`(可疑)、`🐱❌`(拒绝)。
- **官方免责**:反复强调 transformer 局限,「could not tackle advanced and complex prompt engineering so do not trust it absolutely」。

#### 2.2 Gatekeeper 零信任网关

严格的 8 步执行流(模块**不可禁用**):

1. 云端 LLM 工具调用强制路由进 Gatekeeper。
2. 按 tool declaration 校验参数。
3. 评估用户访问级别,不足即自动拒绝。
4. 命中授权缓存则放行。
5. 未缓存则弹「决策表单」给用户。
6. **TTL 机制**:授权表单有效期 10 分钟,超时自动拒绝。
7. 用户三选项:**Approve**(10 分钟全部放行 / 按工具 30~120 分钟)/ **Delegate to Hachimi**(本次 / 1 小时全委托)/ **Reject**(15 分钟 / 本 session 全拒)。
8. 手动拒绝即中止。

会话级拒绝**只影响当前 session**,其它活跃 chat 不受影响。配合 `MessageFromCron / MessageFromCronIgnore` 双轨 flag,Cron 触发与人工消息走不同路径。

#### 2.3 Vault 凭据隔离

README 第 8 条明确:**「A built-in vault tool ... LLM NEVER has access to your credentials」**。架构层面 LLM 永不接触凭据,vault 在工具调用边界之外完成注入。

### 3. 技术栈

- **语言**:Go **99.3%**。
- **构建/发布**:`.goreleaser.yaml` + GitHub Actions,产物 `manboster-{Version}-{channel}-{commit}-{platform}-{arch}`。
- **平台覆盖**:darwin-arm64/amd64、win-amd64/arm64、linux-arm64/amd64/**riscv64**。
- **Headless 浏览器**:`go-rod` 驱动内置 web search(可走自架搜索 API 或直接爬网页)。
- **插件沙箱**:`extism`/wasm(JS/Python 脚本统一在 wasm sandbox 内执行)。
- **TUI 框架**:`huh`。
- **守护模型加载**:CGO + llama.cpp FFI(yzma),支持 YZMA 容器格式。
- **i18n**:Crowdin 平台协同翻译。

### 4. 目录结构

```
manboster/
├── cmd/
│   ├── manboster/      # 主入口(用户运行)
│   └── manbodev/       # 开发者辅助工具(用于开发 .manboplugin)
├── internal/           # 不对外暴露的实现细节
│   ├── chat/ cli/ config/ database/ downloader/
│   ├── engine/         # 推理引擎 + pre/post processor
│   ├── fs/             # manboFS(避免 DB overflow)
│   ├── hachimi/        # 守护模型加载与评估
│   ├── i18n/ llm/ loader/ plugin/ repository/
│   ├── session/        # compaction、retry
│   ├── skill/          # OpenClaw skills 兼容层
│   └── tool/           # websearch/requests/file/memory/shell/datetime/cron
├── spec/               # 接口/契约声明(chat & LLM providers、cli provider、schema)
├── .github/workflows/  # CI(goreleaser、canary、crowdin)
├── .goreleaser.yaml / Dockerfile(alpine 变体) / Makefile
└── go.mod / go.sum
```

### 5. 部署形态

| 方式 | 说明 |
|---|---|
| GitHub Releases | 二进制命名规范,SHA256 校验可选;macOS 推荐 `darwin-arm64` |
| `go install` | `go install github.com/manboster/manboster/cmd/manboster@latest` |
| 包管理器 | Homebrew(第三方 `MZWNET/tap`)、AOSC OS `oma install manboster` |
| 容器化 | `Dockerfile` + alpine 变体,文档 `/docs/container.html` |
| Daemon 模式 | `manboster start/stop/restart/status/log` |

首次运行触发 **Configuration Wizard**(基于 huh TUI)。后续修改:`manboster config`;`manboster skills install SKILLS.md`。卸载=删二进制;彻底清理=`rm -rf ~/.manboster`。

### 6. LLM Provider 支持

1. **OpenRouter**(推荐入口)
2. **Kimi**(K2.6)
3. **DeepSeek**(V4 Pro/Flash;release notes 自述「Generated by Manboster powered by DeepSeek V4 Flash」——dogfooding)
4. **OpenAI 兼容 API**(通用兜底)

另提及 Xiaomi MiMo v2.5 系列。`internal/llm/` 是 provider 抽象层,`spec/` 中声明接口契约。

### 7. 接入渠道

- **当前**:**仅 Telegram**。能力完整——markdown entities 解析、reaction 通知(三态)、HTML 转换器、forward 解析、多模态图像(v0.2.0-rc)。
- **规划中**:飞书/Lark 是下一个待落地渠道。

### 8. 扩展性

| 能力 | 状态 |
|------|------|
| wasm 插件沙箱(extism) | Planned |
| OpenClaw skills 兼容 | Work in Progress(`manboster skills install`) |
| MCP | Planned |
| 脚本沙箱(JS/Python in wasm) | Work in Progress |
| Vault 凭据隔离 | Work in Progress |
| RAG 记忆 / mem0 | Planned |
| UI/Input 交互模拟 + 截图 | Planned |
| **MamboHub**(分发中心,兼容 ClawHub) | Planned |
| `.manboplugin` + `manbodev` | Planned |

内置工具:system info / shell exec / web browser(go-rod)/ memory(KV & Markdown)/ file(只读+ACL)/ datetime / **cron**(persistent 表达式 + `+5m/+3h/+7d` delay)/ requests / file grep & replace。均可通过 `manboster config` 启停。

### 9. 持久化与记忆

- **数据库**:`internal/database/`,至少三张表:chat_data(含 cost 追踪)、Cron、Soul(`SOUL.md` 人格镜像)。
- **manboFS**:`internal/fs/`,v0.2.0-rc 引入「to avoid database overflow」,把大对象/文件落盘,只把元数据入库。**具体存储引擎未在材料中明确,推测 SQLite/BoltDB**。
- **记忆**:RAG 与 mem0 均 Planned,当前仅 KV + Markdown memory tool 的「短期记忆」。

### 10. Apache-2.0 协议含义

README/GitHub 侧栏/文档页脚一致声明 **Apache License 2.0**(业界最宽松、对商业最友好之一):

- **允许**:商用、闭源衍生、修改、分发、私有化使用。
- **要求**:保留版权/声明、附 LICENSE 副本、声明显著修改的文件。
- **关键条款**:显式授予专利权 + 专利报复条款——对企业用户尤其重要。
- **对比**:比 MIT/BSD 多专利保护;比 GPL 不传染,可闭源衍生。

适合二次开发商用——与「个人/小团队」定位略有张力,但给生态衍生留了口子。

### 11. 项目活跃度

| 指标 | 数值 |
|------|------|
| Stars / Forks | 20 / 0 |
| Commits / Releases | 461 / 9 |
| 主贡献者 | chihuo2104(独立 GPG 签名,key ID `247A7FDADEC5B569`) |
| 最新版本 | v0.2.3(2026-06-22) |
| 首版 | v0.0.1(2026-04-21) |

2 个月内 9 个 release,v0.2.x 是 onboarding 连续 hotfix。Fork 0、Star 20 说明**仍属早期作者驱动项目**,但提交密度与 GPG 签名规范显示作者工程素养较高。Release 渠道分明:`stable` / `rc` / `canary`(滚动预览)。

### 12. 与 agentboster 的对照

**相似点(安全思路)**:都把「LLM 不可信」作为第一性原则——agentboster 用 mTLS + Workflow 沙箱;Manboster 用 Gatekeeper + Hachimi。**两者都拒绝把凭据/网络直接交给 LLM**。

**差异点(架构分层)**:

| 维度 | Manboster | agentboster |
|------|-----------|-------------|
| 形态 | **单二进制**(Go,99%) | **三层**:Web + cli + agentd |
| 守护模型 | **Hachimi**(本地 GGUF,首创) | 无本地判官模型,靠沙箱边界 + mTLS |
| 渠道 | 仅 Telegram | Discord 优先 + 多 IM |
| 工作流 | 内置 cron + session compaction | **Workflow Devkit**(durable workflow) |
| 插件 | wasm/extism(Planned) | OpenCode skills + MCP |
| 目标用户 | 个人/小团队 | 偏向 Web 产品化部署 |

**一句话总结**:Manboster 是「单兵极简、安全至上」的 Go 个人 agent;agentboster 是「Web 三层、workflow + 多渠道」的产品化平台。两者在「LLM 零信任」上思路同源,在交付形态上完全分叉。

### 13. 风险与不确定项

- **快速迭代中的不稳定性**:v0.2.1→v0.2.3 三连 hotfix 全为 onboard bug,生产前不建议(官方明示 v1.0 前 unstable)。
- **Hachimi 是双刃剑**:官方自承无法对抗高级 prompt engineering,且 768MB+ 内存门槛对低端设备不友好。
- **多关键能力仍在 Planned**:MCP、RAG、wasm 插件、MamboHub、`.manboplugin`、飞书渠道——当前可用的「真正差异化」其实只有 Hachimi + Gatekeeper + 单二进制三点。
- **社区规模小**:20★、0 fork,巴士因子低。
- **数据库引擎未明**:推测为 SQLite/BBolt 之一,未找到直接证据。

---

## picoclaw 深度剖析

### 1. 项目背景与核心叙事

**PicoClaw** 由深圳**矽速科技(Sipeed)** 发起,纯 **Go** 从零编写,定位"超轻量个人 AI 助手"。官方口号:**"$10 硬件 · 10MB 内存 · 毫秒级启动"**。

README 明确受 [HKUDS/NanoBot](https://github.com/HKUDS/nanobot)(Python)启发,但**并非 fork**,而是"自我引导(self-bootstrapping)"重建:约 **95% 核心代码由 AI Agent 生成**,再经人工审阅精修。

**目标场景**:(1) 嵌入式边缘 SBC;(2) 旧设备复刻(老旧安卓);(3) Termux;(4) 传统 Linux 服务器/桌面。对比表凸显差异化:

| 维度 | OpenClaw(TS) | NanoBot(Py) | **PicoClaw(Go)** |
|---|---|---|---|
| 内存 | >1GB | >100MB | **<10MB** |
| 启动(0.8GHz) | >500s | >30s | **<1s** |
| 成本 | Mac Mini $599 | ~$50 Linux 板 | **$10 起** |

### 2. 完整架构:单进程 + 双模态

**单 Go 二进制**设计,内部三块:

- **核心 Agent 引擎**(`cmd/picoclaw` + `pkg/agent/*`):`AgentLoop` 编排器 + `AgentInstance` 状态容器 + `Pipeline`(SetupTurn → CallLLM → ExecuteTools → Finalize)+ `ContextBuilder`。
- **Gateway**:运行时编排器,默认 `127.0.0.1:18790` 承载所有 webhook 类 Channel 的 HTTP 服务。Feishu 走 WebSocket/SDK,不占共享 HTTP。
- **WebUI Launcher**:独立前端(`web/frontend`,React + pnpm),双击 `picoclaw-launcher` 起服务,浏览器访问 `http://localhost:18800`;`-public` 监听全部网卡。

启动流程:**配置 Provider → 配置 Channel → 启动 Gateway → 对话**。

### 3. 技术栈与构建系统

- **语言占比**:Go **89.8%** / TypeScript **9.5%** / Makefile 0.3% / Shell 0.3% / CSS 0.1% / Inno Setup 痕量。
- **构建工具**:Go 1.25+、Node 22+、pnpm 10.33.0+;`Makefile` 提供 `make deps / build / build-launcher / build-all / build-pi-zero / install`;`.goreleaser.yaml` 多平台 release;`.golangci.yaml` 静态检查。
- **跨架构矩阵**:x86_64、ARM64、ARMv7、RISC-V、MIPS、LoongArch;支持 Linux/Darwin/Windows(含托盘)/Android。
- **Docker Compose**:`docker/docker-compose.yml` 配 `--profile launcher`,首跑自动生成 `config.json` 然后退出,改完 API key 再 `up -d`。

### 4. 模块化配置体系

配置 `~/.picoclaw/config.json`,schema **Version 3**,关键顶层键:

- `agents.defaults`:默认模型、agent 定义、系统提示。
- `model_list`:Provider 列表(协议前缀式),支持 `APIKeys` 多 key 自动展开与负载均衡。
- `gateway`:`host`、`port`、`log_level`(debug/info/warn/error/fatal,默认 warn,可由 `PICOCLAW_LOG_LEVEL` 覆盖)。
- `tools.web`:Web 搜索引擎与 key。
- `tools.mcp.servers`:MCP 服务声明(stdio/SSE/HTTP)。
- `tools.skills.registries`:ClawHub + GitHub 注册中心。
- `isolation` / `RestrictToWorkspace`:文件系统沙箱开关。
- `cron`:定时任务清单。

敏感字段下沉到 **`.security.yml`** 叠加层,加载时 `loadSecurityConfig` 优先采用,以 `fileutil.WriteFileAtomic` 0600 原子写入。

### 5. Agent 高级能力(v0.2.4 架构重构)

v0.2.4 引入的四大支柱:

- **SubTurn**:工具派生**隔离的临时 Agent 循环**处理子任务。`ephemeralSessionStore` 最多保留 50 条消息自动截断;**最大嵌套深度 3**,每父 turn **最多 5 个并发**(信号量 30s 超时);`Async:true` 时结果投递到 `pendingResults`(buffer 16);`Critical:true` 时父任务结束仍续跑,失败则发 **Orphan Result** 事件。
- **Hooks**:事件驱动钩子,含 `BeforeTool`、`ApproveTool`(批准门)、`AfterTool`,v0.2.6 增加 `respond` 动作,可改写或拦截工具结果。
- **Steering**:在工具调用之间向运行中的 Agent 循环**注入消息**,通过 `steeringQueue` 实现"同会话串行、跨会话并行";worker 自带 drain。
- **EventBus**(`pkg/events`):统一运行时事件总线,发射 `agent.subturn.spawn/end/result_delivered/orphan` 等结构化事件。
- **spawn 子代理 / 异步任务**:`spawn_status` CLI 子命令查询状态。
- **Cron 调度**:一次性("10 分钟后提醒")、循环("每 2 小时")、cron 表达式("每日 9 点");v0.2.3 引入 **Cron security gating**(命令型 job 须显式放行);CLI `cron list/add/disable/remove`。

### 6. Provider 层(30+ 模型供应商)

README 表格列出 24 个具名 Provider:OpenAI、Anthropic、Google Gemini、OpenRouter(200+ 模型)、Zhipu(GLM)、DeepSeek、Volcengine(Doubao/Ark)、Qwen、Groq、Moonshot(Kimi)、Minimax、Mistral、NVIDIA NIM、Cerebras、NEAR AI Cloud(TEE)、Novita AI、Xiaomi MiMo、Ollama(本地)、vLLM(本地)、LiteLLM(100+ 代理)、Azure OpenAI(API key 或 Entra ID)、GitHub Copilot(OAuth)、Antigravity(Google Cloud AI,OAuth)、AWS Bedrock(按 region 自动解析端点)。

**模型路由机制**:`AgentInstance` 同时绑定主模型与"light 模型",`SmartRouter` 按复杂度路由;`FallbackChain` 失败降级;SubTurn 可单独指定子任务模型(典型 `gpt-4o-mini`)。Provider 层计划从"按厂商分类"重构为"按协议分类"。

### 7. Channel 清单(19+ 接入渠道)

| Channel | 协议 | Channel | 协议 |
|---|---|---|---|
| Telegram | Long polling | 钉钉 DingTalk | Stream |
| Discord | WebSocket | 飞书 / Lark | WebSocket/SDK |
| WhatsApp | Native/Bridge | LINE | Webhook |
| 微信 Weixin | iLink API | 企业微信 WeCom | WebSocket |
| QQ | WebSocket | VK | Long Poll |
| Slack | Socket Mode | IRC | IRC protocol |
| Matrix | Sync API | OneBot | OneBot v11 |
| MQTT | pub/sub | MaixCam | TCP socket |
| Pico | Native(内置) | Pico Client | WebSocket(内置) |

Weixin/WeCom 于 v0.2.4 合入;Matrix/IRC/WeCom/Discord Proxy 于 v0.2.1 合入。所有 webhook 渠道共用 Gateway HTTP server。

### 8. 工具与扩展生态

- **Web 搜索**:DuckDuckGo(内置兜底)、Gemini Google Search、Baidu、Tavily、Brave、Kagi、Perplexity、SearXNG、GLM Search,v0.2.7/v0.2.9 增加 Sogou。
- **内置工具**:文件读写(`read_file` 按行)、shell exec、code execution、cron、vision(图片/文件 base64 自动编码)。
- **MCP**(`tools.mcp`):原生支持 stdio/SSE/HTTP;CLI 管理 `picoclaw mcp add/list/test/edit/remove/show`;v0.2.9 WebUI 可视化管理;`add` 支持 `--deferred` 与 `--env-file`;`picoclaw mcp` 仅做配置写入,**不守护进程**。
- **Skills**:从工作区 `SKILL.md` 加载;`picoclaw skills search/install/list`;注册中心 `tools.skills.registries` 下并列 **ClawHub**(官方,需 `auth_token`)与 **GitHub**(`base_url` + `auth_token` + 可选 `proxy`)。

### 9. 安全模型与自承警告

**安全机制**:

- **`.security.yml` 叠加层**:敏感数据与 `config.json` 分离,0600 原子写。
- **SecureString / SecureStrings**:自定义 JSON/YAML marshal,避免日志/响应泄漏;`SensitiveDataReplacer` 通过反射自动以 `[FILTERED]` 脱敏。
- **多 key 容错**:`APIKeys` 多 key 自动展开虚拟模型,支持 failover 与负载均衡。
- **OAuth2**:PKCE + state 防 CSRF;OpenAI / Antigravity / Anthropic 均走 OAuth。
- **SSRF 防护**:搜索结果在回送 LLM 前经 `SensitiveDataReplacer` 清洗;ROADMAP 计划加入内网 IP/Metadata 黑名单。
- **Shell/FS 沙箱**:`RestrictToWorkspace` 限制 R/W 目录;v0.2.6 增加 isolation 支持。
- **Cron gating**:命令型任务需显式放行。

**README 自承警告(显式 Caution 框)**:

1. **未发币**:任何 `pump.fun` 或代币均为诈骗。
2. **唯一官方域**:`picoclaw.io`(项目)+ `sipeed.com`(公司),其余 `.ai/.org/.com/.net` 仿冒均无关。
3. **勿上生产**:"PicoClaw is in early rapid development. There may be unresolved security issues. **Do not deploy to production before v1.0.**"
4. **内存回退**:近期大量合并 PR,实测可能 10–20MB。

### 10. 持久化与状态

- **会话存储**:**JSONL 文件**(v0.2.1 引入),Append-only,便于增量持久化与崩溃恢复。
- **配置**:`~/.picoclaw/config.json`(Version 3)。
- **凭证**:`.security.yml`(明文/外部文件引用/加密三种)。
- **Cron 任务**:本地持久化。
- **会话迁移**:`picoclaw migrate` 子命令支持跨版本数据迁移。

### 11. 部署矩阵

- **picoclaw.io**:官网自动识别平台,一键下载匹配二进制。
- **GitHub Releases**:15 个 release,v0.2.9 最新(2026-05-29),各架构 tar.gz。
- **Docker Compose**:见 §3。
- **Android**:APK 直接安装(无需 Termux)或 Termux + proot + `termux-chroot`。
- **嵌入式板**:LicheeRV-Nano($9.9)、NanoKVM($30–100)、MaixCAM($50)/MaixCAM2($100)、LicheeRV-Claw;树莓 Pi Zero 2 W 用 `make build-pi-zero` 同时产 arm/arm64。
- **源码构建**:`make deps && make build && make build-launcher`,跨平台 `make build-all`。

### 12. 协议、活跃度与版本节奏

- **License**:**MIT**(LICENSE 文件 + README 徽章双重确认)。
- **活跃度**:**29.5k ★ / 4.3k fork / 140 watching / 2,534 commits**。
- **爆发曲线**:2026-02-09 首发 → 02-13 破 5k(4 天)→ 02-16 破 12k(1 周)→ **02-26 破 20k(17 天)** → 03-25 破 26k → 当前 29.5k。
- **版本节奏**:4 个月内 v0.2.0 → v0.2.9(10 个 minor),v0.2.1 为"biggest update yet"。
- **国际化**:10 种语言 README — 中、日、韩、葡(BR)、越、法、意、印尼、马来、英。
- **衍生生态**:PicoPaw AI(picopaw.ai,2026-06-11 上线的桌面陪伴宠物);ClawdChat.ai(Agent 社交网络)。

### 13. 与 agentboster 的差异

| 维度 | **PicoClaw** | **agentboster** |
|---|---|---|
| 进程模型 | **单 Go 二进制** | **三层**:Web + `agentd` + `cli` |
| 运行环境 | 边缘 SBC / 旧手机 / 嵌入式;**<10–20MB RAM** | 服务器/Vercel;依赖 Postgres + 向量库 |
| 协议入口 | 多 IM Channel 经 Gateway | `middleware.ts` 会话路由 + `agentd` mTLS |
| 持久化 | JSONL 文件 + `~/.picoclaw` | 数据库 + Drizzle ORM |
| 编排 | SubTurn/Hooks/Steering/EventBus(进程内) | Workflow DevKit(沙箱化 step) |
| 前端 | React Launcher(独立,可选) | Next.js App Router + RSC + chat-sdk |
| 成熟度 | v0.2.9,**自承 v1.0 前勿上生产** | 生产化(`VERCEL_ENV=production` 门槛) |

简言之:**PicoClaw 是"边缘优先、单进程极致轻量"的个人助手;agentboster 是"服务器优先、三层解耦、工作流沙箱"的多租户平台**,二者几乎处于光谱两端。

---

## astrbot 深度剖析

### 1. 项目背景与定位

AstrBot 由 `AstrBotDevs` 组织维护,是一站式开源 IM 聊天机器人 / Agent 开发框架,定位为 **OpenClaw 的替代方案**——把"对话式 AI + Agent 自动化"以最小成本部署到主流 IM(QQ、微信系、Telegram、Slack、Discord 等)。

目标用户分层清晰:**个人**(陪伴 / 角色扮演 Bot、桌面 ChatUI)、**开发者/团队**(插件扩展业务能力)、**企业**(客服、知识库问答、自动化)。

**开源协议**:`AGPL-3.0`。强 copyleft——任何通过网络对外提供服务的衍生作品都必须开放源代码,对**商业闭源 SaaS 化**有强约束;商业集成通常需单独授权。仓库根附带 `EULA.md`、`FIRST_NOTICE.md`(中/英/俄三语)。

### 2. 整体架构

**单体 Python 应用 + 插件化扩展 + 独立 Web 前端 + 可选 Agent Sandbox**:

```
┌──────────────────────────────────────────────────────────┐
│  IM 平台适配器层 (Platform Adapters)                     │
│  官方 13+ / 社区 3+,OneBot v11、Telegram BotAPI、企微、 │
│  飞书、钉钉、Slack、Discord、LINE、Satori、KOOK...       │
└────────────┬─────────────────────────────────────────────┘
             │ AstrBotMessage (统一事件结构)
             ▼
┌──────────────────────────────────────────────────────────┐
│  消息处理管道 (Pipeline)                                 │
│  Filter → Result Decoration → ProcessStage(Main Agent)   │
│         → Response Stage                                  │
└────────────┬─────────────────────────────────────────────┘
             │
   ┌─────────┴─────────┬───────────────┬──────────────────┐
   ▼                   ▼               ▼                  ▼
LLM Provider        Agent System     Plugin System      Sandbox
(20+ 服务)         (Tool/MCP/Skills) (Stars, 1000+)    (Shipyard/CUA)
                   └─ Agent Runner: 内置 / Dify / Coze / 百炼 / DeerFlow
                                                             ▲
┌──────────────────────────────────────────────────────────┐
│  持久层 (SQLite + SQLModel, data_v4.db)                  │
│  会话、人格、平台消息、附件、统计、定时任务、API Key...  │
└──────────────────────────────────────────────────────────┘
                                  ┌──────────────────────┐
                                  │  WebUI / ChatUI      │
                                  │  Vue + Vite + Quart  │
                                  └──────────────────────┘
```

关键架构特点:

- **事件驱动**:所有平台消息规范化为 `AstrBotMessage`,Event Bus 异步分发。
- **分层管理器**:`PersonaManager`、`ProviderManager`、`PluginManager` 按依赖顺序初始化。
- **三层配置优先级**:`DEFAULT_CONFIG`(代码内置)< `data/cmd_config.json`(用户)< `ASTRBOT_*` 环境变量。
- **配置版本**:`config_version: 2`,支持 `segmented_reply`、`llm_compress_instruction`、`sandbox` 等现代特性。

### 3. 技术栈

| 类别 | 选择 |
|---|---|
| 主语言 | Python 3.12+(`pyproject.toml` 强制),约 **69.6%** |
| 前端 | Vue 3 + Vite + TypeScript,**22.1% Vue / 5.5% TS** |
| Web 后端 | Quart(异步 Flask-like) |
| 数据库 | SQLite + `aiosqlite` + SQLModel,WAL 模式、128MB mmap、30s busy timeout |
| 包管理 | `uv`(推荐)、传统 `pip` + `requirements.txt` |
| Lint/Format | `ruff` + `pre-commit` |
| 类型检查 | `pyright` |
| 容器 | Docker / Docker Compose,多平台镜像 `soulter/astrbot` |
| 编排 | 内置 k8s YAML 目录(`k8s/`) |

### 4. 目录结构概览

```
AstrBot/
├── astrbot/                    # 主 Python 包
│   ├── cli/                    # astrbot init / run 命令入口
│   └── core/
│       ├── config/default.py   # DEFAULT_CONFIG、平台元数据
│       ├── db/                 # po.py(SQLModel)、sqlite.py
│       ├── platform/sources/   # 各 IM 适配器
│       ├── pipeline/           # 消息处理各 Stage
│       ├── provider/           # LLM/STT/TTS/Agent Runner
│       ├── star/               # 插件加载、热重载
│       ├── sandbox/            # Agent Sandbox 驱动器
│       └── agent/              # tool calling、MCP、Skills
├── dashboard/                  # Vue WebUI/ChatUI 工程
├── data/                       # 运行期数据(cmd_config.json、data_v4.db、插件)
├── compose.yml / compose-with-shipyard.yml
├── Dockerfile / k8s/
├── docs/                       # VitePress 文档源(astrbot.app 站)
├── changelogs/                 # 每版本 changelog
├── pyproject.toml / requirements.txt
└── README_zh / zh-TW / ja / fr / es / ru.md   # 6 语种 README
```

### 5. IM 适配器完整清单

通过 `WEBHOOK_SUPPORTED_PLATFORMS` 区分长连接与 Webhook 模式:

| 平台 | 维护方 | 主要接入方式 |
|---|---|---|
| QQ(官方机器人) | 官方 | Websocket 或 Webhook |
| OneBot v11 | 官方 | 通过 NapCatQQ / Lagrange 等实现 |
| 企业微信应用 | 官方 | 回调 + API |
| 企业微信智能机器人 | 官方 | Webhook |
| 微信公众号 | 官方 | 公众平台回调 |
| 个人微信 | 官方 | 第三方协议(`weixin_oc`) |
| 飞书(Lark) | 官方 | Event Subscription |
| 钉钉 | 官方 | Stream / 回调 |
| Telegram | 官方 | BotAPI 长轮询 / Webhook |
| Slack | 官方 | Events API + Slash |
| Discord | 官方 | Gateway |
| LINE | 官方 | Messaging API Webhook |
| KOOK | 官方 | Webhook / WebSocket |
| Satori | 官方 | 跨平台 Satori 协议 |
| Misskey | 官方 | Misskey API |
| Mattermost | 官方 | Slash + Webhook |
| WhatsApp | 官方 | **规划中(Coming Soon)** |
| Matrix | 社区 | `stevessr/astrbot_plugin_matrix_adapter` |
| Rocket.Chat | 社区 | `NET-Homeless/astrbot_plugin_rocket_chat_adapter` |
| VoceChat | 社区 | `HikariFroya/astrbot_plugin_vocechat` |

### 6. Agent Sandbox(代码 / Shell 隔离执行)

自 `v4.12.0` 起,在 WebUI "AI 配置 → Agent Computer Use" 启用。三种驱动器:

1. **Shipyard Neo**(当前默认推荐):`Bay`(控制面 API)+ `Ship`(Python/Shell/FS)+ `Gull`(浏览器自动化);工作区固定 `/workspace`,由 **Cargo** 提供持久化卷——Session 销毁/重建后文件仍保留。支持 profile(`python-default`、`browser-python`、`python-data`),可独立部署到 homelab / 云主机以减轻主进程压力,启用 warm pool 预热降低冷启动。
2. **Shipyard**(旧方案):通过 `compose-with-shipyard.yml` 联合部署,每会话挂载 `/home/<session_id>` 到宿主机 `data/shipyard/ship_mnt_data`。
3. **CUA**(Computer Use Runtime):统一 SDK 创建 Linux / macOS / Windows / Android 沙盒,暴露 Shell、截图、鼠标、键盘、文件系统、上传下载工具,适合 GUI 自动化;需 `pip install cua` 且依赖 Docker / QEMU / Lume。

**会话级复用**:按 `session_id`(主 Agent 流程下等于 `unified_msg_origin`)缓存 sandbox booter,同一会话复用同一 Neo sandbox;失效自动重建。TTL 与 `idle_timeout` 共同决定生命周期。资源上限默认每实例 1 CPU / 512MB(推荐宿主 2C4G + Swap)。

### 7. LLM 与多模态

`provider_sources`(凭据/endpoint)+ `provider`(模型实例)两层抽象:

- **LLM 服务**:OpenAI 及兼容、Anthropic、Google Gemini、Moonshot、智谱 AI、DeepSeek、Ollama、LM Studio、AIHubMix、CompShare、302.AI、TokenPony、SiliconFlow、PPIO、ModelScope、OneAPI、NewAPI 等约 17 家。
- **LLMOps / Agent Runner**:内置执行器、**Dify**、**扣子 Coze**、**阿里云百炼(DashScope)**、**DeerFlow**。
- **STT**:OpenAI Whisper、SenseVoice、小米 MiMo Omni。
- **TTS**:OpenAI TTS、Gemini TTS、GPT-SoVITS-Inference、GPT-SoVITS、FishAudio、Edge TTS、阿里云百炼 TTS、Azure TTS、Minimax TTS、小米 MiMo TTS、火山引擎 TTS(11 项)。
- **能力层**:知识库 / RAG(FAISS 向量 + BM25 检索)、人格设定(Persona)、自动上下文压缩、网页搜索、SubAgent 编排、主动型 Agent、MCP、Function Tool、Computer Use、HTML 转图片、统一 Webhook 模式。多模态覆盖文本/图片/语音/视频/文件全链路。

### 8. 扩展机制

- **插件系统(Star)**:所有插件叫 "Star",支持热重载、事件处理器、命令注册、LLM 工具注册、插件配置/自有存储、插件 Pages(在 WebUI 内渲染自定义页面)、插件国际化。
- **官方插件市场**:README 顶部 "Marketplace" 徽章通过 `api.soulter.top/astrbot/plugin-num` 动态返回当前插件总数(徽章缓存 1 小时),宣称 **1000+ 一键安装**。
- **MCP**:原生集成(`pyproject.toml` 显式依赖),允许挂载外部 MCP Server 作为工具来源。
- **Skills 系统**:Persona 维度下的"技能白名单"。
- **第三方记忆插件**:如 **livingmemory(≈272★)** 长期记忆插件。

### 9. 部署方式全清单

| 方式 | 入口 | 适用 |
|---|---|---|
| `uv` 一键 | `uv tool install astrbot --python 3.12 && astrbot init && astrbot run` | 最快上手 |
| Docker / Compose | `compose.yml`、`compose-with-shipyard.yml` | 生产 / NAS |
| Kubernetes | `k8s/` 目录 YAML | 集群部署 |
| 宝塔面板 | 应用商店 | 面板托管 |
| 1Panel | 应用市场 | 面板托管 |
| CasaOS | 应用商店 | NAS / 家庭服务器 |
| AUR | `yay -S astrbot-git` | Arch Linux |
| RainYun 云 | 一键云部署徽章 | 免运维 |
| 优云智算(CompShare) | GPU 部署文档 | 本地大模型推理 |
| Replit | `repl.it/github/AstrBotDevs/AstrBot` | 在线 demo |
| 桌面 App | `AstrBotDevs/AstrBot-desktop` | 桌面 ChatUI |
| Launcher | `Raven95676/astrbot-launcher` | 多实例隔离 |
| 源码 / 手动 | `git clone` + `uv` | 完全自定义 |

### 10. 持久化与多租户

- **数据库**:SQLite 单文件 `data/data_v4.db`,通过 `aiosqlite + SQLModel` 异步访问。性能调优:WAL、`synchronous=NORMAL`、`mmap_size=128MB`、`busy_timeout=30s`。Shipyard Neo Bay `config.yaml` 暴露 PostgreSQL URL,可平滑升级为多实例 / HA。
- **核心表**:`platform_stats`、`provider_stats`、`conversations`(OpenAI 格式 JSON)、`personas`、`persona_folders`、`platform_message_history`(含 `llm_checkpoint_id` 索引)、`preferences`(KV)、`cron_jobs`、`attachments`、`api_keys`。Schema 通过 `PRAGMA table_info` + `ALTER TABLE` 做"软迁移"。
- **会话路由**:`unified_msg_origin`(UMOP)作为会话主键,承载多平台/多用户隔离,但整体仍是**单实例单数据库**形态;多租户能力是薄弱项,需 Launcher 多实例或外部编排。

### 11. 活跃度与生态

- **Star**:35.6k(截至 2026-06-30),Watchers 79,Forks 2.5k,Issues 983,PRs 308,**240 个 Release**(最新 `v4.26.2`,2026-06-27),commits 4,920。
- **更新频率**:master 持续活跃("4 小时前更新")。
- **影响面**:Trendshift 上榜、HelloGitHub 推荐、zread.ai 索引;topic 关联 `python / agent / chatbot / mcp / qq / discord / telegram / gemini / openai / llama`。
- **社区**:14 个 QQ 群(12 个已满,2 个开放:1092185289、1103419483)、1 个开发者闲聊群(975206796)、1 个正式开发群(1039761811)、1 个 Discord(`discord.gg/hAVk6tgV36`)。
- **赞助**:OpenCollective `astrbot`、爱发电 `afdian.com/a/astrbot_team`、sponsors.astrbot.app、RainYun 合作。
- **文档矩阵**:独立站 **astrbot.app**(VitePress,中英双语)+ **blog.astrbot.app** + **Roadmap**(`astrbot.featurebase.app/roadmap`)+ **HTTP API**(`docs.astrbot.app/scalar.html`)+ **DeepWiki**(2026-06-15 最新)。
- **国际化**:6 语种 README(简中/繁中/日/法/西/俄)。
- **特殊致谢**:[NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)(QQ 协议框架)。

### 12. 与 agentboster 的差异

| 维度 | AstrBot | agentboster |
|---|---|---|
| 定位 | IM 聊天机器人 / Agent **开发框架**(最终用户在 IM 内消费) | **多端协作平台**(Web 工作流 + IM 适配 + 后台 Agent 调度) |
| 主语言 | Python 3.12 | TypeScript / Next.js 15 + Go(agentd) |
| 入口形态 | Python 单体 + Vue Dashboard | Next.js Web 应用 + Go 守护进程 + CLI(独立子仓) |
| IM 接入 | 内置 16+ 官方适配器 + 社区插件 | 通过 Chat SDK / `@chat-adapter/*` 适配器 |
| Agent 执行 | Sandbox(Shipyard Neo / CUA)+ Dify/Coze/百炼 Runner | Workflow DevKit(持久化、可恢复 step 沙盒) |
| 持久化 | 单 SQLite,单实例为主 | Prisma + pgvector,多用户会话 |
| 扩展 | Star 插件 1000+、MCP、Skills | OpenCode Skills、Workflow steps、Chat 适配器 |
| 协议 | AGPL-3.0(强 copyleft,商用约束强) | MIT |
| 强项 | IM 覆盖广、社区生态厚、开箱即用 | 工作流编排、多端协作、企业级 Web UI、mTLS 安全回调 |

**互补价值**:AstrBot 的 IM 适配器矩阵和插件市场是 agentboster 当前没有的"广度优势";agentboster 的 Workflow DevKit(可恢复、可重试、可暂停的 step 编排)与 agentd(Go 守护 + mTLS 回调)则是 AstrBot 偏脚本化的 Agent 流程所欠缺的"工程化深度"。若考虑集成,AstrBot 可作为 agentboster 的"IM 触发前端",通过 Chat SDK 适配器或其 HTTP API 接入。

---

## 六、性能与资源占用

| 项目 | 语言/形态 | 启动时间 | 内存占用(RAM) | 最小硬件 | 并发能力 |
|---|---|---|---|---|---|
| **agentboster** | Next.js 15 + Go(agentd) + Node CLI | 多服务冷启动(秒级,含 Postgres) | 数百 MB(Web+DB+daemon) | 一台 2C4G 云主机 | 多节点调度,水平扩展 |
| **Memoh** | Go 65.5% + Vue + TS | 单二进制+docker compose | 容器化,单 agent 一容器 | "Edge devices",未公布数字 | 多 bot/多用户单机 fleet |
| **manboster** | Go 99.3% 单二进制 | 秒级,双击即启 | "Low memory"(具体未公布) | 单机 | 多线程非阻塞 |
| **picoclaw** | Go 89.8% 单二进制 | <1s(0.6GHz 单核) | **<10MB**(近期 10–20MB) | **$10 Linux 板**(RISC-V/ARM/MIPS/x86) | 单进程,多 Channel |
| **AstrBot** | Python 69.6% + Vue dashboard | 10–20s(macOS 首启) | >100MB(对标 NanoBot 量级) | 任意 Linux 服务器 | Python 单进程,异步 IO |

**简评**:picoclaw 在轻量化上断崖领先($10/<10MB/<1s 启动),定位嵌入式边缘。manboster 同为 Go 单二进制但未公布硬指标。Memoh 走容器化多租户路线。agentboster 与 AstrBot 都偏重服务端:前者拆分 Web/daemon/CLI 三件套牺牲了资源,换来了多节点扩展性;AstrBot 单 Python 进程部署简单但内存占用最高。

---

## 七、可观测性 / 审计 / 日志

| 项目 | 审计日志 | 指标监控 | 链路追踪 | Web 指标面板 | 心跳/健康检查 |
|---|---|---|---|---|---|
| **agentboster** | `createLogger` 服务端审计;节点资源指标上报 | 节点资源指标上报 | (未明确,未见 OpenTelemetry) | 内建监控模块 | 多节点调度心跳 |
| **Memoh** | 未明确审计模块 | 周期性 heartbeat | 未提及 | 容器级监控(docker) | **periodic heartbeat**(README 明示) |
| **manboster** | 未提及 | 未提及 | 未提及 | 无 | 未提及 |
| **picoclaw** | `gateway.log_level` 五档(debug/info/warn/error/fatal) | 未提及 | 未提及 | WebUI Launcher 日志页 | 未提及 |
| **AstrBot** | dashboard 操作日志 | dashboard 内建指标 | 未提及 | **dashboard (Vue)** 完整面板 | 未提及 |

**简评**:agentboster 在企业可观测性上最完整(结构化日志 + 节点资源指标 + 审计模块),适合 SRE 场景。AstrBot 的 Vue dashboard 是开箱即用的最强面板。Memoh 把"心跳"做成了产品级特性(automation)。picoclaw/manboster 偏轻量,仅有日志级别控制。

---

## 八、工作流 / 编排引擎深度

| 项目 | 引擎形态 | 可恢复步骤 | 可视化 | 调度/Cron | 子 Agent 编排 |
|---|---|---|---|---|---|
| **agentboster** | **Workflow DevKit**(Vercel 同源) | ✅ 可恢复步骤 / `persistStepDelta` / 沙箱内无 `fetch`/`__dirname` | ✅ `workflow:inspect` Web UI | workflow 内置 | 多步骤编排 |
| **Memoh** | Automation(scheduled tasks + heartbeat) | 未明示持久化恢复 | 无 | ✅ 计划任务 | Skills & sub-agents 委托 |
| **manboster** | 无编排引擎(MVP) | ❌ | ❌ | ❌ | ❌ |
| **picoclaw** | **SubTurn / Hooks / Steering / EventBus / Cron** | SubTurn 生命周期管理 | 无 | ✅ Cron security gating | ✅ spawn sub-agent (async) |
| **AstrBot** | LLMOps 集成(**Dify / 阿里云百炼 / Coze**) | 由上游平台提供 | 由上游平台提供 | 上游平台 | 上游平台 Agent |

**简评**:agentboster 的 Workflow DevKit 是唯一原生支持**可恢复步骤**与**Web 可视化**(`workflow:inspect`)的,工程化最深。picoclaw 用 SubTurn/Hooks/Steering 自研了一套轻量编排,灵活性高但无持久化恢复。AstrBot 走"接入外部 LLMOps"路线,自己不做引擎。Memoh 的 automation 偏简单定时。manboster 尚无编排能力。

---

## 九、记忆系统深度对比

| 项目 | 存储后端 | 向量检索/RAG | 跨平台长期记忆 | 外部记忆集成 |
|---|---|---|---|---|
| **agentboster** | **Postgres + pgvector** | ✅ 原生 RAG | ✅(跨 IM 平台) | `db:ensure-vector` |
| **Memoh** | 内建 + 可选 | ✅ | ✅ "跨 session/platform" | **Mem0 / OpenViking** |
| **manboster** | (Planned) | ❌ 规划中(`mem0 theory adaption`) | ❌ | Planned |
| **picoclaw** | **JSONL memory store** | 🔄 规划中 RAG | 部分 | 无 |
| **AstrBot** | 内建 **Knowledge Base** + `livingmemory` 插件 | ✅(`typings/faiss`) | ✅(KB + 插件) | livingmemory 插件 |

**简评**:agentboster 的 pgvector 方案最贴近"生产级 RAG"——SQL + 向量同一库,运维统一。Memoh 卖点是"开箱即用的跨平台长期记忆"并能接 Mem0/OpenViking。AstrBot 靠 Knowledge Base + 社区插件生态取胜。picoclaw 仅 JSONL 文件存储,是边缘设备的妥协。manboster 仍在规划阶段。

---

## 十、定价 / 成本模型

| 项目 | 开源许可 | 自托管 | 官方云服务 | BYO Key |
|---|---|---|---|---|
| **agentboster** | **MIT** | ✅ 完全免费 | ❌ 无 | ✅ |
| **Memoh** | **AGPL-3.0** | ✅ `curl -fsSL https://memoh.sh \| sh` | ✅ **Memoh Cloud**(waitlist,未上线) | ✅ |
| **manboster** | **Apache-2.0** | ✅ 单二进制 | ❌ 无 | ✅(openrouter/kimi/DeepSeek/openai-compat) |
| **picoclaw** | **MIT** | ✅ | ❌(仅 PicoPaw AI 伴侣站,非托管) | ✅ |
| **AstrBot** | **AGPL-3.0** | ✅ | ✅ **RainYun** 一键云部署 | ✅ |

**简评**:全部都支持 BYO Key。商业姿态分化明显:Memoh/AstrBot 用 AGPL + 官方云(Memoh Cloud waitlist / RainYun)走商业化路径;agentboster/picoclaw/manboster 用宽松许可(MIT/Apache),无官方托管。Memoh 的 AGPL 对二次商用闭源有强约束,agentboster 的 MIT 对企业内嵌最友好。

---

## 十一、社区与治理

| 项目 | Stars | Forks | Commits | Releases | 贡献者 | 沟通渠道 |
|---|---|---|---|---|---|---|
| **agentboster** | (本地仓库,未公开 star 数据) | — | — | — | — | (未见公开群) |
| **Memoh** | **2k** | 185 | 1,140 | 53 | 多人 | Telegram |
| **manboster** | **20** | 0 | 461 | 9 | 极少(个人项目) | 文档站 manboster.dev |
| **picoclaw** | **29.5k** | 4.3k | 2,534 | 15 | 活跃("26K stars in 17 days") | **Discord + WeChat** |
| **AstrBot** | **35.6k** | 2.5k | 4,920 | **240** | 活跃 | **12+ QQ 群(多数满)+ Discord** |

**简评**:AstrBot 社区规模与成熟度最高(35.6k stars、240 个 release、QQ 群生态),是中文圈 IM bot 的事实标杆。picoclaw 增长最猛(17 天 20k stars)。Memoh 处于早期产品化阶段(2k stars、53 release 节奏快)。manboster 是个人 MVP(20 stars)。agentboster 暂无公开社区数据可对比。

---

## 十二、国际化(i18n)与本地化

| 项目 | README 语言数 | 中文支持 | i18n 框架 |
|---|---|---|---|
| **agentboster** | **2**(中/英) | ✅ 深度 | (未见专门框架) |
| **Memoh** | **3**(英/简中/日) | ✅ | README 多语 |
| **manboster** | **2**(英/简中)+ crowdin.yml | ✅ | **Crowdin** 翻译平台接入 |
| **picoclaw** | **10**(英/中/日/韩/葡/越/法/意/印尼/马来) | ✅ 深度 | README 多语 |
| **AstrBot** | **7**(英/简中/繁中/日/法/西/俄)+ FIRST_NOTICE 多语 | ✅ 深度 | **i18n 框架明示支持** |

**简评**:picoclaw 语言覆盖最广(10 种),AstrBot 次之且有正式 i18n 框架(7 种 + EULA 多语)。manboster 虽小但接入了 Crowdin 平台化。Memoh 仅 3 种但日文到位。agentboster 仅中英双语,国际化最薄弱——若要出海需补齐。

---

## 十三、适合场景推荐矩阵

| 场景 | 首选 | 次选 | 理由 |
|---|---|---|---|
| **个人聊天 / 情感陪伴** | **AstrBot** | manboster | AstrBot 1000+ 插件 + 角色扮演 + 陪伴定位;manboster 单二进制即开即用 |
| **IM 群机器人(多平台)** | **AstrBot** | picoclaw | AstrBot 支持 13+ IM 且 QQ/微信生态最深;picoclaw 19+ channel 也强 |
| **嵌入式 / 边缘设备** | **picoclaw** | (无竞品) | $10 硬件 / <10MB / <1s 启动,唯一选择 |
| **团队多 Agent / 多租户** | **Memoh** | agentboster | Memoh 每 agent 一容器 + fleet;agentboster 多节点调度 |
| **企业编码 Agent(Claude Code/Codex 托管)** | **Memoh** | agentboster | Memoh 明确支持 ACP 托管 Codex/Claude Code;agentboster 有 agentd 沙箱 |
| **可恢复工作流 / 长任务编排** | **agentboster** | picoclaw | Workflow DevKit + `persistStepDelta` + `workflow:inspect` 唯一原生方案 |
| **企业级安全合规(多层沙箱/审计)** | **agentboster** | Memoh | L0/L1/L2 三层安全 + docker/docker-strict/lxc 三档沙箱 + 审计日志 |
| **生产级 RAG / 知识库** | **agentboster** | AstrBot | pgvector 原生 RAG;AstrBot 靠 Knowledge Base + faiss 插件 |
| **快速 MVP / 个人实验** | **manboster** | picoclaw | 单二进制零配置;picoclaw WebUI Launcher 也极简 |
| **中文社区支持** | **AstrBot** | picoclaw | 12+ QQ 群 + 35.6k stars 中文生态最厚 |

---

## 十四、总结:五个项目的光谱定位

```
        个人/单机 ◀────────────────────────────▶ 团队/平台
   轻量/边缘                                         重型/分布式

 manboster ──▶ picoclaw ──▶ astrbot ──▶ memoh ──▶ agentboster
 (单二进制)   (单二进制)   (IM框架)   (Agent云主机) (多端协作平台)
 Apache-2.0    MIT         AGPL-3.0    AGPL-3.0      MIT
 20★           29.5k★      35.6k★      2k★          (本地)
 Telegram×1    Channel×19+ IM×18+      IM×11         IM×5+Web+CLI
```

### 一句话选型

- **要最轻、跑在 $10 板子上** → **picoclaw**
- **要最深 IM 生态与中文社区** → **astrbot**
- **要每个 Agent 一台常驻云电脑 + 托管外部 coding agent** → **memoh**
- **要本地安全守护模型 + 单二进制个人助手** → **manboster**
- **要多端协作 + 可恢复工作流 + 企业级安全 + 多节点调度** → **agentboster**

### 隔离哲学的根本分野

五个项目最本质的差异在于**隔离边界的选择**:

- **横向隔离(每实例一沙箱)**:memoh(每 agent 一容器)、astrbot(每 session 一 sandbox)、picoclaw(workspace 隔离)——把隔离单元横向铺开。
- **纵向分层(权威中心 + 可丢弃执行端)**:agentboster(Web 唯一权威 + agentd/CLI 无状态执行端 + L0/L1/L2 三层安全评估)——把信任链纵向切分。
- **进程内守护(manboster)**:Hachimi 本地判官模型 + Gatekeeper 零信任网关,在单进程内完成安全裁决,不依赖外部权威。

这三种隔离哲学决定了它们各自的部署形态、扩展方式与适用场景,也是本对比中最难"互相替代"的根本性差异。

---

*文档生成时间:2026-06-30 · 数据基于各项目公开 GitHub README/LICENSE/文档站(实际抓取)· agentboster 部分基于本地仓库源码读取*


## 十五、协议与法律风险矩阵

| 项目 | 协议 | 自托管内部使用 | 修改后对外提供 SaaS | 闭源商用衍生 | 企业内嵌到自家产品 |
|------|------|----------------|---------------------|--------------|---------------------|
| agentboster | MIT | ✅ 完全自由 | ✅ 允许,无需开源 | ✅ 允许 | ✅ 允许,仅需保留版权声明 |
| memoh | AGPLv3 | ✅ 允许 | ⚠️ 必须开源全部修改(第13条) | ❌ 禁止除非整体开源 | ⚠️ 内部不对外服务可;对外 SaaS 触发第13条 |
| manboster | Apache-2.0 | ✅ 完全自由 | ✅ 允许 | ✅ 允许(需 NOTICE/版权声明) | ✅ 允许,且含专利授权 |
| picoclaw | MIT | ✅ 完全自由 | ✅ 允许 | ✅ 允许 | ✅ 允许 |
| astrbot | AGPLv3 | ✅ 允许 | ⚠️ 必须开源(第13条) | ❌ 禁止除非开源 | ⚠️ 同 memoh |

**AGPLv3 第13条对 memoh / astrbot 的具体约束:**

该条款规定:如果你修改了 AGPLv3 程序并以"通过网络让用户交互"的方式提供服务,则必须向所有该服务的远程用户开放你完整的修改后源代码。对 memoh(Go+Vue、每 agent 一容器)和 astrbot(Python 单体、1000+ 插件)这意味着:

- **不能闭源做 SaaS**:任何定制化部署(改 prompt、改业务逻辑、接私有 API)对外提供服务后,竞争对手和用户都有权索要完整源码(含你写的业务代码)。
- **"每 agent 一容器"不构成隔离**:memoh 的容器化架构无法绕过第13条,因为整个服务对外仍是一个统一的网络服务。
- **astrbot 的插件边界模糊**:通过官方插件接口开发的独立插件,业界一般认为是"独立作品"不受 AGPL 感染;但若直接修改主程序源码并对外服务,则必触发。`EULA.md`/`FIRST_NOTICE.md`(astrbot 仓库根目录)可能附加了进一步限制,需单独审阅(推测项)。
- **企业内部不对外**:纯内网、仅本企业员工使用,通常不视为"对外",相对安全(但司法实践有争议)。

**Apache-2.0 专利条款对 manboster 企业用户的价值:**

Apache-2.0 第3条授予明确的**专利使用权**:贡献者自动授予用户使用其相关专利的权利,且若用户对项目发起专利诉讼则专利授权终止(专利反诉条款)。对 manboster 企业用户的具体价值:

- 若 Hachimi 守护模型的设计涉及任何专利(守护进程编排或模型加载方式),企业用户获得明确、可执行的专利授权,避免"用了代码但侵犯专利"的双重风险。
- 专利反诉条款保护社区贡献者不被企业反向专利勒索。
- 企业法务部门通常更愿意批准采用 Apache-2.0 项目,因为其法律文本由专业律师起草、条款完备。

**决策建议:**

| 如果你想做 X 场景 | 首选项目 | 备选 | 原因 |
|-------------------|----------|------|------|
| 闭源商业化、做付费 SaaS 产品 | agentboster / picoclaw | manboster | MIT/Apache 允许闭源衍生 |
| 企业内部自用、可对外开源 | 任一皆可 | — | 看技术栈匹配 |
| 企业内部自用、坚决不能对外开源 | agentboster / picoclaw / manboster | — | 避开 AGPLv3 的第13条风险 |
| 想要法律最完备、专利清晰 | manboster | agentboster | Apache-2.0 文本最完备 |
| 想白嫖社区生态且不介意反哺开源 | astrbot | memoh | AGPLv3 换来 1000+ 插件生态 |
| 嵌入式 $10 硬件、资源极受限 | picoclaw | manboster | 单二进制、MIT |
| 想要 Next.js 现代前端、自研可视化 | agentboster | — | 三层 Web 架构最完整 |

> ⚠️ 法律结论基于协议通用解读,实际部署前请由企业法务复核;astrbot 的 EULA.md 可能叠加额外条款(推测项)。

---

## 十六、可扩展性与二次开发难度

| 维度 | agentboster | memoh | manboster | picoclaw | astrbot |
|------|-------------|-------|-----------|----------|---------|
| 主语言 | TypeScript (Next.js) + Go | Go + Vue | Go | Go | Python |
| 架构耦合度 | 三层分离(Web/Agent/Daemon)清晰,mTLS 解耦 | 每 agent 一容器,强隔离但编排复杂 | 单二进制 + Hachimi 守护,紧耦合但简洁 | 单二进制,极致精简 | 单体 Python + 插件进程,主程序耦合中等 |
| 插件机制 | Workflow 沙箱 + `'use step'` 标注 + Chat adapter | Skills + Supermarket + Plugins + MCP(每 bot 自管) | wasm/extism(Planned)+ OpenClaw skills(WIP) | MCP + Skills(ClawHub/GitHub) | **最成熟**:1000+ 插件市场、一键安装、Star 插件 API、热重载 |
| 文档完整度 | 高(README + AGENTS.md + MULTI-NODE + cli/agentd 各自 README) | 高(docs.memoh.ai + DEPLOYMENT.md + DeepWiki) | 中(manhboster.dev/docs + SECURITY/CONTRIBUTING) | 高(docs.picoclaw.io + DeepWiki + 10 语种 README) | 高(astrbot.app 独立站 + DeepWiki + Roadmap + HTTP API) |
| SDK / API | CLI(独立 repo)、daemon mTLS API、Chat SDK | HTTP API + 容器编排接口 + TypeScript SDK(openapi-ts) | 守护模型 API + huh TUI | CLI 子命令(`picoclaw mcp/skills/cron`) + WebUI Launcher | 插件 SDK + Web API(`docs.astrbot.app/scalar.html`)+ MCP + ChatUI |
| 配置复杂度 | 中(Postgres+pgvector、多包 external、Workflow 沙箱规则) | 高(每 agent 容器、网络/卷/资源) | 低(单二进制、交互式 wizard) | 极低(单二进制 + config.json + .security.yml) | 中(Python 3.12 + uv、可选容器) |

**各项目"最适合的二次开发形态":**

- **agentboster**:改 Next.js 页面 / 加 Workflow step / 新增 daemon mTLS 适配器 / 写 Chat adapter(`@chat-adapter/*`)。最适形态:**前端定制 + 多 channel adapter + Workflow 编排**。门槛:需懂 Next.js 15 + React 19 + Go + mTLS。
- **memoh**:**写"每 agent 一容器"的镜像 / Supermarket 插件 / MCP server**。最适形态:把每个 agent 当独立微服务封装,或写带 `plugin.yaml` 的 Supermarket 包。门槛:DevOps/容器编排能力 + Go。
- **manboster**:**为 Hachimi 守护模型写新的守护逻辑 / wasm 插件**。最适形态:单二进制内嵌、扩展守护语义。门槛:Go + CGO + 进程/系统编程。
- **picoclaw**:**写 MCP server / 加 Channel adapter / fork 改 Go 源码**适配目标硬件外设。最适形态:精简 fork 或 MCP 扩展,面向设备。门槛:嵌入式 Go + 硬件资源约束。
- **astrbot**:**写 Star 插件(独立 .py 包)**。最适形态:插件市场一键安装、无需碰主程序、支持热重载与插件 Pages。门槛:Python、最低;生态最大。

**总体难度排序(从易到难二次开发):**

astrbot(插件最成熟、Python 门槛低)< agentboster(分层清晰但栈多)< manboster(单二进制、文档中等、wasm 待落地)< picoclaw(配置极简但嵌入式 fork 门槛高)< memoh(容器编排最重 + AGPLv3 约束)。

---

## 十七、长期可持续性评估

| 项目 | 商业实体 | Star/活跃度 | 贡献者/巴士因子 | 发版节奏 | 协议对社区贡献的吸引力 | 最大风险点 |
|------|----------|------------------------------|------------------------|----------|------------------------|------------|
| agentboster | 未见明确商业实体(WIP 自研项目) | 本地仓库,公开 star 数据未获取 | 低(本地视角,核心维护者少) | 按需发版 | MIT 吸引贡献,但缺商业激励 | **巴士因子低 + 无商业实体**:核心维护者流失即停滞 |
| memoh | ✅ Memoh Cloud(waitlist SaaS)+ 桌面客户端商业线 | ✅ 2k stars / 185 forks / 1,140 commits / 53 releases(v0.14.0) | 中(多模块仓库、sub 仓 twilight-ai/supermarket) | ✅ 密集(v0.14.0 @ 2026-06-24) | AGPLv3 抑制企业贡献,但 Memoh Cloud 是变现闭环 | **AGPLv3 抑制企业反哺**:社区贡献只能流向 Memoh Cloud,形成生态垄断 |
| manboster | 未见商业实体(作者 chihuo2104 个人项目) | ✅ 20 stars / 0 forks / 461 commits / 9 releases | **极低**(单一作者,GPG 独立签名) | 快(v0.0.1→v0.2.3,2 个月 9 release) | Apache-2.0 友好但用户基数极小 | **用户基数过小 + 单一作者**:巴士因子=1,贡献池天然有限 |
| picoclaw | ✅ Sipeed(矽速科技)商业实体 + PicoPaw AI/ClawdChat 衍生 | ✅ **29.5k stars / 4.3k forks / 2,534 commits / 15 releases** | 中高(公司支撑 + 17 天破 20k 的爆发社区) | ✅ 极快(4 个月 v0.2.0→v0.2.9) | MIT 友好 + 硬件销量反哺 | **硬件供应链 + 自承"v1.0 前勿上生产"**:定位窄但公司兜底 |
| astrbot | ✅ RainYun 一键云 + OpenCollective + 爱发电 + 桌面 App | ✅ **35.6k stars / 2.5k forks / 4,920 commits / 240 releases**(v4.26.2 @ 2026-06-27) | ✅ 中高(15+ 列贡献者图、14 QQ 群 + Discord) | ✅ 极快(240 releases、近每周发版) | AGPLv3 但生态已成型,1000+ 插件是社区飞轮 | **过度依赖核心维护者** + **AGPLv3 限制商业化反哺**:飞轮靠个人驱动 |

**2-3 年可持续性结论:**

- **astrbot**:可持续性最高。✅ 已验证的快速发版(240 releases)+ 商业变现(RainYun/赞助)+ 巨大社区飞轮(35.6k star、1000+ 插件、6 语种 README)。2-3 年内最大隐患是核心维护者职业变动;但飞轮已足够大,被 fork 接手的概率高。**风险:低**。
- **picoclaw**:可持续性中高。✅ Sipeed 公司兜底 + 29.5k star 爆发曲线 + MIT 友好。风险在于硬件定位窄、自承未到 v1.0;但作为 Sipeed 硬件生态的软件入口,有持续投入动机。**风险:中低**。
- **memoh**:可持续性中。✅ Memoh Cloud 作为商业实体提供兜底 + 2k star + 密集发版。但 AGPLv3 + 单一商业实体会导致社区贡献集中流入官方,长期生态活力取决于 Memoh Cloud 的营收。**风险:中**。
- **agentboster**:可持续性中低。技术栈先进(Next.js 15 + React 19 + Go 1.26),架构严谨(硬分层 + Workflow 沙箱 + 多节点调度),但 WIP 状态、无商业实体、推测巴士因子低,对核心维护者依赖极强。**风险:中高**。
- **manboster**:可持续性低。Apache-2.0 法律友好、单二进制优雅、Hachimi 创新性强,但 20 star + 0 fork + 单一作者,用户基数和贡献池双低,Hachimi 的独特性既是壁垒也是孤岛。**风险:高**。

---

## 十八、选型决策树

```
你要做什么？
│
├─【个人玩 / 学习 / 单机自用】
│   ├─ 想 DIY 机器人接 QQ/微信，要海量现成插件？
│   │   └─→ astrbot   （生态最大、Python 易上手、插件一键装）
│   ├─ 想要现代 Web 控制台、学 Next.js + Go 三层架构？
│   │   └─→ agentboster
│   ├─ 在 $10 的盒子/单片机上跑？
│   │   └─→ picoclaw   （单二进制、资源极省）
│   └─ 想研究"守护模型 / 零信任网关"这种系统级玩法？
│       └─→ manboster
│
├─【小团队 / 创业产品】
│   ├─ 产品要闭源、要商业化、要保留专利？
│   │   ├─ 法务最严、要完备许可文本？      └─→ manboster (Apache-2.0)
│   │   ├─ 嵌入式 / 边缘硬件产品？         └─→ picoclaw (MIT)
│   │   └─ 想做 Web SaaS、要全栈控制？     └─→ agentboster (MIT)
│   ├─ 不介意开源、想白嫖最大社区生态？
│   │   └─→ astrbot   （AGPLv3，但 1000+ 插件即用）
│   └─ 想做"每客户独立 agent"的多租户隔离 SaaS？
│       └─→ memoh     （AGPLv3，注意第13条要么开源要么走 Memoh Cloud 合作）
│
├─【企业内部 / 不可对外开源】
│   ├─ 坚决不能触发 AGPLv3 第13条？
│   │   ├─ 要 Web 可视化、要 Postgres+pgvector → agentboster
│   │   ├─ 要单二进制、零依赖、含专利授权    → manboster
│   │   └─ 要跑在边缘硬件上                  → picoclaw
│   └─ 内部使用、且能接受未来若对外则开源？
│       └─→ memoh 或 astrbot（内部用相对安全，但扩展/定制前请法务复核）
│
├─【嵌入式 / 边缘 / 资源受限】
│   └─→ picoclaw   （唯一为目标硬件设计的项目）
│       备选 manboster（单二进制，但非为硬件优化）
│
└─【技术栈偏好兜底】
    ├─ 主攻 Python          → astrbot（无悬念）
    ├─ 主攻 TypeScript/React→ agentboster
    ├─ 主攻 Go、喜欢单二进制→ manboster 或 picoclaw
    └─ 主攻 Go + 容器编排   → memoh
```

**一句话决策提示:**

- 想最快出活、要现成生态 → **astrbot**
- 想闭源商业化、要 Web 全栈 → **agentboster**
- 想法务最稳、要专利授权 → **manboster**
- 要跑在 $10 硬件上 → **picoclaw**
- 要"每 agent 强隔离"的多租户 → **memoh**(注意 AGPLv3)

> ⚠️ 决策树中 manboster/picoclaw/memoh 的部分特性基于已知信息推理,实际选型前建议再核实对应仓库的 README、贡献者图与最近 commit 日期。

---

*文档生成时间:2026-06-30 · 数据基于各项目公开 GitHub README/LICENSE/文档站(实际抓取)· agentboster 部分基于本地仓库源码读取*


## 附录 A:特性 checklist 完整矩阵

下表用 `[Y]已有 / [P]规划中 / [N]无 / [?]未查到` 标注每个项目对各细分特性的支持情况,便于快速横向筛选。

### A.1 客户端与接入

| 特性 | agentboster | memoh | manboster | picoclaw | astrbot |
|---|---|---|---|---|---|
| Web UI | [Y] Next.js 15 | [Y] Vue | [N] | [Y] Launcher(React) | [Y] Vue dashboard |
| 桌面原生 App | [N] | [Y] macOS/Win/Linux | [N] | [N] | [Y] AstrBot-desktop |
| CLI | [Y] pi TUI + --print | [N] | [Y] huh TUI | [Y] picoclaw agent/gateway | [N] |
| 移动端 App | [N] | [N] | [N] | [Y] Android APK | [N] |
| Telegram | [Y] | [Y] | [Y] | [Y] | [Y] |
| Discord | [Y] | [Y] | [P] | [Y] | [Y] |
| Slack | [Y] | [Y] | [N] | [Y] | [Y] |
| 飞书 / Lark | [Y] | [Y] | [P] | [Y] | [Y] |
| Teams | [Y] | [N] | [N] | [N] | [N] |
| 企业微信 | [N] | [Y] | [N] | [Y] | [Y] |
| 微信(个人) | [N] | [Y] | [N] | [Y] | [Y] |
| 微信公众号 | [N] | [Y] | [N] | [N] | [Y] |
| QQ | [N] | [Y] | [N] | [Y] | [Y] |
| 钉钉 | [N] | [Y] | [N] | [Y] | [Y] |
| Matrix | [N] | [Y] | [N] | [Y] | [Y] 社区 |
| LINE | [N] | [N] | [N] | [Y] | [Y] |
| KOOK | [N] | [N] | [N] | [N] | [Y] |
| WhatsApp | [N] | [N] | [N] | [Y] | [P] |
| Email | [N] | [Y] | [N] | [N] | [N] |
| MQTT / IoT | [N] | [N] | [N] | [Y] | [N] |
| 接入渠道总数 | 5 | 11+ | 1 | 19+ | 18+ |

### A.2 Agent 与编排

| 特性 | agentboster | memoh | manboster | picoclaw | astrbot |
|---|---|---|---|---|---|
| 多步工具循环 | [Y] CodeAct | [Y] | [Y] | [Y] | [Y] |
| 可恢复 Workflow | [Y] DevKit | [P] | [N] | [N] | [Y] 外接 Dify/Coze |
| Workflow 可视化 | [Y] inspect | [N] | [N] | [N] | [Y] 外接平台 |
| 子 Agent 编排 | [Y] | [Y] Skills 委托 | [N] | [Y] SubTurn/spawn | [Y] SubAgent |
| Cron / 定时任务 | [Y] cron lib | [Y] schedule | [Y] persistent | [Y] Cron gating | [Y] cron_jobs 表 |
| Hooks / 事件 | [Y] 事件总线 | [Y] hooks | [N] | [Y] Hooks/EventBus | [Y] 事件处理器 |
| Agent Sandbox | [Y] docker/lxc | [Y] 每agent容器 | [P] wasm | [Y] RestrictToWorkspace | [Y] Shipyard/CUA |

### A.3 模型与记忆

| 特性 | agentboster | memoh | manboster | picoclaw | astrbot |
|---|---|---|---|---|---|
| 多 Provider | [Y] ai-sdk | [Y] Twilight | [Y] 4 家 | [Y] 30+ | [Y] 17+ |
| BYO Key | [Y] | [Y] | [Y] | [Y] | [Y] |
| 模型路由 / Fallback | [?] | [Y] | [N] | [Y] SmartRouter | [?] |
| MCP 支持 | [Y] | [Y] | [P] | [Y] 原生 | [Y] 原生 |
| 向量 RAG | [Y] pgvector | [Y] Qdrant/Sparse | [P] | [P] | [Y] FAISS+BM25 |
| 长期跨平台记忆 | [Y] | [Y] Mem0/OpenViking | [P] | [P] | [Y] KB+插件 |
| 上下文压缩 | [?] | [Y] compaction | [Y] session compaction | [Y] | [Y] auto compress |
| STT / TTS | [?] | [Y] Edge/Deepgram等 | [N] | [N] | [Y] 11 家 TTS |
| 图片 / 多模态 | [Y] | [Y] vision | [Y] image | [Y] vision | [Y] 全链路 |
| Browser Use | [?] | [Y] headed Chrome | [Y] go-rod | [?] | [Y] Gull |
| Computer Use | [?] | [Y] Xvnc 桌面 | [P] | [N] | [Y] CUA |

### A.4 安全与运维

| 特性 | agentboster | memoh | manboster | picoclaw | astrbot |
|---|---|---|---|---|---|
| 规则黑名单(L0) | [Y] | [N] | [Y] Gatekeeper | [Y] gating | [N] |
| LLM 风险评分(L1) | [Y] | [Y] toolapproval | [Y] Hachimi | [N] | [N] |
| 人工审批(L2) | [Y] Web/TUI | [Y] approval flow | [Y] 决策表单 | [Y] ApproveTool hook | [N] |
| 守护模型 | [N] | [N] | [Y] Hachimi 首创 | [N] | [N] |
| Vault 凭据隔离 | [?] | [?] | [P] | [Y] SecureString | [?] |
| mTLS 双向认证 | [Y] agentd | [Y] bridge | [N] | [N] | [N] |
| 审计日志 | [Y] createLogger | [?] | [N] | [Y] log_level | [Y] dashboard |
| 多节点调度 | [Y] MULTI-NODE | [Y] fleet | [N] | [N] | [N] |
| 多租户 | [Y] | [Y] 强 | [N] | [N] | [N] 弱 |

---

## 附录 B:术语表

| 术语 | 含义 |
|---|---|
| **CodeAct** | 以代码/工具调用为动作单元的 Agent 循环范式(Action = tool call) |
| **Workflow DevKit** | Vercel 出品的可恢复/可重试 step 编排框架,agentboster 用作 LLM/工具循环的持久化层 |
| **`'use step'`** | agentboster 中标注"仅在工作流步骤内可用"的 host helper 指令,确保不被 sandbox 直接调用 |
| **L0/L1/L2** | agentboster 三层安全:L0 规则黑名单、L1 LLM 风险评分、L2 用户授权 |
| **agentd** | agentboster 的 Go 守护进程,沙箱执行端,无状态、可水平扩缩 |
| **ACP** | Agent Communication Protocol,memoh 用它把外部 coding agent(Claude Code/Codex)接入平台 |
| **Twilight AI SDK** | memoh 自研的 Go 版"Vercel AI SDK"(Apache-2.0),Provider-agnostic 推理引擎 |
| **Hachimi** | manboster 的本地守护模型(GGUF,~400MB),评估云端 LLM 工具调用是否安全 |
| **Gatekeeper** | manboster 的零信任网关,所有工具调用强制经其 8 步裁决 |
| **SubTurn** | picoclaw 的子 Agent 循环机制,允许工具派生隔离的临时 Agent 处理子任务(最大嵌套 3、并发 5) |
| **Steering** | picoclaw 在运行中的 Agent 循环工具调用之间注入消息的机制 |
| **Star** | AstrBot 对"插件"的称呼,支持热重载、事件处理、LLM 工具注册 |
| **UMOP / unified_msg_origin** | AstrBot 的统一消息来源标识,作为多平台/多用户会话主键 |
| **Shipyard Neo** | AstrBot 当前的 Agent Sandbox 驱动器(Bay+Ship+Gull+Cargo 持久化卷) |
| **pgvector** | Postgres 的向量检索扩展,agentboster 用作原生 RAG 存储 |
| **Supermarket** | memoh 的官方 Plugin & Skill & MCP Registry(`memohai/supermarket`) |
| **ClawHub** | picoclaw 的官方 Skills 注册中心(与 GitHub registry 并列) |
| **MamboHub** | manboster 规划中的 skill/plugin 分发中心(兼容 ClawHub,Planned) |
| **巴士因子 (Bus Factor)** | 项目能承受多少人突然离开而不崩溃的最小人数;越低风险越大 |
| **AGPLv3 第13条** | 网络服务条款:修改后通过网络对外提供服务必须开放源码 |

---

## 附录 C:数据来源与可信度声明

| 项目 | 主要来源 | 可信度 | 备注 |
|---|---|---|---|
| **agentboster** | 本地仓库 `/home/user/repo/agentboster`(README.md / AGENTS.md / package.json / go.mod / cli/package.json / lib 源码) | ⭐⭐⭐⭐⭐ 最高 | 直接读取源码,所有 `path:line` 可复核;WIP 状态,公开仓库数据未获取 |
| **astrbot** | GitHub `AstrBotDevs/AstrBot`(README/LICENSE/目录树/releases)+ `astrbot.app` 文档站 + `docs.astrbot.app` HTTP API + DeepWiki(commit a2b6aad8, 2026-06-15) | ⭐⭐⭐⭐⭐ 高 | star/commit/release/IM 清单均交叉验证;livingmemory 272★ 为社区传称未独立核验 |
| **picoclaw** | GitHub `sipeed/picoclaw`(raw README)+ `docs.picoclaw.io` + DeepWiki(`/sipeed/picoclaw/1`、`/2`、`/9`)+ `docs/architecture/subturn.md` + ROADMAP.md | ⭐⭐⭐⭐⭐ 高 | 95% 代码 AI 生成的事实来自 README;部分子文档(spawn-tasks/hooks/steering 原文)未单独抓取,描述基于 README 表格 + DeepWiki 索引交叉验证 |
| **memoh** | GitHub `memohai/Memoh`(README/DEPLOYMENT/目录树/LICENSE)+ `docs.memoh.ai`(Guides/Integrations/Self-hosted)+ `memohai/supermarket` + `memohai/twilight-ai` | ⭐⭐⭐⭐ 高 | Memoh Cloud 定价/上线时间未公开(仅 waitlist);ACP 协议规范原文未抓取(`spec/` 文件);`crates/a11y-cli` 为空目录占位 |
| **manboster** | GitHub `manboster/manboster`(README/README.zh_CN/releases/目录树)+ `manboster.dev/docs/{why,quickstart,container,hachimi,gatekeeper}.html` + 9 个 release changelog | ⭐⭐⭐⭐ 高 | LICENSE 直链 `blob/main` 404(实为 master 分支),多处声明一致确认为 Apache-2.0;数据库引擎未明(推测 SQLite/BoltDB);多数关键能力为 Planned,实际成熟度低于 README 描述 |

**整体说明**:

- 所有外部项目数据抓取时点为 **2026-06-30**,star/fork/commit 等动态数据会随后变化。
- 标注 `[?]` / `(推测)` / `(未查到)` 的字段表示公开 README 与主页未披露该信息,**不代表功能缺失**,仅代表本对比未能证实。
- 协议法律结论(§十五)基于通用解读,实际部署前请由企业法务复核;astrbot 的 `EULA.md`/`FIRST_NOTICE.md` 可能叠加额外条款。
- 本对比不构成任何项目的官方背书,选型决策需结合自身场景实测验证。

---

## 附录 D:本文档生成方式

- **方法论**:采用"并行 subagent + 中心合并"模式,共调度 **11 个独立 subagent**(首轮 4 维度对比 + 二轮 4 项目深度剖析 + 1 本地剖析 + 1 新维度对比 + 1 法律/可持续性补充)。
- **工具链**:opencode Task(general subagent)+ webfetch(GitHub/文档站抓取)+ Read/Glob/Grep(本地仓库源码读取)+ Edit/Write(合并产出)。
- **覆盖维度**:4 大对比维度 + 5 个项目深度剖析 + 8 个横向专项维度 + 4 个附录,共 **21 个章节**。
- **数据交叉**:每个外部项目至少经 2 个独立 subagent 从不同角度调研,关键数据(star、协议、IM 渠道数、技术栈占比)均交叉验证后才写入。

---

*文档生成时间:2026-06-30 · 数据基于各项目公开 GitHub README/LICENSE/文档站(实际抓取)· agentboster 部分基于本地仓库源码读取 · 共 21 章节*
