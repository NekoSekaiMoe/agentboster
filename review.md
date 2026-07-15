app/api/sessions/[id]/export/route.ts

移除未使用的 listLongTermMemories 导入。

Biome 的 noUnusedImports 已导致构建检查失败；删除该导入即可恢复构建。


app/api/sessions/[id]/export/route.ts
Comment on lines +18 to +19

认证用户限制会话导出权限。 这里仅按 sessionId 取会话，已登录用户知道他人 sessionId 时仍可能导出该会话的消息和摘要；改为按 authSession.userId 做所有权校验，或在管理员策略下显式放行。

app/api/sessions/[id]/export/route.ts
Comment on lines +56 to +60

统一为两个导出端点添加禁止缓存策略。

这些响应包含私有会话或配置数据；请在两个响应中添加 Cache-Control: private, no-store，必要时同时兼容 Pragma: no-cache。

app/api/sessions/[id]/export/route.ts#L56-L60: 为会话消息和摘要导出响应添加禁止缓存头。
app/api/config/export/route.ts#L22-L26: 为完整配置导出响应添加禁止缓存头。


docs/api.md

修正全局响应格式声明。

“所有响应均使用 JSON”与本文后续记录的 HTML 响应（Line 415）及文件/blob 下载端点（Lines 400、407）矛盾。建议改为“多数 API 响应使用 JSON；HTML 和文件下载端点除外”，避免调用方依据错误契约实现。


docs/report.md

拆开不同凭据的说明
这句把 Web/CLI 会话、agentd API key 和频道适配器密钥混写在一起，容易让人误以为都受 AUTH_SECRET 统一管理。建议分别写清各自的签名、轮转和吊销范围。


lib/core/db/memory/edges.ts
Comment on lines +8 to +30

在记忆图的写入和召回全链路强制租户隔离。

当前边本身不携带用户约束，派生和读取路径又允许丢失 userId，因此错误或空租户边可能导致跨用户记忆被召回。

lib/core/db/memory/edges.ts#L8-L30：建边前验证源、目标记忆属于同一用户。
lib/core/db/memory/edges.ts#L64-L124：边查询及内容查询接受并强制过滤 userId。
lib/memory/edges.ts#L104-L123：缺少用户身份时停止 related 边派生，不要执行全局查询。
lib/memory/recall.ts#L307-L345：将当前 userId 传入 BFS 的所有数据库读取。


lib/core/db/memory/edges.ts
Comment on lines +140 to +143

转义 key 前缀中的 SQL LIKE 通配符。

_ 和 % 会被当作通配符，例如 user_profile 可误匹配其他前缀。请转义后使用 LIKE，或改用精确的前缀比较。


lib/core/db/memory/edges.ts
Comment on lines +181 to +197

请在数据库中先按 memoryId 去重再应用 limit。

查询返回的是 chunk 行；同一记忆的多个 chunk 可以占满全部名额，并产生重复 memoryId。应按记忆聚合最大相似度，再排序和限制数量。


lib/core/db/schema/memory.ts
Comment on lines +153 to +170

请在数据库层约束 relation。 $type<MemoryEdgeRelation>() 只约束 TypeScript，数据库仍可写入任意文本；应使用 PostgreSQL enum 或 CHECK 约束，避免无效关系进入召回流程。


lib/core/db/schema/memory.ts
Comment on lines +159 to +184

补充 memory_edges 迁移
这里还没有对应的数据库迁移；部署后会缺少这张表以及级联外键、索引和唯一约束。请补上 memory_edges 的建表迁移。


lib/memory/compact.ts
Comment on lines +107 to +130

不要让超过 15 条的组永久跳过后续成员。

这里只处理最新的 15 条；若它们全部被 KEEP，较旧成员在之后每次执行中仍不会被处理，成功统计也未包含这些成员。请分批处理整个组或维护分页游标。

lib/memory/compact.ts
Comment on lines +180 to +204

执行前必须验证模型返回的全部 sourceIds。

Schema 只验证字符串形状，没有保证 ID 属于当前 input.members、全局唯一且恰好覆盖一次。非可信模型输出目前可以删除该用户当前组之外的记忆。


lib/memory/compact.ts
Comment on lines +206 to +247

避免 MERGE 删除刚写入的合并结果。

若 mergedKey 与某个源记忆相同，upsertLongTermMemory 会更新该源行，随后删除循环又将它删除。请检查返回的合并记忆 ID、拒绝组外 key 冲突、跳过目标 ID，并使合并写入与源删除具备原子性或补偿机制。


lib/memory/long-term.ts
Comment on lines +158 to +159

避免在边派生完成前重新填充旧召回缓存。

缓存先失效，但边派生仍在后台运行；期间的召回会基于旧图生成并缓存结果，派生完成后又不会再次失效。请等待派生后再失效，或在派生完成时执行第二次失效。

lib/memory/recall.ts
Comment on lines +34 to +40

缓存 key 必须包含所有影响召回结果的参数。

当前只包含用户和 query 哈希，忽略了 topK、minConfidence、召回策略及模型/重排配置。首次请求会错误污染同一 query 的后续不同调用。

lib/memory/recall.ts
Comment on lines +336 to +356

按实际来源种子和关系类型计算图扩展分数。

所有邻居都使用全局 maxSeedScore，导致弱种子的邻居获得最强种子的分数；同时 relation 被忽略，contradicts、方向性的 supersedes 也会作为权威记忆注入。上游应返回来源种子，并在此按关系过滤或加权。

lib/workflow/agent/context/index.ts
Comment on lines +143 to +144

不要按用户可控前缀丢弃历史消息。

modelMessages 仅来自会话记录，而摘要和召回记忆是在后续第 189-200 行才注入 prefix，因此这两个过滤条件不会排除内部消息；反而会让恰好以这些前缀开头的真实用户历史无法参与召回。删除这两项过滤即可。

lib/workflow/agent/context/index.ts
Comment on lines +152 to +153

避免把当前用户消息重复拼入召回查询
chatMain 先写入当前用户消息，再调用 buildInitialContextMessages，因此 modelMessages 里已经包含这条最新 user message；buildEnrichedRecallQuery 里再拼上 currentQuery 会让同一内容重复参与检索并改变缓存键。建议在收集历史时跳过最新一条用户消息，或直接排除当前消息。
