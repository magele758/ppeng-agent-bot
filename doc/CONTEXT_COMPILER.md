# 每轮动态组上下文（Context Compiler）

> 2026-10-28 源码核对：当前已有 `packages/core/src/session/context-compiler.ts`，调用 SDK 编包并接入按 query 的渐进召回、身份隔离、诊断及预览。下文“尚无编包器”等表述是 2026-09-02 的设计基线，不能作为当前缺口。跨所有历史/知识来源的统一预算与召回质量仍需按实际场景评估。


| 字段 | 值 |
|------|----|
| 状态 | 已有运行时实现；下文保留原设计，剩余范围以单机收尾记录为准 |
| 日期 | 2026-09-02 |
| 相关 | [harness/04-context-economics.md](harness/04-context-economics.md)、[harness/17-context-memory-compaction.md](harness/17-context-memory-compaction.md)、[PROMPT_CACHE.md](PROMPT_CACHE.md)、[MEMORY_MULTIUSER.md](MEMORY_MULTIUSER.md)、[harness/08-memory-and-evolving.md](harness/08-memory-and-evolving.md) |

本文整理「不要把多轮历史一股脑塞回窗口，而按本轮 query 精炼起始上下文」的调研：自提方法、业界论文、Codex TokenBudget 源码对照，以及对本仓库的落点。**先读结论，细节在后。**

---

## 1. 确定结论

### 1.1 目标怎么定义

目标不是「无限上下文」，而是：**每轮用固定预算编译一份精炼起始包**。全量回放既贵又差——长窗口中间段容易丢信息（Lost in the Middle）；抽取+检索相对全量历史可省 90%+ token，质量往往更好（Mem0 / LoCoMo）。

### 1.2 选哪条路

| 问题 | 结论 |
|------|------|
| 谁更激进 | **Codex 硬切更激进**：窗口一满就清空对话，不写摘要，赌模型去翻 notes/history。 |
| 谁更好 | **主机编包更好**，尤其是多来源、多轮、多知识。Codex 硬切适合「仓库才是真相」的长编码任务，不适合当默认对话模式。 |
| 要不要照抄 Codex | **不要当默认路径。** 可借其「外存可回查 + 预算将尽时允许硬切」作逃生口。 |
| 上下文归谁管 | **编包权留在 session/turn 的 `prepareTurnInput` 缝。** 不要并进 Memory 模块。Memory、归档、知识、case 都是**源**，不是引擎。 |
| Codex 是不是已经交给 Memory、不用 session 了 | **不是。** Session 仍改活窗口；Memories 是跨会话长期记忆；history-notes 是切窗后的回查层。三套分开。 |
| 工具结构能不能丢 | **结果正文可以丢，调用结构不能无痕丢。** 留下工具名、关键参数、成败、归档指针；需要全文再搜或再跑。不要假设「模型会记得自己调过然后去搜」。 |
| 「调过工具就是线索」本质是什么 | **索引记忆 + 模式补全，不是磁带回放。** 窗口只留线索（调用过什么、指向哪）；正文在世界/归档里。当前模型没有上一轮的「已经想过」，能找回的是证据和产物，不是旧心智。 |
| 本仓库现状够不够 | **不够。** 已有「先有整段历史再压」（micro-compact / episodic / autoCompact）和五层 memory。缺的是**按本轮 query 编译起始包**。episodic 不看 query；memory appendix 是固定灌 scratch/long。 |

### 1.3 推荐架构（默认路径 + 逃生口）

```
本轮送给模型的上下文 =
    身份 / 权限（硬过滤，先于打分）
  + shortcut（最近 K 轮 + 当前 goal / todo）
  + 检索槽（记忆 ∪ 历史片段 ∪ 知识 ∪ case，统一打分后截断）
  + 工具存根（旧 tool_result 压成指针，不删配对）
  + 可选翻页工具（模型仍不够再搜归档）

预算将尽 → 允许 new_context 式硬切（逃生口，不是默认）
```

打分先做成应用层，不必碰模型 attention：

`score = w_rel·相关 + w_rec·近因衰减 + w_imp·重要/访问 + w_acl·权限`

