1. 提高 app lib 的测试覆盖率
2. 提高 subpackage(cli 除外)的测试覆盖率
3. 检查 :
如果要支撑上千人，必须对 Web 层进行重构：把同步的 SSE 长连接改为
  WebSocket + 基于队列的纯异步后台处理（Fire and
  Forget），避免云函数长时间挂起等待。

这意味着什么？
  这意味着整个 AgentBoster 的 Web
  中枢在面对高危命令审批（l2_auth）或者向用户提问（question）时，将整个平台的队列
  视作属于同一个“人类操作员”。

  如果作为多用户团队使用，会出现以下灾难级的体验：

  1. 用户 A 触发了一个高危命令（例如执行了一段不明 shell 脚本），AgentBoster
  弹出了 L2 审批请求（进入 sent 状态），等待用户 A 点击同意。
  2. 就在这时，用户 B 的 Agent 在执行任务时遇到了需要询问的问题（ask_question
  工具）。此时用户 B 的决议会被卡在 pending 状态。
  3. 用户 B 的前端界面不会弹出任何提示，他的 Agent
  会原地卡死。为什么？因为程序在等用户 A 处理完他的审批！
  4. 假设用户 A 刚好去喝咖啡了没有点，L2 的默认超时时间是 3 分钟（DEFAULT_TIMEOUT
  = 3 * 60 * 1000）。那么全公司所有其他正在运行的 Agent 任务只要触发了
  L2，全部都会被堵死在这 3 分钟里。


Update:
我之前得出“1人”或“极少数人”结论，是因为在 lib/security/l2-decision-queue.ts
  中发现的“跨任务全局串行”逻辑。但重新审视这段代码的意图后，我发现这完全是一个代
  码实现上的 Oversight（疏忽），而不是架构设计的本意。
  ### 1. 为什么说是代码 Bug 而非架构瓶颈？

  在 l2-queue.ts 的 canPromote 函数中，开发者为了“防止单个用户同时被多个 Agent
  任务的弹窗轰炸”，写了这样的逻辑：

        if (taskSentCount === 0) {
          for (const decision of this.decisions.values()) {
            // 发现只要有任何其他 task 正在处于 SENT（弹窗等待），就阻塞当前任务
            if (
              decision.status === DecisionStatus.SENT &&
              decision.taskId !== taskId
            ) {
              return false;
            }
          }
          return true;
        }

  疏忽在于：开发者在这里忘记了按 userId 或 sessionId 进行分组隔离！
  这导致原本应该**“每个用户自己的多个任务串行”的防骚扰机制，变成了“全站所有用户的
  任务全局串行”**。
  这是一个非常典型的从“单机/单用户原型”向“多租户
  SaaS”重构时遗漏的过滤条件。只需要加上一行 && decision.userId ===
  currentUserId，这个所谓的“全局锁”就会瞬间解除，各个团队成员的 L2
  授权将完全独立、互不干扰。

