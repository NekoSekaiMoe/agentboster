# 更新日志

完整更新日志仍维护在仓库根目录：

- [中文 CHANGELOG](https://github.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md)
- [English CHANGELOG](https://github.com/ayuayue/PiDeck/blob/main/CHANGELOG.md)

## v0.6.2

发布时间：2026-06-22

- Agent/历史会话统一列表：项目下方改成混排列表，默认 5 个，按时间排序
- 外部编辑器管理：支持检测、配置 VS Code / Cursor / Zed / JetBrains IDE 等
- 修复历史会话重复显示/激活问题（路径大小写不敏感比较）
- 修复关闭 Agent 后重新打开历史会话消息空白（移除预热池）
- 修复单纯打开但未发送消息导致排序提前
- 日志页增加级别筛选和时间范围筛选
- 顶部 header 按钮视觉统一
- Windows 注册表检测编辑器安装路径，提高自动检测准确率

## v0.6.1

发布时间：2026-06-16

- 配置管理批量删除与复制：Provider 和 Auth 支持批量删除和一键复制
- Auth 供应商选择器：内置 29 个预配置供应商
- 模型选择器分组折叠：按供应商分组折叠，搜索自动展开
- API 类型下拉优化：新增标签和详细描述
- User-Agent 预设扩展：新增 claude-cli、claude-code 等
- 多项 Bug 修复

## v0.6.0

发布时间：2026-06-14

- 会话活动轨迹：思考、工具调用和回答片段按流程聚合展示，工具详情可展开复制。
- 会话导入：项目右键菜单支持导入 Claude 会话，并继续支持 Codex 会话导入。
- 性能与输入：长历史会话分页和懒渲染减少卡顿，输入框更适合多行内容，命令历史可用方向键复用。
- 稳定性：Windows 绿色版设置持久化、系统托盘行为和 bash 工具退出码展示更可靠。

## 历史版本

请以仓库根目录的 CHANGELOG 为准。官网只摘录最近版本，避免发布信息在多个位置长期分叉。