可变召回挂**最近 user appendix**，禁止进 system 前缀（保 prompt cache）。

### 1.4 明确不做

- 复刻模型内部 attention（StreamingLLM / Infini-attention）：API 模型用不上。
- 每轮用 LLM 重写全部历史。
- 把检索结果塞进 system 前缀。
- 默认硬切窗口、只靠字面搜索找回。
- 把「每轮上下文怎么长」并进 Memory 模块。

---

## 2. 问题

以往多轮都是把历史统一塞进会话上下文。多数旧轮次与新 query 无关；外部知识源又多。起始 token 很快被吃满，新对话一上来就贵、还容易在窗口中段丢掉真正有用的信息。

本仓库今天仍是这条路的改良版：**落库 transcript 全量保留，送给模型的视图再压**（`prepareTurnInput`：autoCompact → fold → episodic → micro-compact → memory / working-log appendix）。压的是「整段历史怎么瘦」，不是「这一轮该带什么」。

---

## 3. 最初五条方法：能不能单独满足目标

单独任何一条都不行；**合在一起作为编包槽位才够**。

| # | 方法 | 判定 | 说明 |
|---|------|------|------|
| 1 | 记忆 + 多知识召回 | 必要，但不是对话线程 | 适合偏好、事实、文档。Mem0 是「抽取再检索」，不是回放原文。只靠它会丢「刚才那句」和未抽取细节。 |
| 2 | 按 query 召回限定长度历史 | **新模式的核心缺口** | 本仓 episodic 是规则选关键帧（首条 + 最近一段 + episode 代表），**不按 query**。缺了这一层，历史仍在线性膨胀。风险：检索错、漏、或一次塞太多又掉进 lost-in-the-middle。 |
| 3 | 身份 / 权限注入 | 硬过滤，不是相关性 | 先 ACL 再打分。本仓已有五层 scope（`user/team/project/session`），还没做成「每轮按身份编包」。 |
| 4 | Attention 式召回 | 要拆两层 | **模型内部**（StreamingLLM / Infini-attention）改 KV，API 模型用不上。**应用层** `相关 × 近因 × 重要 × 权限` 才该做。 |
| 5 | shortcut + 时间衰减 | **默认配方的骨架** | 最近 K 轮钉死 + 历史联想召回。MemoryBank 用 \(R=e^{-t/S}\)，召回一次加强。没有 shortcut，「把刚才那个改一下」会失忆。 |

---

## 4. 当初没点到、但必须写进方案的做法

1. **每轮 Context Compiler（预算分槽）** — 这是模式本身，不是又一个召回器。身份/策略 + 工作态 + 按 query 召回 + 工具可再取。预算写死（例如 20% / 30% / 40% / 10%）。
2. **写路径抽取，读路径检索（Mem0）** — 对话先变成可更新事实（ADD/UPDATE/DELETE），再检索。比反复塞原文更省、更好维护时效。
3. **时序知识图（Zep / Graphiti）** — 事实带有效期。适合「上周用 A，昨天改成 B」。纯向量容易召回过期近邻。
4. **Agent 翻页（MemGPT / Letta，Codex 同族）** — 核心块钉在窗口，档案靠工具再取。历史永不丢，只是不在窗口里。本仓已有 `spill_tool_result`、transcript 归档、working-log，差的是「按 query 搜归档」的工具。
5. **JIT / 外置再读** — 大结果只留指针，模型用 `grep` / `read` / `memory_get` 按需拉。编码 Agent 主流做法。
6. **子 Agent 隔离** — 脏探索在子窗口，只回摘要。本仓已有 `spawn_subagent`。
7. **混合检索 + RRF + rerank** — 词法 + 向量融合，再 cross-encoder 压到 top-k。本仓 `case-recall.ts` 已对 case 做 FTS+embedding+RRF，**还没用到会话 transcript**。Anthropic Contextual Retrieval 再加「块前补文档语境」可降检索失败。
8. **按意图换配方** — 续做任务加重 shortcut；查旧事实走记忆/图谱；闲聊更短。一种召回打天下会偏。
9. **离线整理（dreamer / consolidator）** — 会话后合并矛盾、升格长期记忆。本仓 BackgroundReviewer + `agent_cases` 已是雏形。
10. **证据位置** — 关键证据放头尾，中间少堆。召回 30 段往往不如 5 段 + rerank。
11. **A-MEM / HippoRAG / MemoryOS** — 笔记互联、概念图 PageRank、STM/WM/LTM。借鉴结构即可，不必先上整套。

