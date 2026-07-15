### 项目定位与愿景

#### Agentboster

Agentboster 定位为多表面 AI 代理平台，由 Web、agentd 守护进程和 CLI 三层组成。Web 层是唯一权威，agentd 和 CLI 仅作为可替换的执行平面，通过窄口径 HTTPS 契约同步状态。整体强调单用户深度使用，围绕持久化工作流编排和安全审批流水线构建。

#### Memoh

Memoh 的核心理念是为每个 AI 代理提供独立的云端计算机，包含隔离的文件系统、桌面、浏览器和网络栈，可全天候独立运行。它支持多用户多机器人，每个机器人拥有自己的工作区容器，强调代理的自主性和持久存在感。项目采用 AGPLv3 许可，偏向社区驱动的开源模式。

### 许可证

#### Agentboster

采用 MIT 许可证，允许商业使用和闭源分发，对下游用户的约束最小。这种选择降低了企业集成的法律门槛，适合作为基础设施组件被广泛嵌入。

#### Memoh

采用 AGPLv3 许可证，要求通过网络提供服务时也必须公开源代码。这种强 copyleft 策略鼓励社区贡献回馈，但对希望闭源部署的商业用户构成限制，需要额外的商业授权安排。

### 编程语言与运行时

#### Agentboster

主体使用 TypeScript 6 构建于 Next.js 之上，服务端与客户端共享同一语言。agentd 守护进程用 Go 编写仅运行在 Linux 上，CLI 使用独立的 TypeScript 工具链。dbushelper 同样是 Go，专门处理 AT-SPI2 无障碍接口。

#### Memoh

后端完全使用 Go 构建，前端使用 TypeScript 加 Vue，桌面端基于 Electron，还有一个 Rust 编写的无障碍辅助工具。语言跨度更大，Go 负责所有服务端逻辑，前后端彻底分离，没有共享代码的便利但也避免了全栈耦合。

### 前端框架与UI体系

#### Agentboster

基于 Next.js 15 的 App Router 模式，使用 React 19 和 shadcn/ui 组件库。样式采用 Tailwind CSS 3 配合 CSS 自定义属性实现主题切换，暗色模式通过 next-themes 的 class 策略实现。动画依赖 Framer Motion，状态管理组合了 TanStack Query 和 AI SDK 的 useChat。

#### Memoh

前端使用 Vue 3 的 Composition API，构建工具为 Vite 8。UI 组件库是自研的 felinic/ui，基于 Reka UI 和 class-variance-authority。样式使用 Tailwind CSS 4 的纯 CSS 配置模式，无需传统配置文件。状态管理使用 Pinia 3 搭配 Pinia Colada 处理服务端状态。

### 后端架构模式

#### Agentboster

后端以 Next.js Route Handler 为载体，所有 API 端点都是 App Router 下的文件约定路由。AI 代理的执行循环作为 Workflow DevKit 的持久化步骤运行，每个 LLM 调用和工具循环都是可恢复的工作流步骤。这种架构将前后端统一在同一个 Node 进程中。

#### Memoh

后端是独立的 Go 服务，使用 Echo 框架提供 HTTP API，依赖注入通过 Uber FX 管理。AI 代理在 Go 进程内运行，不需要额外的代理网关。前后端完全分离部署，Web 前端由 nginx 独立托管，通过 API 调用与后端通信。

### 数据库与数据访问

#### Agentboster

使用 PostgreSQL 16 加 pgvector 扩展，ORM 为 Drizzle。支持双驱动模式：Vercel 上用 Neon 的 HTTP 驱动，自托管时用 node-postgres 的 TCP 连接。驱动根据数据库主机名自动选择，也可通过环境变量强制指定。迁移由 drizzle-kit 管理，共有十八个增量迁移文件。

#### Memoh

同样使用 PostgreSQL 但版本更新为 18，驱动为 pgx/v5。数据访问层使用 sqlc 从 SQL 生成类型安全的 Go 代码，而非 ORM 映射。pgvector 作为独立的 PostgreSQL 服务部署，专门用于语义记忆的向量搜索。迁移使用 golang-migrate，积累了超过一百零六个增量迁移文件。

### 认证与会话管理

#### Agentboster

