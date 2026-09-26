# Yarn 1 传递依赖安全覆盖(resolutions 语义实测)

- Status: implemented(10 条 advisory 全部修复,audit 9L/73M/27H → 3L/0M/0H)
- Date: 2026-10-08
- Scope: package.json `resolutions` + yarn.lock;不升级任何直接依赖的大版本

## 背景

npm advisory 打到的包几乎全是**被上游精确钉死**的传递依赖(yarn 1 无法单独 upgrade
传递依赖):

| 包 | 钉死来源 | 修复 |
|---|---|---|
| undici 7.28.0 | `@workflow/world-local/world-vercel` 精确 pin | 7.30.0 |
| undici 6.24.1 | `discord.js`/`@discordjs/rest` 精确 pin | 6.29.0 |
| nanoid 5.1.6 | `@workflow/core` 精确 pin | 5.1.16 |
| devalue 5.8.1 | `@workflow/core` 精确 pin | 5.9.2 |
| esbuild ~0.18.20 | drizzle-kit → `@esbuild-kit/*`(~0.18.20 已是该 major 顶格) | 0.25.12 |
| js-yaml 4.3.1 / postcss 8.5.18 | 本仓库自己的 resolutions 钉旧了 | 4.3.2 / 8.5.28 |

## 实测的 yarn 1 resolutions 语义(本次的关键产出)

1. **裸 key(`"postcss": "..."`)全局强制所有传递引用,但不作用于根的直接依赖**
   (根由 package.json spec 控制)。js-yaml 的 `^3.13.1` 消费者一直被强制到 4.x,属
   既有状态,保持不动。
2. **`@scope/pkg/child` 形式的 scoped 父段 pattern 静默不生效**(yarn 按 `/` 切段,
   scoped 包名被切碎)。`@vercel/blob/undici`、`@workflow/core/nanoid` 直接写 = no-op,
   yarn 不会报错。
3. **生效的两种形式**:
   - 从**未 scoped 的根依赖出发的完整路径链**:`workflow/@workflow/core/nanoid`、
     `drizzle-kit/@esbuild-kit/esm-loader/@esbuild-kit/core-utils/esbuild`(中间段可以
     是 scoped)。注意 world-* 包走的是 `workflow/@workflow/cli/...` 路径,不是
     `workflow/@workflow/core/...`——删掉 cli 路径会回退到 7.28.0,两条都保留。
   - **`**/pkg/child` 前缀**:`**/discord.js/undici`、`**/@discordjs/rest/undici`。
4. **手改 yarn.lock(把 `undici@6.24.1:` entry 的 version/resolved/integrity 换成
   6.29.0)会被 `yarn install` 归一化回原版本**——lockfile mapping 会被校验,别走这条路;
   只有 resolutions 背书的映射(esbuild@~0.18.20 → 0.25.12)能在 install 后存活。
5. **全局 `"nanoid": "5.x"` 是禁区**:nanoid 5 系 ESM-only,postcss(CJS)仍 require
   nanoid ^3.3.x,全局强制会炸 Tailwind/构建链。按子树钉(`workflow/@workflow/core/nanoid`)。

## 被否掉的备选

- **全局 undici 7.30**:discord.js 系刻意留在 6.x(gateway 长连接稳定性),强推 7.x
  有内存/连接回归风险——按子树分别钉 6.29.0 与 7.30.0。
- **升级 `workflow` 4.6→4.8.9 / `@chat-adapter/discord` 4.33→4.41**:均不能根治
  (world-* 到 4.7.4 仍精确钉 undici 7.28.0;core 4.8.9 仍钉 nanoid 5.1.6),却放大
  构建链/聊天适配器的变更面。留作后续常规升级。
- **升级 drizzle-kit**:0.31.11 仍依赖 `@esbuild-kit/esm-loader` → esbuild ~0.18.20,
  无济于事;用链式 resolution 直接覆盖。

## 验证

- `yarn audit`:nanoid/undici/js-yaml/postcss/devalue/esbuild 六个模块 0 advisory
  (顺带清掉了同批 undici 的另外 5 条);仅剩 3 条 low 的
  `@ai-sdk/provider-utils <4.0.33`(@workflow/ai 精确钉 4.0.30,本次未动,见下)。
- `yarn check:lint` 通过;`yarn test` 1720/1720(PGlite beforeAll 10s 超时是本机
  冷启动抖动,复跑全绿)。
- 冒烟:drizzle-kit 加载 drizzle.config.ts(esbuild 0.25.12 链路)正常;
  undici 6.29/7.30、nanoid 5.1.16、devalue 5.9.2 均可正常加载使用。

## 遗留

- `@ai-sdk/provider-utils` 4.0.30(GHSA-866g-f22w-33x8,low):由 `@workflow/ai` 内
  `@ai-sdk/anthropic|xai` 精确钉住。修复只需
  `"**/@ai-sdk/provider-utils": "4.0.37"`(树内已有 4.0.37 共存),但 AI SDK 家族对
  内部 utils 用精确钉 + 运行时核心路径,未在本次安全清单内,留给单独决策。
- Docker `yarn install --frozen-lockfile` 与本次改动兼容(spec key 未变,仅映射到
  patched 版本)。