---

## 5. 本仓库已经有什么、缺什么

`prepareTurnInput`（`packages/core/src/turn/prepare-turn-input.ts`）顺序：autoCompact → claim inbox → fold → prepareView（图像 / 拒答 / micro-compact）→ memory / working-log appendix。`ModelAdapter.runTurn` 只吃这里出来的 `messages`。

| 已有 | 落点 | 还缺 |
|------|------|------|
| 微压缩：旧 `tool_result` 折成占位，只改视图 | `session/micro-compact.ts` | 按 query 决定留哪几条（现在是「最近 N 条」） |
| Episodic：首条 + 最近 + episode 关键帧 | `model/episodic-selection.ts`（EpiCache 思路） | **不看本轮 query** |
| autoCompact：过阈值 LLM 摘要 + 归档 | `session/auto-compact.ts` | 有损；模型不知道丢了什么 |
| 预算按模型窗口推导 | `session/session-budget.ts` | 没有「编包分槽」 |
| Memory appendix（scratch/long 固定灌） | `prompt-builder.ts` | 不是按 query 召回五层 memory |
| 五层 store + FTS | `memory/store.ts` | 读路径未进每轮编译 |
| Case 混合召回 | `evolving/case-recall.ts` | 未用于会话 transcript |
| working-log 尾部 user 侧注入 | `session/working-log.ts` | 仍是尾部切片，不是检索 |
| prompt cache：stable + dynamic，memory 不进 system | `doc/PROMPT_CACHE.md` | 新召回必须继续走 user appendix |

一句话：已有 **压 / 钉 / 存**，缺 **按本轮 query 编译**。

---

## 6. Codex 做了什么（对照源码，不是标题）