系统存在三套彼此独立的凭据，切勿混为一谈。用户会话由 AUTH_SECRET 做 HMAC-SHA256 签名，浏览器用 Cookie、CLI 用同格式的 Bearer 令牌；CLI 令牌经一次性配对码换取，携带设备标识，可在服务端按设备吊销。agentd 回调用独立的 AGENTD_API_KEY(与 AUTH_SECRET 无关，支持逗号分隔轮转)加可选 mTLS。频道适配器各自持有自己的机器人 token/密钥，其 Webhook 把 AUTH_SECRET 嵌入回调路径做校验，与用户会话签名同源但用途不同。三者的签名密钥、轮转方式和吊销范围各不相同。

#### Memoh

采用 JWT 令牌机制，使用 HS256 签名，默认有效期一百六十八小时。令牌通过 Authorization 头或查询参数传递，前端存储在 localStorage 中。认证中间件在 Echo 层面统一拦截，对公开路径如健康检查、Swagger 文档和频道回调进行豁免。

### AI 与大模型集成

#### Agentboster

通过 Vercel AI SDK v6 作为统一模型接口，内置支持 OpenAI、Anthropic、Google 和任意 OpenAI 兼容端点。预设了 DeepSeek、Ollama、OpenRouter 等八个提供商配置。支持 MCP 工具协议集成、文本转语音和 RAG 向量嵌入。模型选择支持全局默认、用户偏好和逐条消息覆盖。

#### Memoh

使用自研的 Twilight AI Go SDK 作为 LLM 抽象层，支持 OpenAI、Anthropic、Google 等协议。预设了超过四十个提供商的 YAML 配置文件，覆盖范围更广。除文本模型外还支持语音合成与识别、视频生成等多模态能力。模型能力信息通过 LiteLLM 注册表快照同步获取。

### 工作流与代理编排

#### Agentboster

基于 Workflow DevKit 构建持久化代理循环，每个 LLM 调用标记为可恢复步骤。支持指令钩子、审批钩子和本地工具钩子，实现工作流的暂停与恢复。提供子代理编排原语包括屏障同步、任务交接和结果聚合。上下文过长时自动压缩摘要。

#### Memoh

代理在 Go 进程内直接执行，通过会话流解析器组装历史、记忆、身份和工具。提供超过三十种生命周期钩子事件，从工具调用前后到消息发送前后均可拦截。钩子可执行容器内命令或调用工具，返回允许、拒绝或追加上下文等决策。支持循环检测防止代理陷入重复行为。

### 实时通信机制

#### Agentboster

全部基于 SSE 和 HTTP 回调实现，不使用 WebSocket。AI 响应通过 ReadableStream 流式传输。CLI 工具调用采用双向模式：服务端通过 SSE 发送工具请求，CLI 本地执行后通过 HTTP 回传结果。支持工作流运行的断线重连。

#### Memoh

同时支持 SSE 和 WebSocket 两种实时通道，WebSocket 用于双向聊天通信并支持自动重连。此外还引入了 WebRTC 用于工作区桌面显示的视频流传输，通过 GStreamer 编码和 pion 库实现。流式事件类型丰富，涵盖文本增量、推理增量和工具调用状态等。

### 部署方式

#### Agentboster

支持 Vercel 一键部署和 Docker Compose 自托管两种模式。Vercel 模式使用平台原生的 Blob、KV 和 Neon 数据库服务。自托管模式通过多阶段 Dockerfile 构建，搭配 PostgreSQL、Redis 和 MinIO。工作流状态在自托管时使用文件系统持久化。

#### Memoh

仅支持自托管部署，提供一键安装脚本和 Docker Compose 编排。服务端容器以特权模式运行，内嵌 containerd 用于工作区隔离。可选的 Cloudflare 隧道解决 NAT 穿透问题。桌面客户端通过 Electron 分发，可连接自托管服务器或云端服务。

### 即时通讯适配器

#### Agentboster

支持九个平台的即时通讯接入，包括 Telegram、Discord、Slack、Teams、Google Chat、飞书、QQ、企业微信和钉钉。其中前五个使用 chat-adapter 包族统一封装，后四个为项目内自研适配。Webhook 地址将认证密钥嵌入 URL 路径，绕过常规会话中间件。

#### Memoh

