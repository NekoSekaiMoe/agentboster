# ClawLess

## 项目概述

**ClawLess** 是一个基于 Next.js 的 AI 驱动的多功能聊天应用平台。

该项目整合了多个 AI 提供商、多平台聊天 Bot 适配器、可持久化的会话管理和工作流调度功能。它有一个无状态化的沙箱环境，支持 AI 代理的执行、内存管理、Bot 适配、工作流调度和多模态对话。项目采用现代前端技术栈与完整的后端支持，能够支持跨多个聊天平台（Slack、Teams、Google Chat、Telegram）的 Bot 部署。

---

## 技术栈

### 前端框架与库
- **Next.js 15.5.9** - React meta framework，支持 RSC（React Server Components）、路由、API 路由
- **React 19.0.0** - UI 库
- **TypeScript 5.9.3** - 类型安全的编程语言
- **Tailwind CSS 3.4.19** - Utility-first CSS 框架
- **shadcn/ui** - 基于 Radix UI 和 Tailwind CSS 的组件库
- **@radix-ui/** - 原生 UI 组件集合（对话框、下拉菜单、选择器等）
- **Framer Motion 11.3.19** - React 动画库
- **react-markdown 9.0.1** - Markdown 渲染
- **remark-gfm 4.0.1** - GitHub Flavored Markdown 支持

### AI 与 LLM
- **AI SDK 6.0.116** (`ai` npm package) - Vercel AI SDK，统一的 AI 模型接口
  - `@ai-sdk/anthropic` - Anthropic Claude 集成
  - `@ai-sdk/google` - Google Generative AI 集成
  - `@ai-sdk/openai` - OpenAI GPT 集成
  - `@ai-sdk/openai-compatible` - OpenAI 兼容 API
  - `@ai-sdk/react` - React hooks（`useChat`、`useCompletion`）
  - `@ai-sdk/mcp` - Model Context Protocol 支持
- **@ai-sdk/devtools** - AI SDK 调试工具

### Chat & Bot 框架
- **Chat SDK** (`chat` npm package) - 多平台聊天 Bot SDK
  - `@chat-adapter/slack` - Slack Bot 适配器
  - `@chat-adapter/teams` - Microsoft Teams Bot 适配器
  - `@chat-adapter/gchat` - Google Chat Bot 适配器
  - `@chat-adapter/telegram` - Telegram Bot 适配器
  - `@chat-adapter/state-redis` - Redis 状态管理
- **支持的能力**：消息处理、@提及、反应、斜杠命令、交互卡片、模态窗口、流式响应

### 数据库与存储
- **Drizzle ORM 0.45.1** - TypeScript 类型安全的 ORM
  - `drizzle-kit` - Drizzle 迁移和开发工具
- **@neondatabase/serverless** - Neon 无服务数据库驱动
- **@upstash/redis** - Upstash Redis 客户端
- **@vercel/blob 2.3.1** - Vercel Blob 存储

### 工作流与后端
- **Workflow SDK** - Vercel Workflow DevKit（4.2.0-beta.67）
  - `@workflow/ai` - Workflow 内 AI 支持
  - 支持可恢复、持久化的工作流执行
- **@vercel/sandbox 1.8.1** - 代码执行沙箱环境
- **ofetch 1.5.1** - 现代 HTTP 客户端

### 开发工具
- **Biome 1.9.4** - 一体化 linter + formatter
- **PostCSS 8.5.8** - CSS 转换工具
- **Vercel CLI 50.33.0** - Vercel 部署工具
- **Bun** - 包管理器与运行时（从脚本中的 `bunx` 推断）

### 其他依赖
- **zod 4.3.6** - TypeScript 运行时数据验证
- **date-fns 4.1.0** - 日期操作库
- **lucide-react 0.446.0** - React 图标库
- **sonner 1.7.4** - Toast 通知库
- **next-themes 0.4.6** - Dark mode 主题管理
- **isomorphic-git 1.37.4** - Git 操作库
- **class-variance-authority 0.7.0** - 组件样式变体管理
- **clsx 2.1.1** - 条件类名处理
- **fast-deep-equal 3.1.3** - 深层相等比较
- **usehooks-ts 3.1.1** - TypeScript React Hooks 集合

---

## 包管理器与环境

### 包管理器
- **Bun** - 高性能 JavaScript 运行时与包管理器
  - 使用 `bun.lockb` 作为锁定文件
  - 支持 TypeScript 原生执行

### 配置文件
- `tsconfig.json` - TypeScript 编译器配置
- `biome.jsonc` - Biome linter 和 formatter 配置
- `next.config.ts` - Next.js 配置
- `tailwind.config.ts` - Tailwind CSS 配置
- `drizzle.config.ts` - Drizzle ORM 配置
- `middleware.ts` - Next.js 中间件
- `postcss.config.mjs` - PostCSS 配置
- `components.json` - shadcn/ui 组件配置
- `skills-lock.json` - 技能版本锁定文件

---

## 文件结构约定

```
app/                     # Next.js App Router
├── (auth)/              # 认证相关路由
├── (chat)/              # 聊天相关路由
├── (config)/            # 配置相关路由
├── (memory)/            # 内存管理路由
├── (skill)/             # 技能管理路由
└── layout.tsx           # 根布局

components/              # React 可复用组件
├── ui/                  # shadcn/ui 原始组件
├── auth/                # 认证组件
├── config/              # 配置界面组件
└── *.tsx                # 其他功能组件

lib/                     # 工具函数与核心逻辑
├── ai/                  # AI SDK 封装
├── auth/                # 认证逻辑
├── blob/                # Blob 存储
├── bot/                 # Bot 适配器
├── chat/                # 聊天逻辑
├── db/                  # 数据库操作
├── kv/                  # Redis 缓存
├── sandbox/             # 沙箱执行
├── workflow/            # 工作流调度
└── utils/               # 通用工具函数

types/                   # TypeScript 类型定义
├── config/              # 配置相关类型
├── skills/              # 技能相关类型
└── *.ts                 # 其他类型

public/                  # 静态资源
└── fonts/, images/
```

---

## 代码风格

### 导入顺序与命名

```typescript
// 1. 外部库
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { ofetch } from 'ofetch';

// 2. 内部组件与工具
import { ChatHeader } from '@/components/chat-header';
import { deriveSessionTitle } from '@/lib/chat/session-title';
import { type WorkflowDataPart } from '@/types/workflow';

// 3. 本地导入
import { Messages } from './messages';
```

## 执行流程与命令

### 本地开发流程

1. **安装依赖**
   ```bash
   bun install
   ```

2. **数据库迁移**
   ```bash
   bun run db:generate  # 生成迁移
   bun run db:push     # 推送到数据库
   ```

3. **启动开发服务器**
   ```bash
   bun run dev
   # 访问 http://localhost:3000
   ```

4. **代码检查与格式化**
   ```bash
   bun run check        # 完整检查
   ```

### 生产部署

```bash
bun run build        # 构建生产版本
bun run deploy       # 部署到 Vercel
```

---

## 重要约定与注意事项

### 1. 文件命名
- **组件文件**：PascalCase（例：`ChatHeader.tsx`）
- **工具函数**：camelCase（例：`formatDate.ts`）
- **类型文件**：PascalCase（例：`ChatMessage.ts`）

### 2. 导出方式
- **命名导出**：适用于工具函数、类型、多个组件
- **默认导出**：适用于单一的 Page 组件或 Layout 组件

### 3. React Server Component (RSC) vs Client Component
- 使用 `'use client'` 指令明确标识客户端组件
- 在 `app/` 目录中，默认为服务器组件

### 4. API 路由
- 放在 `app/api/` 目录中
- 使用 TypeScript 和类型安全的请求/响应处理

### 5. 环境变量
- 使用 `.env.local` 或 `.env` 文件（`.gitignore` 中排除）
- 公开环境变量前缀为 `NEXT_PUBLIC_`

### 6. 错误处理
- 使用 try-catch 处理异步操作
- 返回有意义的错误信息
- 使用 zod 进行运行时数据验证

### 7. 日志
- 在生产环境中使用日志库（如 `lib/utils/logger.ts`）

### 8. Fetch
- 使用 `ofetch` 进行 HTTP 请求
- 处理错误和超时

### 9. 类型安全
- 使用 TypeScript 定义所有函数、组件和数据结构的类型
- 使用 zod 进行运行时数据验证
- 尽量不要创建新的类型，而是使用现有的类型定义
- 避免使用 `any`, `unknown` 类型，避免 `as` 强制类型转换，除非绝对必要

### 10. 代码注释
- 复杂逻辑或不直观的代码块应添加注释
- 使用 JSDoc 注释函数和组件的参数和返回值

---

## 相关文档与资源

请参考以下文档以获取更多信息，或者使用 Context7 MCP 工具，获取新的文档。

- [Next.js 官方文档](https://nextjs.org/docs)
- [AI SDK 文档](https://sdk.vercel.ai)
- [Vercel Workflow 文档](https://vercel.com/docs/workflow)
- [Biome 文档](https://biomejs.dev)
- [Drizzle ORM 文档](https://orm.drizzle.team)
- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [Chat SDK 文档](https://www.chat.dev)