来源：[微信文](https://mp.weixin.qq.com/s/HS5FAXgaBmB-pkKD_PUztQ)（2026-09-01）+ `openai/codex` 已合入 PR。标题「取消压缩」不准确：**默认 compact 还在**；TokenBudget 打开后，摘要压缩换成硬切 + 回查。

时间线：

| PR | 日期 | 做什么 |
|----|------|--------|
| [#27438](https://github.com/openai/codex/pull/27438) | 2026-06-11 | 模型看见剩余窗口（25/50/75% 才插提醒） |
| [#27488](https://github.com/openai/codex/issues/27488) | 2026-06-11 | `new_context`：无参、不写摘要，只打「换窗」标记 |
| [#29743](https://github.com/openai/codex/pull/29743) | 2026-06-23 | TokenBudget 下 `/compact` / 自动 compact **行为变成换窗**，生命周期事件仍叫 compaction |
| [#39827](https://github.com/openai/codex/pull/39827) | 2026-08-21 | `history.*` + `notes.*` 回查工具 |

`new_context` 返回固定句 *“A new context window will start without summarizing conversation history.”*，然后 `start_new_context_window` 把活历史换成 initial context + world state（可选保留少量 client developer 消息）。

history / notes（`codex-rs/ext/history-notes`）：

| 命名空间 | 动作 | 实质 |
|----------|------|------|
| `history` | `list_windows` / `list_items` / `read_item` / `search_contents` | 按 window/item ID 翻旧窗；搜索是**大小写敏感字面子串** |
| `notes` | `list/read/search/append/write` | 虚拟笔记，单文件 ≤ 1MB；搜索同样字面匹配 |

另有 `notes.thread_hint`：开新窗最多注入 **4KB**。工具走 Codex 后端 `alpha/history/v2/*`、`alpha/notes/v2/*`，输出可加密、会截断，`DirectModelOnly`。开关：`features.token_budget` + `use_history_notes_extension`，且要 OpenAI + Codex 后端鉴权。

### 6.1 按模块：不是「全交给 Memory」

| 模块 | 管什么 | 还改不改活上下文 |
|------|--------|------------------|
| Session / `ContextManager` | 当前窗口、turn、token 账、world state、`replace_compacted` / `start_new_context_window` | **改。** 硬切就是 session 换 history |
| Memories（`codex-rs/memories` + `ext/memories`） | 跨会话长期记忆：启动时从旧 rollout 抽取 → 盘上 `MEMORY.md`；工具 `list/read/search/ad_hoc_note` | **几乎不改窗口。** 只注入「怎么用 memory」的说明 |
| history-notes | 切窗后的本会话档案 + 虚拟 notes | **不改窗口。** 模型用工具拉 |

Memories README 写明：只在根 session 启动、非 ephemeral、非 sub-agent 时后台跑 Phase1/Phase2。那是「上次任务沉淀成笔记」，不是每轮组包。

### 6.2 和「主机编包」的差别

| | 主机编包（本方案） | Codex TokenBudget |
|---|---|---|
| 不塞全量历史 | 是 | 是（硬切） |
| 外存可回查 | 是 | 是（history + notes） |
| 谁决定带什么 | **主机**按 query / 身份 / 衰减编包 | **模型**自己决定切窗、写笔记、搜什么 |
| 检索 | 语义 + 词法 + 打分 | 字面子串，无 embedding |
| 起始上下文 | 每轮动态编译 | 几乎空窗 + ≤4KB hint |
| 失败形态 | 编包偏了 | 该查没查 / 笔记写错还被捞回来 |

目标像（精炼、外存），控制权不像。Codex 更近 MemGPT「窗口当 RAM、档案当磁盘」；不是主机侧 Attention 组包。

### 6.3 Codex 有没有「历史工具清理」

分两种：

1. **切窗后用 history 回查** — 做了，但是模型自己翻，不是主机清理。`list_items` 可按 `tool_namespace` / `tool_name` 滤旧工具结果。
2. **窗口内把旧 tool_result 收掉（本仓 micro-compact）** — **没有对等物。** 只有更粗的两刀：写入时 `truncate_function_output_payload`；换窗/压缩时整段丢掉。经典 compact 只留 user + 摘要，工具结果全扔（[openai/codex#14589](https://github.com/openai/codex/issues/14589)）。TokenBudget 连对话一起扔。

他们没有：按新 query 挑选历史、注意力打分、时间衰减编包、只清工具保留对话线程。

---

## 7. 工具结构能不能丢

**不完全能。** 能丢的是工具**结果正文**，不能无痕丢掉「调过什么、参数、成没成、去哪找」。

硬切之后新窗口往往只剩初始上下文 + ≤4KB hint。旧 `tool_call` / `tool_result` 都不在眼前。模型**不会自动记得**自己调过 `bash` 或读过哪个文件，除非留下面包屑，或它主动 `history.list_items` / `search_contents`。字面搜不知道关键词就搜不着。Codex 自己也报过：丢掉工具输出后模型会重跑或以为数据没了（[#14589](https://github.com/openai/codex/issues/14589)、[#37121](https://github.com/openai/codex/issues/37121)）。

| 留下（便宜） | 可以丢（贵） |
|--------------|--------------|
| 工具名、关键参数、成功/失败 | bash 全文、读文件原文、大 JSON |
| 归档指针 / item_id / 文件路径 | 中间过程日志 |
| 「已试过、不要再试」 | 已写入磁盘、可再读的内容 |

本仓 micro-compact 已是这个方向：配对还在，旧输出收成 `[previous: used bash — output dropped from context] msg=<id> part=<n>`。搜是逃生口；**存根才是默认该留的**。需要全文再用 `retrieve_tool_result` / `GET /api/sessions/:id/tool-results/:messageId` / `read_file` / 再跑命令。记得 / 读回 / 死循环三条现网结论见 [TOOL_RESULT_STUB_PLAN.md](TOOL_RESULT_STUB_PLAN.md) §4。

### 7.1 这个直觉的本质：索引记忆，不是「模型还记得」

你的感觉对了一半：**工具调用过，就是一条线索**；正文不必一直待在工作记忆里，需要时再按线索把资料补回来。

错的一半是：以为「当时的模型已经处理好了，所以现在的模型自然知道」。LLM 每轮是新的前向计算，上一轮的权重激活不在了。能留下来的只有三样东西——**线索、产物、可再取的源**。没有线索，就没有「知道自己调过」。

这不是新发明，是同一套思维模型在三个学科里的名字：

| 学科 | 名字 | 对应到 Agent |
|------|------|----------------|
| 认知 / 神经 | 海马索引 + 模式补全（Teyler & DiScenna；HippoRAG 借用） | 海马不存整段经历，只存指向新皮层痕迹的索引；部分线索就能把整段补出来。工具存根 = 索引；归档/文件 = 痕迹。 |
| 认知 | 重构记忆（Bartlett），不是复制记忆 | 人回忆不是放磁带，是按图式把事件再拼出来。Agent 也不该回放整段 tool 日志，而该用线索重建「当时做了什么」。 |
| 哲学 | 延展心灵（Clark & Chalmers，Otto 的笔记本） | 信念可以住在环境里，只要稳定、可取、取了就信。仓库、URL、归档就是笔记本；窗口只是当下在想的那一页。 |
| 系统 | 虚存页表 / 事件溯源 / 血统（provenance） | 页表项 ≠ 页内容；事件日志可重放状态；记住「对哪个源做过什么」就能再物化。 |

拆开看，你的那句话其实叠了三层，必须分开，否则会设计错：

```
1. 索引 ≠ 载荷     调用记录是页表项；stdout / 文件原文是页。
2. 世界即外存      编码任务里，「处理好了」往往已经写进磁盘 / git / 测试。
3. 可再计算        源还在（路径、URL、命令）就可以再取或再跑；那是配方，不是答案缓存。
```

「当时已经处理好了」只对 **2 和 3** 成立：工作被结算进了世界，或源还能再读。它对 **当前模型的内部理解** 不成立——那份理解已经随上一轮 KV 一起没了。新模型读到的是证据，会重新推理，不是接着旧思路往下走。

所以这条思维模型的操作定义是：

> **工作记忆只保存能触发补全的线索；完整经历放在可寻址外存；当前轮用线索去完成，而不是回放。**

设计上因此有三条硬约束（和 §1.2「工具结构不能无痕丢」是同一句话）：

1. **线索必须还在当前窗口或能被本轮 query 打中。** 硬切后既无存根、笔记也没写，模型没有线索，就不会去搜——这是 Codex 硬切的主失败态。
2. **线索要指向稳定地址。** `item_id`、文件路径、URL、命令指纹。只写「用过 bash」不够完成。
3. **不可再取的东西不能只留线索。** 一次性 API 响应、已删的临时输出、纯推理过程：要么抽成事实写进 memory，要么当时就留下结论，不能赌「以后再搜」。

ReadAgent 的 gist + lookup、MemGPT 的 RAM/磁盘分页、本仓 micro-compact 的占位行，都是这套模型的工程外形。差别只在线索谁写、谁查、查不准怎么办——这正是主机编包要管的事。

---

## 8. 哪个更激进、哪个更好

Codex 激进在**扔**：切完最省 token，连续性弱。失败是突然失忆。对编码 Agent 说得通——文件、git、测试能补。

主机编包激进在**管**：每轮主机决定带什么。窗口不必砍光，最近几轮钉死。失败是检索偏了，但「刚才那个」不断。更贴多知识长对话。

论文更站编包：压缩会掉约束（Compaction Cliff）；检索方法在 LoCoMo 上可差 20 分，写策略只差 3–8 分，**原文分块 + 好检索 ≥ 昂贵有损摘要**（Retrieval vs Utilization）。Codex 这套也还没默认开。

落地不是二选一：session 仍持窗口；每轮主机编包；预算将尽再允许硬切，并给模型翻归档的工具。

---

## 9. 和论文的对应（只列影响结论的）

**模型翻页（Codex 同族）**

- [MemGPT](https://arxiv.org/abs/2310.08560)（Packer et al., 2023）— 核心/档案分页
- [ReadAgent](https://arxiv.org/html/2402.09727v3)（2024）— gist + 按需回看原文

**主机召回组包（本方案同族）**

- [Generative Agents](https://arxiv.org/abs/2304.03442)（Park et al., 2023）— `相关 + 近因 + 重要`
- [MemoryBank](https://arxiv.org/abs/2305.10250)（AAAI 2024）— \(R=e^{-t/S}\)
- [Mem0](https://arxiv.org/html/2504.19413v1)（2025）— 抽取再检索；相对全量省 90%+ token
- [A-MEM](https://arxiv.org/abs/2502.12110)（NeurIPS 2025）— 笔记互联
- [MemoryOS](https://arxiv.org/abs/2506.06326)（EMNLP 2025）— 分层
- [Zep / Graphiti](https://arxiv.org/abs/2501.13956) — 时序知识图

**专门打摘要压缩**

- [The Compaction Cliff](https://arxiv.org/html/2608.22752v1)（2026）— 长任务压缩掉约束；主张原始日志 + 可逆检索
- [Diagnosing Retrieval vs. Utilization](https://arxiv.org/pdf/2603.02473)（2026）— 检索质量比先不先摘要更决定上限

**窗口本身的限制**

- [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9.pdf)
- [StreamingLLM](https://arxiv.org/abs/2309.17453) / [Infini-attention](https://arxiv.org/abs/2404.07143) — 模型层，本方案不采用
- [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)

评测集：[LoCoMo](https://arxiv.org/abs/2402.17753)、[LongMemEval](https://arxiv.org/abs/2410.10813)。能验收本方案的指标：起始 token 是否平台、续写「刚才那个」是否仍对、跨会话偏好是否在、权限是否零泄漏。

---

## 10. 若往下落，第一刀做什么

本文是结论稿，不是实现规格。若开工，第一份规格只定这些（开关走 Lab UI + 持久化配置，不堆新 `RAW_AGENT_*`）：

1. **模式名**：Context Compiler；挂在 `prepareTurnInput`，不进 Memory 模块。
2. **分槽预算**：身份 / shortcut / 检索 / 余量；显式数字。
3. **工具存根**：推广现有 micro-compact，强制留配对 + 指针。
4. **检索**：transcript + memory 先做混合（FTS + embedding + RRF），复用 `case-recall` 套路。
5. **逃生口**：预算将尽才允许硬切 + `history` 类只读工具。
6. **验收**：平台起始 token、「刚才那个」、权限隔离；对照 LoCoMo / 自建长会话集。

未决（实现规格再定，不阻塞本文结论）：图谱是否第一期上、硬切是否对用户可见、Lab 里模式默认开还是关。

---

## Sources

- [Codex 取消上下文压缩？](https://mp.weixin.qq.com/s/HS5FAXgaBmB-pkKD_PUztQ)（2026-09-01）
- [openai/codex#27438](https://github.com/openai/codex/pull/27438)、[#27488](https://github.com/openai/codex/issues/27488)、[#29743](https://github.com/openai/codex/pull/29743)、[#39827](https://github.com/openai/codex/pull/39827)
- [openai/codex#14589](https://github.com/openai/codex/issues/14589)、[#37121](https://github.com/openai/codex/issues/37121)
- Codex 源码：`codex-rs/core/src/tools/handlers/new_context_window.rs`、`compact_token_budget.rs`、`context_manager/history.rs`、`codex-rs/ext/history-notes/src/{tools,extension,backend}.rs`、`codex-rs/memories/README.md`
- [MemGPT](https://arxiv.org/abs/2310.08560)、[ReadAgent](https://arxiv.org/html/2402.09727v3)、[Generative Agents](https://arxiv.org/abs/2304.03442)、[MemoryBank](https://arxiv.org/abs/2305.10250)、[Mem0](https://arxiv.org/html/2504.19413v1)、[A-MEM](https://arxiv.org/abs/2502.12110)、[MemoryOS](https://arxiv.org/abs/2506.06326)、[Compaction Cliff](https://arxiv.org/html/2608.22752v1)、[Retrieval vs Utilization](https://arxiv.org/pdf/2603.02473)、[Lost in the Middle](https://aclanthology.org/2024.tacl-1.9.pdf)、[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- 本仓：`doc/harness/04-context-economics.md`、`doc/harness/17-context-memory-compaction.md`、`doc/PROMPT_CACHE.md`