Update2:
### 1. Serverless 并发执行墙与长连接占坑（最大硬伤）
  在 api/ai/route.ts 中，工作流通过 createUIMessageStreamResponse 将 Agent
  的输出流式推给前端：

    return createUIMessageStreamResponse({
      stream: guardWorkflowChunks(result.result.readable), ...
    });

  这意味着：在整个 Agent 思考、甚至等待后端 agentd 执行耗时工具（如 npm install
  可能耗时数分钟）的过程中，Web 层的 HTTP 请求是一直挂起保持连接的。

  • 如果是 Vercel 部署：Vercel 的 Serverless Function（Node.js
  运行时）是有严格的并发执行上限的（Pro 计划一般是 1000
  并发执行）。如果有几百上千人同时触发 Agent 任务，会瞬间耗尽 Vercel
  的整个并发池，导致新的请求全部报 HTTP 429 (Too Many Requests) 或 503，连
  webhook 回调都会被阻塞。并且长时占用的 Serverless 实例会产生天文数字的账单。
  • 如果是私有化部署 (Node.js)：单个 Node.js
  进程如果维持上千个一直处于活跃运算和等待状态的 Agent 循环（尤其是大量使用了高
  CPU 消耗的 vm.Script 沙箱隔离和 Zod 校验），会极大概率引发 Event Loop
  阻塞或直接 OOM。
  ### 2. 进程内看门狗导致的数据库 DDoS（轮询风暴）

  架构文档中提到 L2 授权队列采用了这样的设计：

  │ “L2 是用户授权。决策队列是进程内热缓存加 Postgres l2_decisions
  │ 表持久化的双写设计。...超时看门狗每 5 秒扫描”

  这是一个典型的单体应用设计，一旦放到 Serverless 环境下会产生灾难性后果：
  如果有 500 个并发用户导致 Vercel 弹出了 500
  个独立的云函数实例，那么每一个实例都会启动自己的“5秒看门狗”去轮询数据库。这意味
  着单单是为了检查 L2 授权状态，数据库就会承受每秒 100 次（500次 /
  5秒）的无效查询。这会迅速耗尽 Neon 数据库的 API 配额或算力单元。

  ### 3. Vm.Script 沙箱编译的 CPU 开销

  根据 docs/architecture.md 的描述，Workflow DevKit 在主机执行时：

  │ “Workflow DevKit 把 workflow 函数体编译成 vm.Script 在隔离沙箱运行”

  对于每次 Agent 执行步骤，它都在使用 Node.js 的 vm
  模块创建隔离上下文。vm.createContext 和执行是有不小的 CPU
  和内存开销的。如果有上千个并发会话持续进行这种沙箱重构和状态再入，单台服务器的
  CPU 将无法承受。
  ──────

Update3:

### 1. 如果部署在 Vercel (Serverless) 上：确实“很不适合”
  在 Vercel 这样的 Serverless 环境中，云函数是按执行时间计费且有严格并发墙的（Pro
  版并发上限 1000）。
  AgentBoster 的流式输出（SSE）在等待 agentd 执行工具（比如 npm install
  等待两分钟）时，Vercel 的云函数会一直保持在“运行中”状态。

  •
  成本灾难：如果一个千人团队每天高频使用，大量的云函数被挂起几分钟只为了等结果，
  这会产生极其离谱的 GB-second 账单（为无意义的等待付钱）。
  • 并发墙风险：虽然 1000 人的团队同一秒并发按键的人可能只有 50-100 人（远没到
  1000
  的上限），但遇到突发高峰（比如全公司开会同时查数据），依然有几率瞬间击穿并发池
  。
  结论：在 Vercel
  部署下，这种“长连接流式响应”的设计用来支撑大团队是极度不经济且存在隐患的。

  ### 2. 如果是私有化部署 (Docker/Node.js)：极其适合，毫无压力
  这是我上一次分析时发生思维反转的根本原因。我之前短暂地用传统多线程服务器（比如
  Java Tomcat，一个连接占一个线程）的思维去代入了 Node.js。
  但实际上，AgentBoster 的根基是 Node.js。

  • Node.js 是天生处理长连接的王者：Node.js 基于单线程事件循环（Event
  Loop）和非阻塞 I/O。对于 Node.js 来说，维持 1000 个甚至 10,000
  个处于“等待数据（挂起）”状态的 HTTP 流式连接，几乎不消耗
  CPU，仅仅只占用极其微小的内存（文件描述符）。
  • 无数据库连接池负担：传统 Node.js
  应用在挂起几千个请求时，通常会死在数据库连接池耗尽上（几十上百个 TCP
  长连接被占满）。但 AgentBoster 代码中极度聪明地使用了 @neondatabase/serverless
  的 HTTP Driver (fetch)。挂起连接时，它并不霸占任何数据库 TCP 连接。
  结论：如果你们使用项目里的 docker-compose.yml
  私有化部署在自己的服务器上，单台普通服务器的 Node.js
  进程轻轻松松就能挂起上万个流式请求。此时，流式输出不仅不是瓶颈，反而是提供极低
  延迟前端体验的最佳方案。