覆盖十余个平台，包括 Telegram、Discord、飞书、QQ、钉钉、微信、企业微信、微信公众号、Matrix、Misskey、LINE 和 Slack。每个平台有独立的适配器子目录和专属 SDK。提供跨平台身份绑定机制，通过频道身份表和用户绑定表实现统一用户识别。还支持机器人级别的访问控制列表。

### 存储系统

#### Agentboster

KV 存储采用双后端设计：Vercel 上使用 Upstash Redis HTTP 接口，自托管时用 PostgreSQL 表模拟键值操作并实现惰性过期清理。Blob 存储同样双后端：Vercel 使用平台原生 Blob 服务，自托管时对接 S3 或 MinIO，通过签名代理路由避免暴露存储凭据。

#### Memoh

没有独立的 KV 存储层，所有状态直接持久化到 PostgreSQL。对象存储通过可插拔接口实现，支持容器内文件系统、本地文件系统和回退策略三种提供者。媒体资源采用内容寻址方式管理，通过哈希值去重。内存中的临时状态如代理运行时池仅存在于服务端进程内。

### 记忆与知识库

#### Agentboster

提供三层记忆体系：内置记忆存储代理人格和身份信息，会话记忆保存每次对话的上下文摘要，长期记忆使用 pgvector 向量索引和全文搜索实现语义检索。知识库系统独立于记忆，支持文档导入、分块和向量化，提供专门的增删查改接口和搜索能力。

#### Memoh

采用图加向量的混合记忆架构，记忆节点和边存储在关系表中，包含层级、事实类型、主题和置信度等元数据，并通过 pgvector 索引实现语义搜索。除内建记忆外还集成了 Mem0 和 OpenViking 等第三方记忆提供者。记忆的提取和写入均可被生命周期钩子拦截和增强。

### 安全体系

#### Agentboster

实现了三级安全流水线：L0 为可配置的规则引擎进行预过滤，L1 由模型自动评分判断风险等级，L2 需要人类审批后才能继续执行。所有安全决策都记录在审计日志中。此外还提供基于 AES-256-GCM 加密的 Vault 密钥保险库，支持密钥轮转和审计追踪。

#### Memoh

安全性主要通过工具审批机制实现，敏感工具调用需要用户人工确认后才能执行。工作区容器本身提供了物理隔离层，每个机器人运行在独立的文件系统和网络栈中。生命周期钩子可以在工具执行前后注入安全检查，返回拒绝或追加上下文等决策。没有显式的多级安全流水线抽象。

### 测试体系

#### Agentboster

使用 Vitest 3 作为测试框架，测试环境为 Node 而非 jsdom。测试文件分布在 lib、app、hooks 和 components 目录下，CLI 子包的测试也从根目录运行以共享路径别名配置。Go 子包使用标准的 go test。持续集成在 GitHub Actions 上运行，覆盖 Node 22 和 24 两个版本矩阵。

#### Memoh

前端测试使用 Vitest 4 的多项目配置，分别覆盖 Web 和桌面端。后端 Go 测试使用 testify 断言库，在流解析器、钩子、技能、认证、压缩和内存适配器等模块有较广泛的覆盖。提交前通过 Husky 和 lint-staged 运行增量检查。没有公开的持续集成配置信息。

### 构建与工具链

#### Agentboster

构建由 next build 驱动并被 Workflow DevKit 包裹，工作流捆绑器是唯一能捕获 node 模块导入违规的环节。类型检查和代码风格由 Biome 统一管控，不使用 ESLint 和 Prettier。Turbopack 用于开发模式加速。构建时刻意忽略类型和 lint 错误，质量门禁依赖独立的 lint:check 命令。

#### Memoh

使用 mise 作为统一任务运行器管理所有开发工作流，涵盖代码生成、文档构建和跨语言编译。Go 端使用 golangci-lint 进行静态分析，前端使用 ESLint 9 配合 vue-eslint-parser。前端通过 Vite 8 构建，桌面端由 electron-vite 和 electron-builder 处理。版本发布使用 bumpp 管理语义化版本号。

### 国际化

#### Agentboster

内置七个语言区域的支持，包括简体中文、繁体中文、香港繁体、美式英语、英式英语、日语和韩语。国际化模块位于 lib/i18n 目录，服务端直接提供翻译后的内容。前端通过 next-themes 和区域设置联动实现本地化体验。

#### Memoh

