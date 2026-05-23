# ClawLess(WIP)

<p align="center">
	<img src="./app/icon.png" alt="clawless" width="160" />
</p>

<p align="center">
	<a href="./README.EN.md">EN: README</a>
</p>

<p align="center">
	<img alt="Bun" src="https://img.shields.io/badge/bun-%E2%9C%93-000000?logo=bun" />
	<img alt="License" src="https://img.shields.io/badge/license-MIT-yellow" />
	<img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue" />
</p>

> [!NOTE]
>
> 在版本号没有达到 1.0 之前，我建议你可以把本项目当作一个尝鲜，我们不保证向前的兼容性。
> 
> Until version 1.0 is released, I suggest you treat this as a try. We cannot guarantee full backwards compatibility at this stage.

![ClawLess](.docs/public/images/preview.png)

ClawLess 是一个部署在 **Vercel** 的免费 AI agent，它是 OpenClaw 和 Manus 的**轻量替代**。

ClawLess 拥有你对 OpenClaw 的需求：Chat, Skills, Memory (with RAG search), Channel, Bash Tools (runing on Sandbox) 和 Delay/Crons Tasks，我们还参考了 Manus 的一些特性，例如 Files, MCP, Sub-agents，而且**它是 Serverless 的**。

我们把 ClawLess 定义为一个轻量的 Agent，它**不是**你运行复杂工作的最佳地方，但**它免费，易于部署，而且能与你的 IM 进行连接**。所以，我们特别希望你用轻量甚至免费模型来体验 ClawLess，例如我非常喜欢的 `stepfun-3.5-flash`。

<table align="center">
	<thead>
		<tr>
			<th>🆚</th>
			<th>OpenClaw</th>
			<th>NanoBot</th>
			<th>PicoClaw</th>
			<th>...</th>
			<th><strong>ClawLess</strong></th>
		</tr>
	</thead>
	<tbody>
		<tr>
			<th>Language</th>
			<td>TypeScript</td>
			<td>Python</td>
			<td>Go</td>
			<td>...</td>
			<td><strong>TypeScript</strong></td>
		</tr>
		<tr>
			<th>Cost</th>
			<td>A Mac?</td>
			<td>A Linux?</td>
			<td>A Board?</td>
			<td>A Device?</td>
			<td>☁️ <strong>ZERO</strong> ☁️</td>
		</tr>
	</tbody>
</table>

## Deploy

你不需要下载到你的本地机器上，也不需要拥有一个 VPS，你只需要：

- 一个 Vercel 账号（免费版就够了）
- 一个和 OpenAI/Anthropic/Gemini 兼容的 API Key（如果你没有，那么可以在 OpenRouter 免费获得一个）
- 还有一个按钮，点击它，部署到 Vercel 上

另外，如果你在 Vercel 或者 OpenRouter 上充钱了，我建议你设置一个费用限制。

<p align="center">
	<a href=https://vercel.com/new/clone?repository-url=https://github.com/Niapya/clawless&stores=[{"type":"blob"},{"type":"integration","productSlug":"upstash-kv","integrationSlug":"upstash"},{"type":"integration","protocol":"storage","productSlug":"neon","integrationSlug":"neon"}]&env=AUTH_SECRET,USERNAME,PASSWORD&envDescription=Do_not_disclose_them_and_keep_them_safe.&project-name=clawless&repository-name=clawless&redirect-url=https://niapya.github.io/clawless target="_blank">
		<img src="https://vercel.com/button" alt="Deploy with Vercel" width="120" />
	</a>
</p>

如果你想更新，只需在你 fork 的仓库中同步上游仓库（sync fork），即可触发 Vercel 的自动部署。

## Quick Start

在部署时，你需要添加一个 `AUTH_SECRET` 用于加密，以及一个 `USERNAME` 和 `PASSWORD` 用于登录，这三个环境变量非常重要，不要泄漏他们。

在部署结束后，**你应该有一个公开链接**，把这个链接放在你浏览器的收藏夹中。

打开该链接，使用你的用户名和密码进行登录，然后进入到「Config」进行配置。

在配置中，你应该先在 Provider 中添加一个自己 API Key 的 Provider，大多情况，它是 OpenAI Compatible 类型的。

在 Provider 中添加你的 API Key 后，你应该设置你的 `Default Model` 和 `Embedding Model`，它们是用于聊天和记忆的默认模型。

在配置以上后，你的 Agent 应该可以在网页上聊天了，试着点击 Chat 中的第一个卡片，配置并自定义你自己的 Agent。

如果你想连接到你的 IM，也可以去 Channel 中设置和你 IM 相关的配置，然后设置一个白名单。在设置之后，你应该通过相关的配置，把 IM 的 Webhook 地址连接到你的 ClawLess。

ClawLess 可以使用 Vercel Sandbox 来执行命令，但它不是永久的，免费版的 Vercel 账号所用的 Sandbox 的时间是有限的，所以 ClawLess 不适用于复杂任务。

我们默认没有配置浏览器/搜索/天气等功能，如果你需要，请添加 MCP。

## Development

把本项目部署在本地或者在你的 VPS 是不可行的，我们目前不会支持，因为它是一个在 Vercel 平台的轻量替代，为什么不部署一个真正的 OpenClaw？

如果你需要开发或测试本项目，你需要先 Fork 并部署在 Vercel 上，然后在本地下载 Bun 环境，连接到你的 Vercel 后运行。

```bash
cd your-clawless

bun install

# 拉取 Vercel 环境变量到本地，包括 AUTH_SECRET，USERNAME，PASSWORD，以及 KV，DB，Blob 和 Sandbox 的 KEY。
bun vercel pull

bun dev
```

如果你遇到了 database schema 错误，尝试去运行 `postbuild` 脚本来执行数据库迁移。

本项目的技术栈是 Next.js ，使用 Upstash 提供的 Redis KV 和 Neon 提供的 Postgres (with `Vector` extension) 作为数据库。

文件存储使用 Vercel Blob，代码执行使用 Vercel Sandbox 来执行命令，为了搭建 Agent，我们使用 Vercel Workflow 和 Vercel AI SDK，为了和 IM 连接，我们使用 Webhook 的方式和 Vercel Chat SDK。

## Others

我正在找工作，如果你对我有兴趣，请联系我。

如果你有任何想法或者发现了问题，请随时提交 Pull Request 或者在 Issues 中提出，欢迎任何形式的贡献。

有人说这是一个玩具项目，你可以这么认为。自豪地采用 Codex 和 Copilot 进行 Vibe Coding，**我们会在之后逐渐提升代码可读性。**

感谢 OpenClaw 和 Manus 的灵感来源，Vercel 作为部署平台，还有所有用到的开源库，以及**你**。

本项目使用 MIT License.