Update4:
### Bug 1：全局锁定（多租户变成单机体验）

  这是我上文提到的那个逻辑 Bug。在 canPromote 方法中，用来决定一个授权请求能否从
  pending（后台排队）变成 sent（展示给用户）的代码如下：

    // lib/security/l2-decision-queue.ts - canPromote 方法
    if (taskSentCount === 0) {
      for (const decision of this.decisions.values()) {
        // 致命点：遍历整个实例中【所有】的决定
        if (
          decision.status === DecisionStatus.SENT &&
          decision.taskId !== taskId
        ) {
          return false; // 只要有任何其他人的任务卡在 SENT，我这里就阻塞
        }
      }
      return true;
    }

  •
  病因：这段代码原本的意图是“防止同一个用户同时弹出多个审批框”，但开发者忘了加上
  decision.sessionId === sessionId 这样的隔离条件。
  • 发作症状：导致全平台、全公司所有用户，在同一时刻只能有一个人看到 L2
  审批弹窗。如果张三触发了高危命令（弹窗等待3分钟），李四哪怕只是在一个完全无关的
  项目里触发了一个简单的提问，李四也会被静默卡死，直到张三处理完毕或者超时。
  ### Bug 2：“幽灵决议”（Serverless 状态脱节与永久卡死）
  在同一个文件的头部注释中，开发者自豪地写道：
  │ P0.2: Previously this queue was a process-local in-memory Map... The queue
  now
  │ mirrors every state change into the l2_decisions Postgres table and
  rehydrates
  │ from it on startup. (现在每次状态改变都会同步到数据库，并在启动时恢复)。
  但实际上，开发者在核心的状态流转函数 promote 中忘记写数据库更新了！

    // lib/security/l2-decision-queue.ts
    private promote(decisionId: string) {
      const decision = this.decisions.get(decisionId);
      if (decision) {
        decision.status = DecisionStatus.SENT;
        // 致命漏洞：这里只修改了内存字典！完全没有 await db.update(...)！
      }
    }

  结合 Serverless (Vercel) 环境，这会引发一场绝对的灾难：
  1. 产生决议：实例 A 处理了 agentd 的请求，调用
  enqueue()。代码先往数据库插入了一条 status: PENDING 的记录，随后在实例 A
  的内存里将其 promote() 成了 SENT。
  2. 状态脱节：此时数据库里依然是 PENDING，但实例 A 认为是 SENT。
  3. UI 获取失败：用户的前端页面每隔几秒去轮询后端请求授权列表，Vercel 唤醒了实例
  B 来处理这个请求。实例 B 从数据库拉取状态（rehydrateFromDb），拿到了 PENDING。
  4. 永久卡死：因为只有 SENT
  状态才会返回给前端（getSent()），所以前端永远看不到弹窗。更离谱的是，定时清理超
  时的看门狗代码 checkTimeouts() 同样只检查 SENT 状态的超时。
  5. 最终结果：这个处于 PENDING
  的决议就像幽灵一样，前端看不见，看门狗也不管，导致发起这个决议的工作流永久挂起
  、无限期卡死。
  ### 总结
  这就是为什么这个系统在本地开发环境（单 Node.js
  进程，内存共享，没有脱节问题，且只有自己一个人用）下跑得无比顺畅，但一旦推上云
  端（Serverless + 团队协作）就会变得极其诡异和难用。
  修复建议非常简单：
  1. 在 canPromote 里的 for 循环加上 decision.sessionId ===
  currentSessionId，解除全局锁。
  2. 在 promote() 和 advanceQueue() 函数中补充上缺失的数据库 update
  语句（并且需要保证异步更新），让内存状态与 Postgres 真正同步。
