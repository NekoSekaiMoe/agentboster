# 配置与 Skills

PiDeck 提供图形化配置入口，减少频繁查找和编辑 pi 配置文件的成本。

## 配置管理

配置弹窗包含以下页面：

- Models：Provider 卡片、模型网格和连接测试。
- Auth：API Key 管理。
- Settings：类型感知的键值编辑器。
- 源文件：查看和编辑原始 JSON。
- Skills：管理全局 Skills。

<img class="doc-screenshot" src="/images/config.png" alt="配置管理界面">

## pi 路径

应用启动时会自动检测系统中的 `pi` 命令。自动检测失败时，可以在设置中手动输入路径。

Windows 下支持常见路径形式：

```text
"C:\Program Files\pi\pi.cmd"
C:\\Program Files\\pi\\pi.cmd
C:\Program Files\pi\pi
```

## 代理设置

PiDeck 区分两类代理：

- pi agent 子进程代理：影响实际 Agent 进程。
- 桌面端代理：影响模型拉取、连接测试等桌面应用请求。

这种拆分可以避免桌面端检测和 Agent 执行互相干扰。

## 外部编辑器管理

设置中新增“编辑器”配置页，支持检测、启用/禁用和配置系统中的外部编辑器。

### 支持的编辑器

- Visual Studio Code（含 Insiders、VSCodium）
- Cursor
- Zed
- IntelliJ IDEA
- WebStorm
- PhpStorm
- PyCharm

### 检测方式

Windows 下按以下顺序尝试：

1. **PATH 环境变量**：如果编辑器命令已在系统 PATH 中，直接使用
2. **常见安装目录**：检测各编辑器的标准安装路径
3. **Windows 注册表**：扫描已安装应用的注册表信息

检测到的编辑器会自动启用，你也可以手动添加或修改路径，或禁用不使用的编辑器。

### 使用方式

编辑器配置好后，在以下位置可以看到编辑器入口：

- **项目右键菜单** → 用编辑器打开项目
- **文件右键菜单** → 在编辑器中打开文件

## Skills 管理

Skills 页面支持查看全局 Skill、创建模板、启用或禁用、删除和打开目录。删除操作会使用应用内确认弹窗，避免误删。
