## 概述

实现 PiDeck 桌面宠物（Desktop Pet）完整系统，包含透明悬浮窗、状态聚合动画、自动巡游、Review 提示、双击逗弄等能力，共 11 个提交。

---

## 功能清单

### MVP-1：全局透明悬浮窗
- 独立 `BrowserWindow` 透明悬浮窗，不受主窗口焦点影响
- 多 Agent 状态聚合为单宠动画（idle/running/review/jumping/falling 等 9 行动画）
- 宠物窗口可拖拽、位置持久化
- **降级渲染**：Linux/Wayland 透明不支持时自动退化为圆角小窗

### MVP-2：交互与通知
- **focusAgent**：单击宠物跳转到活跃 Agent 标签页
- **waving 过渡态**：Agent 切换时平滑过渡
- **macOS 全屏可见**：全屏应用下宠物依旧可见
- **通知气泡**：任务完成时弹出"记得 review"气泡
- **主窗关闭保留**：关闭主窗口后宠物不受影响，重开自动恢复

### MVP-3：巡游 / Review / 逗弄
- **自动巡游**：idle 时随机走动（3-7s 走 → 8-25s 停），方向随机，碰边即停
- **Review 动画**：Agent 任务完成时播放放大镜 review 动画，替代旧 jumping
- **双击逗弄**：双击宠物触发蹦跳动画（2.5s），running 态下不打断
- **巡游开关**：设置面板一键开关

### 内置宠物
- Clawd / Wangcai / Arthur-Mergeon 三套精灵表
- `PetPackageManager` 支持外部宠物包管理

### 附带修复
- `scripts/fix-pty-permissions.js` + postinstall：修复终端 spawn-helper 权限问题

---

## 文件变更

```
32 files changed, 3883 insertions(+), 3 deletions(-)
```

新增核心模块：
- `src/main/pet/` — 主进程（PetWindow / PetStateBridge / PetPatrol / PetPackageManager）
- `src/renderer/src/pet/` — 渲染层（PetOverlay / PetInteraction / PetSpriteSheet）
- `src/renderer/pet.html` — 独立入口（vite 多入口）

---

## 测试方式

```bash
git clone https://github.com/1900EasonJin/pi-desktop.git
cd pi-desktop
git checkout pr/pet-only
npm install
npm run make-icon
npm run dev
```

1. 设置 → 桌面宠物 → 启用
2. 动画预览下拉切换各动画行
3. 静观 idle 巡游；起 Agent 看 running→review→idle 链条
4. 双击宠物看蹦跳

---

> 📁 设计文档：`pet-feature/设计文档.html`、`pet-feature/巡游与互动设计计划.html`
