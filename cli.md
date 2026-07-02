
看了很多强调上下文重要性的文章，用cc接国模愈发不顺手，总感觉cc的上下文屎山是不是越来越大了，于是捡起之前折腾了一半的pi，我的想法和作者部分一致，**上下文工程是第一要务**，准确的控制注入模型的每一个字肯定能获得比黑盒更舒服更有包裹感(误 。
![pi|690x398, 100%](upload://kYT5nfKN3G737r9AA0ksbxvsSh1.jpeg)

点进这个帖子的应该或多或少都是听说过[pi](https://pi.dev/)的，如果不了解请看[作者的文章](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
总而言之pi是一个极度精简的**agent**，**无 MCP、无后台 bash、无内置 to-do、无 plan mode、无子 agent，本体的内置提示词不超过1000token，仅内置4 个工具：read、write、edit、bash**
但是极简的框架意味着极强的可塑性，下文正式开始折腾。

---

## 关于package是什么
在pi中，Package 可以是：

- **Extension**：注册新命令、工具、事件钩子、UI 组件
- **Skill**：带 `SKILL.md` 的技能文档，指导模型使用特定工作流
- **Prompt Template**：提示词模板
- **Theme**：终端主题 JSON

在pi中，一切都可以由package引入

---

## 子agent与mcp

[**pi-subagents**](https://www.npmjs.com/package/pi-subagents)，[**pi-mcp-adapter**](https://www.npmjs.com/package/pi-mcp-adapter)，没什么好说的，补全其他家都有的功能，不过mcp的package我没装，我用到的mcp基本都可以做成package。

---

## 关于上下文压缩

我主要纠结在三个包里，[**context-mode**](https://www.npmjs.com/package/context-mode)、[**DCP**](https://github.com/complexthings/pi-dynamic-context-pruning)、[**pi-observational-memory**](https://www.npmjs.com/package/pi-observational-memory)

[**context-mode**](https://www.npmjs.com/package/context-mode)作为pi package安装量排行榜第一我自然第一个尝试了，但是效果并不好，用mimo容易出现理解偏差，它把工具输出拦截到沙箱，模型只能看到摘要？要看原文得自己判断是否展开，但模型经常判断错，导致关键信息丢失(猜的流程)，我是觉得没必要省这种上下文，所以最后卸了。

[**DCP**](https://github.com/complexthings/pi-dynamic-context-pruning)就是比较常见的总结形式的工具了没什么好说的，我现在就在用，具体可以看看项目文档。

[**pi-observational-memory**](https://www.npmjs.com/package/pi-observational-memory)，可以单独配置模型进行总结，主要用于长会话防偏移，也是总结类的，但是设计比DCP复杂一点，还在体验中。

![image-20260602185252032](upload://fcYQLXh48nCWXe0EKrWtMCImW7e.png)



---

## 关于/goal

codex的/goal很不错，目标完成前不会停止，pi的相关package我主要使用[**pi-until-done**](https://www.npmjs.com/package/pi-until-done)，如果追求codex的感觉可以装[**pi-codex-goal**](https://www.npmjs.com/package/pi-codex-goal)。

<img src="upload://8zvyl1AoHQuKZeDbsHinqOtU7bv.png" alt="image-20260602185508411" style="zoom:50%;">

---

## 代码搜索与检索

[**pi-ace-tool**](https://github.com/justhil/pi-ace-tool)，自己写的ace-tool插件，这个用过mcp的应该知道有多好用，详情可以看[pi-ace-tool](https://linux.do/t/topic/2164629)。

[**@ff-labs/pi-fff**](https://www.npmjs.com/package/@ff-labs/pi-fff)，Rust/SIMD 加速的模糊find和grep，替代原生 find/grep，速度极快，体验不错。

[**pi-fast-context**](https://github.com/justhil/pi-fast-context)，vibe了一个fast-context的插件，用着不错速度挺快的。

---

## 搜索与抓取

[**pi-search**](https://github.com/justhil/pi-search)，基于站内的grok-search-mcp自己写的，加了context7和反检测fetcher之类的实用工具，基本搜索相关装这一个就够了,不过我也犯了塞太多的毛病，不想用可以看看[pi-web-access](https://pi.dev/packages/pi-web-access)和[pi-smart-fetch](https://pi.dev/packages/pi-smart-fetch)。

---

## 安全与审查

[**@juicesharp/rpiv-advisor**](https://www.npmjs.com/package/@juicesharp/rpiv-advisor)  请求强模型给第二意见/审查建议，关键决策前多一层校验

[**pi-simplify**](https://www.npmjs.com/package/pi-simplify)  审查近期代码改动的清晰度、维护性和一致性

[**@narumitw/pi-plan-mode**](https://www.npmjs.com/package/@narumitw/pi-plan-mode)  `/plan` 只读规划模式，禁止 edit/write/危险 bash，输出 proposed_plan 确认后才恢复写权限

---

## UI 与交互

[**pi-nano-context**](https://www.npmjs.com/package/pi-nano-context)  紧凑上下文占用条，显示 system/user/assistant/tool/free 各占多少，替代 powerline 的轻量选择

[**pi-tool-display**](https://www.npmjs.com/package/pi-tool-display)  OpenCode 风格工具输出折叠和 diff 渲染，减少 TUI 被大段工具输出刷屏

[**pi-markdown-preview**](https://www.npmjs.com/package/pi-markdown-preview)  Markdown/LaTeX 预览

[**@juicesharp/rpiv-ask-user-question**](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)  结构化提问 UI

---

## 思考与辅助

[**@feniix/pi-sequential-thinking**](https://www.npmjs.com/package/@feniix/pi-sequential-thinking)  同名mcp一个作用

[**pi-btw**](https://www.npmjs.com/package/pi-btw)  claudecode同款`/btw` 并行旁路问题，不污染主对话

---

## 图像生成

[**pi-image-gen**](https://github.com/justhil/pi-image-gen)  自己写的Image2 图像生成/编辑 工具，支持文生图、图生图等，优化前端设计场景，我主要用在写前端前的风格，素材等生成

---

## 操作回退

[**pi-rewind**](https://www.npmjs.com/package/pi-rewind)  依赖git的存档点回退工具，很不错，原生级的回退体验

---

## 踩过的坑

### [**pi-powerline-footer**](https://www.npmjs.com/package/pi-powerline-footer) 太重

powerline会接管编辑器布局和鼠标滚动，改变了 pi 原生简洁的 TUI 体验。推荐 [**pi-nano-context**](https://www.npmjs.com/package/pi-nano-context)，只做上下文占用显示，干净轻量。

<img src="upload://vuV8o6I0UiIvy4Nh6U9GtEXG6wG.jpeg" alt="image-20260602194600060" style="zoom: 33%;">

---

## Package 总览

| Package      | 链接                                              | 安装                          |
|              |                                                   |                               |   | ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| pi-subagents | [npm](https://www.npmjs.com/package/pi-subagents) | `pi install npm:pi-subagents` |
|              |                                                   |                               |   | pi-mcp-adapter                           | [npm](https://www.npmjs.com/package/pi-mcp-adapter)          | `pi install npm:pi-mcp-adapter`                              |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   | pi-markdown-preview | [npm](https://www.npmjs.com/package/pi-markdown-preview) | `pi install npm:pi-markdown-preview` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   | @juicesharp/rpiv-ask-user-question | [npm](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | `pi install npm:@juicesharp/rpiv-ask-user-question` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   | @victor-software-house/pi-curated-themes | [npm](https://www.npmjs.com/package/@victor-software-house/pi-curated-themes) | `pi install npm:@victor-software-house/pi-curated-themes` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   | pi-ace-tool | [GitHub](https://github.com/justhil/pi-ace-tool) | `pi install git:github.com/justhil/pi-ace-tool` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   | pi-rewind | [npm](https://www.npmjs.com/package/pi-rewind) | `pi install npm:pi-rewind` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   | pi-image-gen | [GitHub](https://github.com/justhil/pi-image-gen) | `pi install git:github.com/justhil/pi-image-gen` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   | pi-search | [GitHub](https://github.com/justhil/pi-search) | `pi install git:github.com/justhil/pi-search` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   |           |                                                |                                               |   | pi-btw | [npm](https://www.npmjs.com/package/pi-btw) | `pi install npm:pi-btw` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   |           |                                                |                                               |   |        |                                             |                         |   | pi-simplify | [npm](https://www.npmjs.com/package/pi-simplify) | `pi install npm:pi-simplify` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   |           |                                                |                                               |   |        |                                             |                         |   |             |                                                  |                              |   | pi-dynamic-context-pruning (DCP) | [GitHub](https://github.com/complexthings/pi-dynamic-context-pruning) | `pi install git:github.com/complexthings/pi-dynamic-context-pruning` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   |           |                                                |                                               |   |        |                                             |                         |   |             |                                                  |                              |   |                                  |                                                                       |                                                                      |   | @ff-labs/pi-fff | [npm](https://www.npmjs.com/package/@ff-labs/pi-fff) | `pi install npm:@ff-labs/pi-fff` |
|              |                                                   |                               |   |                                          |                                                              |                                                              |   |                     |                                                          |                                      |   |                                    |                                                                         |                                                     |   |                                          |                                                                               |                                                           |   |             |                                                  |                                                 |   |           |                                                |                            |   |              |                                                   |                                                  |   |           |                                                |                                               |   |        |                                             |                         |   |             |                                                  |                              |   |                                  |                                                                       |                                                                      |   |                 |                                                      |                                  || pi-until-done                            | [npm](https://www.npmjs.com/package/pi-until-done)           | `pi install npm:pi-until-done`                )