前端使用 vue-i18n v11 实现国际化，目前支持英语和中文两种语言，翻译文件按命名空间组织覆盖所有用户界面文本。后端有独立的零依赖本地化目录，支持英语、中文和日语三种语言，主要服务于即时通讯频道的命令界面。项目文档同时维护英文、中文和日文三个版本。

### 配置管理

#### Agentboster

应用配置以 JSON 形式存储在 KV 存储中，通过 Zod 模式验证。配置涵盖模型、代理、聊天、语言、频道、自主性、安全、沙箱、工具、MCP 和语音合成等十余个类别。Web 界面提供草稿和保存的编辑流程。agentd 使用独立的 TOML 配置文件并支持环境变量覆盖。

#### Memoh

配置基于单一 TOML 文件，涵盖日志、服务器、认证、代理、数据库、容器、注册中心等二十余个分区。提供针对 Docker、macOS 和 Windows 等不同环境的配置模板。LLM 提供商通过独立的 YAML 预设文件管理。前端通过共享的 config 包读取配置，支持环境变量覆盖核心参数。

### 日志系统

#### Agentboster

服务端日志通过 createLogger 工厂函数创建，输出带时间戳、级别和作用域前缀的格式化信息，适配 Vercel 平台日志收集。生产环境中 Next.js 编译器自动剥离 console.log 仅保留 error 和 warn。agentd 使用 Go 标准库 slog 并附加模块和代码位置信息。

#### Memoh

后端日志同样基于 Go 标准库 slog，支持文本和 JSON 两种输出格式，通过配置文件的 log 分区设定级别。日志器可通过上下文传播，支持请求级别的追踪。前端依赖浏览器控制台进行调试。Echo 中间件自动记录每个请求的方法、路径、状态码、延迟和客户端 IP。

### 错误处理模式

#### Agentboster

API 层通过 Zod 验证输入并返回结构化的 JSON 错误响应。工作流错误被捕获后标记为错误状态并关闭流。内置工具调用自动修复机制，可纠正拼写错误的工具名称。流守卫过滤异常的工作流数据块。agentd 使用统一的成功加数据加错误信封格式。

#### Memoh

Go 后端使用 Echo 框架的 HTTP 错误类型，服务层通过 fmt.Errorf 包装错误链以支持类型断言。每个包定义自己的哨兵错误如机器人未找到、运行时不存在等。前端封装了统一的 API 错误解析函数，从多个 JSON 字段中提取错误信息，并通过对话式变更组合自动弹出错误提示。

### 包管理与仓库结构

#### Agentboster

根目录是独立的 Next.js 应用，使用 Yarn Classic 管理依赖，不是工作区根。三个子包完全独立：agentd 和 dbushelper 各有自己的 Go 模块，CLI 是独立的 Yarn Classic 工作区。根目录的 TypeScript 和 Biome 配置显式排除所有子包目录，各自维护独立的工具链版本。

#### Memoh

使用 pnpm 10 管理 TypeScript 侧的单仓多包结构，工作区包含 Web 应用、桌面端、UI 库、SDK 和图标库等六个包。Go 后端是单一模块包含六十余个领域子包。Rust 代码通过 Cargo 工作区管理。UI 组件库作为 git 子模块引入，安装前脚本自动检查子模块初始化状态。

### 中间件模式

#### Agentboster

单一 middleware.ts 文件拦截所有非静态路径请求。绕过规则按类别分组：登录路径、工作流内部路径、L2 审批链接、Blob 代理、机器人回调和 agentd 密钥路由。认证成功后将用户标识写入响应头供下游路由处理器读取。API 密钥比较使用恒定时间算法防止时序攻击。

#### Memoh

Echo 中间件按顺序堆叠：崩溃恢复、请求体大小限制、跨域配置、结构化请求日志和 JWT 认证。CORS 策略较为宽松，允许所有来源访问。公开路径的豁免在 JWT 中间件的跳过函数中定义，涵盖健康检查、API 文档、频道回调和 OAuth 回调等端点。

### 桌面端

#### Agentboster

没有独立的桌面客户端应用。CLI 子包提供终端交互界面，以 TUI 和纯文本两种模式运行。CLI 通过配对登录与 Web 后端建立关联，所有模型调用和会话持久化都在 Web 端完成，CLI 仅负责本地工具执行和界面渲染。

#### Memoh

