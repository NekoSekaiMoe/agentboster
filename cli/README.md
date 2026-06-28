# AgentBoster CLI

`cli/` 目录是 AgentBoster 的终端客户端（coding agent）工作区，执行的是 `agentboster` CLI，本质上是 `agentboster` 命令的源码工程与构建产物。

---

## 目录与职责

- `packages/ai`：LLM 适配层（模型与 provider 抽象）
- `packages/agent`：核心 Agent 会话/执行能力
- `packages/agentboster-adapter`：接入 AgentBoster 后端接口的 adapter
- `packages/tui`：终端交互 UI
- `packages/coding-agent`：CLI 本体（`agentboster` 命令）

---

## 快速开始（开发者）

### 1. 安装依赖

```bash
cd cli
npm install
```

> 依赖要求：Node.js >= 22.19.0

### 2. 构建

```bash
npm run build
```

该命令会按依赖顺序构建 `tui`、`ai`、`agent`、`agentboster-adapter`、`coding-agent`，并生成 `packages/coding-agent/dist/*`。

### 3. 快速执行（源码方式）

```bash
cd cli/packages/coding-agent
node dist/cli.js --help
node dist/cli.js --version
node dist/cli.js
```

也可直接从源码运行（开发阶段）：

```bash
npx tsx src/cli.ts --help
```

---

## 使用 `agentboster` 命令（对接方式）

`coding-agent` 包的 `bin` 输出：

```text
agentboster
```

发布后的可执行文件可直接运行：

```bash
agentboster --help
agentboster login
agentboster "修复一下这个 TypeScript 报错"
agentboster -p "请输出该仓库的依赖树"
agentboster --print "请列出 src 下的 .ts 文件"
agentboster --provider openai --model gpt-4o-mini "帮我重构这段代码"
```

常用 flags（摘要）：

- `--help/-h`：帮助
- `--version/-v`：版本
- `--provider`：指定 provider（默认 google）
- `--model`：模型（支持 provider/model 形式）
- `--api-key`：手动注入 API key（通常由登录流程写入配置）
- `--print/-p`：非交互模式
- `--offline`：禁用启动网络（同 `PI_OFFLINE=1`）
- `--session` / `--continue` / `--resume`：会话管理
- `--tools/-t` / `--exclude-tools/-xt`：工具白名单与黑名单
- `--thinking`：off/minimal/low/medium/high/xhigh
- `--theme`、`--skill`、`--extension`：资源与扩展

如需完整选项说明，可执行：

```bash
agentboster --help
```

---

## 打包与本地安装

### 打包成单文件（内置脚本）

```bash
cd cli
npm run bundle   # 输出 packages/coding-agent/dist/agentboster.cjs
npm run package  # 生成 agentboster-cli-<version>.tar.gz
```

解压后：

```bash
tar xzf agentboster-cli-0.80.2.tar.gz
cd agentboster-cli-0.80.2
./agentboster --version
./agentboster "你好"
```

---

## 常用环境变量（按重要程度）

- `AGENTBOSTER_URL`：启用 AgentBoster 后端接入（如配置）
- `AGENTBOSTER_SESSION_ID`：固定会话 ID
- `AGENTBOSTER_CLIENT_ID`：客户端标识（默认 `local-cli`）
- `AGENTBOSTER_MODEL`：默认模型（覆盖模型选择）
- `PI_OFFLINE=1`：启动时禁用网络
- `PI_PACKAGE_DIR`：Nix/特殊环境下覆盖运行期资源路径
- `PI_TIMING=1`：输出运行时计时日志

此外，`cli` 通过 `login` 子命令保存 provider token 到用户配置目录，优先使用配置文件进行鉴权。

---

## 常见问题

### 1. 命令找不到

- 确认已执行 `npm run build`，并从 `dist` 路径或打包目录运行
- 若使用全局命令，确认 `agentboster` 可执行文件在 PATH 中

### 2. 执行缓慢 / 无法联网

- 检查 Node 版本（>=22.19）
- 检查是否误开启 `--offline`/`PI_OFFLINE=1`
- 检查 `AGENTBOSTER_URL` 与鉴权状态是否正确

### 3. 登录/鉴权失败

- 先执行 `agentboster login`
- 检查 `~/.agentboster/config.json` 与 `~/.agentboster/agent/auth.json` 是否可写

---

## 关联文档

- 根仓库说明：`README.md`
- `agentd/README.md`：daemon 使用说明
- `cli/AGENTS.md`：仓库内开发规范与依赖要求