提供基于 Electron 34 的完整桌面客户端，通过 electron-vite 构建并由 electron-builder 打包分发。桌面端复用 Web 前端模块，额外实现了系统托盘、原生菜单和进程间通信。可连接自托管服务器或云端服务，连接地址通过环境变量配置。桌面端有独立的类型检查作用域和测试项目。

### 容器与沙箱隔离

#### Agentboster

agentd 支持 Docker、严格 Docker 和 LXC 三种沙箱模式，通过动态 goroutine 工作池执行工具调用。沙箱元数据存储在数据库中，每个工作区绑定一个沙箱实例。工作流步骤代码在 vm.Script 沙箱中运行，该沙箱隔离全局对象，不提供 fetch 和文件系统访问。

#### Memoh

每个机器人拥有独立的工作区容器，支持 containerd、Docker 和 Apple 虚拟化三种后端。容器管理包含完整的生命周期：创建、启动、停止、快照和版本管理。可选启用 Kata Containers 获得基于 KVM 的增强隔离。容器内提供标准化的数据目录结构，钩子和插件直接在容器文件系统中运行。

### 插件与技能系统

#### Agentboster

技能以可加载的捆绑包形式存储在 KV 中，支持从文件或 URL 安装，通过 Web 界面管理。MCP 工具服务器可通过界面配置并在代理循环中动态加载。项目仓库内的 agents/skills 目录包含面向开发者的本地技能文件，用于编码会话中的知识复用。

#### Memoh

提供插件市场机制，支持插件的安装、启用和生命周期管理。技能系统有独立的目录和激活流程，技能发现根支持自定义配置。插件在容器内运行，通过环境变量注入上下文信息。MCP 连接支持 OAuth 认证和工具网关模式，每个机器人可绑定独立的 MCP 服务。

### API 文档与SDK生成

#### Agentboster

没有集中的 API 文档生成机制。API 端点通过 Next.js 文件约定路由自描述，输入验证依赖 Zod 模式定义。CLI 子包的 adapter 层封装了远程 API 调用，但没有从规范自动生成客户端 SDK 的流程。

#### Memoh

使用 swaggo 从 Go 代码注释自动生成 Swagger 和 OpenAPI 规范文件，并在运行时通过专用端点提供在线文档浏览。前端 SDK 通过 hey-api/openapi-ts 从规范自动生成类型安全的 TypeScript 客户端，同时生成 Pinia Colada 查询辅助函数，实现端到端的类型贯通。

### 多用户与权限模型

#### Agentboster

设计为单用户系统，通过环境变量设定唯一的管理员账户。所有会话和配置归属同一用户。CLI 设备通过配对机制关联到该用户，设备令牌支持服务端吊销但不涉及多用户权限划分。

#### Memoh

原生支持多用户多机器人架构。用户表支持角色区分，机器人拥有独立的访问控制列表和用户授权表。跨平台身份绑定允许同一用户通过不同即时通讯平台关联到统一账户。机器人级别的频道配置和路由规则实现了细粒度的访问控制。

### 语音与多模态能力

#### Agentboster

语音合成仅支持 OpenAI 的 TTS 服务，提供 tts-1 和 gpt-4o-mini-tts 两个模型选项。语音回复可通过 Web 自动播放和即时通讯频道发送。嵌入向量用于 RAG 知识库和长期记忆的语义检索。没有视频生成或桌面视觉流传输能力。

#### Memoh

多模态能力显著更丰富，语音合成和识别支持十余个提供商，包括 Edge Speech、ElevenLabs、DeepGram 和国内的火山引擎、阿里云等。视频生成支持 OpenRouter 和火山引擎等渠道。桌面视觉通过 WebRTC 实时传输容器内的显示画面，配合无障碍树快照实现计算机使用能力。

### 总结

两个项目虽然同属 AI 代理平台领域，但在架构哲学上存在根本差异。Agentboster 选择 TypeScript 全栈加持久化工作流的路线，将复杂性集中在编排层，适合深度集成 Vercel 生态的单用户场景。Memoh 走多语言微服务路线，后端 Go 前端 Vue 彻底分离，围绕容器化工作区构建多用户多机器人体验，功能覆盖面更广但部署复杂度也更高。两者在即时通讯覆盖、记忆系统和安全机制上各有侧重，选型取决于具体的部署环境、用户规模和功能优先级。
