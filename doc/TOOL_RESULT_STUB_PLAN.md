# 工具结果占位：进度与分 Agent 开发计划

> 2026-10-28 源码核对：当前已存在 `session/model-view.ts`、`tool-result-retrieve.ts`、SDK 存根实现、`e2e/lab-model-view.spec.ts`，`compact-ab-eval.mjs` 已使用真实命令输出种子。下文“页面没做”“玩具种子未替换”是历史记录，不能据此重建；真实模型 A/B 效果仍以具体运行报告为准。


| 字段 | 值 |
|------|----|
| 状态 | 存根、模型视图、原文取回与真实命令种子已实现；下文为历史计划 |
| 日期 | 2026-09-02 |
| 已合入 | [#19](https://github.com/magele758/ppeng-agent-core/pull/19) `fe1fbaf` |
| 对照 | [CONTEXT_COMPILER.md](CONTEXT_COMPILER.md) §7、[harness/04-context-economics.md](harness/04-context-economics.md) |
| 并行会话 | [工具调用结果占位](https://cursor.com/agents/bc-a090428a-2da3-41a9-b9ae-1035361bcf5a)（仍在跑 A/B 种子） |

---

## 1. 结论：开发完了没有？

**运行时占位：完了（下一轮生效）。从页面验证效果：没完。**

对话区仍渲染落库 transcript（全文 `tool_result`）。占位只发生在送给模型的视图里，Lab 默认看不见。开关能保存，不等于能在页面上确认「模型下一轮吃的是占位」。

Chat Completions **做不到**「模型开始吐字的同时挖掉本轮 KV」。用户原话是中途抽离；实现只能对**之后的轮次**改视图。这点写死，不再当未完成 bug。

---

## 2. 你点名要过的功能（对照）

来源：并行 Agent「工具调用结果占位」的用户跟进（2026-09-02）。

| # | 原话要点 | 状态 | 落点 |
|---|---------|------|------|
| 1 | 工具结果先给模型，模型开始吐下一轮后再从主会话抽走 | **部分完成** | 下一轮 `prepareView` 里占位；不是吐字中途 |
| 2 | 只用「这里曾经有一个工具调用」占位 | **完成** | `micro-compact.ts` 占位行；不改 SQLite |
| 3 | 压上下文且尽量不影响效果 | **未证完** | 离线实验有；真模型 A/B 种子太玩具 |
| 4 | 同类论文 | **完成** | 该会话综述；本仓 `CONTEXT_COMPILER.md` |
| 5 | 加进本仓库 + **web-ui 开关方便测试** | **开关完成 / 页面看效果未完** | `CompactSettingsCard`（更多 + 对话区）；`GET/PATCH /api/compact/settings` |
| 6 | 真模型对比、密钥不进对话/PR | **完成** | `npm run test:compact-ab`；Actions 用 repo Secrets |
| 7 | 三方 key 怎么配 | **完成** | Lab「更多 → 模型服务商」优先，`.env` 回退 |
| 8 | 加 Compact A/B action | **完成** | `.github/workflows/compact-ab.yml` |
| 9 | action 不要每次都跑，手动触发 | **完成** | 仅 `workflow_dispatch` |
| 10 | 评测 tool 太简单，返回的是什么？ | **未完成** | 现为 `BEGIN_DUMP` + `SECRET_TOKEN` + 一串 `x` |

默认策略仍是 `keep_recent`（与现网一致）。实验档：`after_text_assistant`（推荐）、`after_any_assistant`（更激进）。策略走 Lab KV，**不新增功能开关 env**。

---

## 3. 分 Agent 任务

三个切片互不改同一核心文件，可并行。都从 `origin/main` 拉分支。  
**不要**再改 `RAW_AGENT_*` 功能开关。密钥只走 Lab / 已有 repo Secrets。

### Agent A — Lab 送模视图（页面可测）

**目标**：人在 Lab 里能看见「模型实际吃到的」和「落库全文」的差别。

**做：**

1. `GET /api/sessions/:id/model-view`（或等价）：对当前 session 走与 `prepareView` 相同的 micro-compact / 策略，返回 `{ stored, modelView, stats }`（`collapsed` / `charsSaved` / `policy`）。只读，不改库。
2. 对话区增加「送模视图」开关（默认关）。打开后 tool_result 显示占位/裁剪，并标明「仅模型视图」。
3. `CompactSettingsCard` 旁一行有效策略 + 本会话最近一轮 `charsSaved`（有则显示）。
4. Playwright：heuristic 下切到 `after_text_assistant` → 发会打出长 `bash` 的消息 → 再发一轮 → 打开送模视图 → 断言占位文案出现、落库全文仍在（关开关能看见原文）。
5. 单测：API 对同一 session 在两种 policy 下 `collapsed` 不同。

**不要动：** `compact-ab-eval.mjs` 种子、CI workflow 触发方式。

**验收：** 不改 `.env`、只点 Lab，能完成一次「开实验档 → 两轮对话 → 看见占位」。

### Agent B — 评测种子换成真命令输出

**目标：** 回答「tool 返回的是什么」，并让 A/B 能测「效果」。

**做：**

1. 把 `scripts/compact-ab-eval.mjs` / harness 里的假 dump 换成多行真实 stdout（例如 `ls -la`、`git status`、一段测试失败栈）。
2. 追问的事实**只出现在 stdout**，不出现在 user 指令或命令行里。
3. 报告写清：tool 名、stdout 摘要、silent/restated 召回、token、折叠字数。
4. 单测锁「事实不在 prompt 命令行」。
5. 保持 `workflow_dispatch`；不要拉回 PR 必跑。

**不要动：** Lab 设置卡片、`prepare-view` 策略语义。  
若 [占位 Agent](https://cursor.com/agents/bc-a090428a-2da3-41a9-b9ae-1035361bcf5a) 已推同类提交，先 rebase / 接上，禁止平行两套种子。

### Agent C — 占位带地址（索引记忆）

**目标：** 占位是线索，不是撕页表。对应 `CONTEXT_COMPILER.md` §7.1。

**做：**

1. 占位行带稳定地址：`tool` 名、`ok`、消息/part id 或归档 key（现有 spill / transcript 能指回去的）。
2. 只读工具或 API：按该 id 取回**落库原文**（给模型或 Lab「展开原文」）。
3. 单测：折叠后 `modelView` 无全文、retrieve 能拿回同一段。
4. Lab：送模视图里占位可点开「原文（落库）」。

**不要动：** A/B workflow、默认 `keep_recent` 行为（除非占位文案兼容旧断言）。

---

## 4. 三个关注点（记得 / 读回 / 死循环）

对照当前 main（含 [#24](https://github.com/magele758/ppeng-agent-core/pull/24) `retrieve_tool_result`）。  
可执行契约：`packages/core/test/tool-result-stub-risks.test.js`，实验 case `call_index_survives`。

### 4.1 模型还记不记得调过这个工具？

**记得「调过」，不记得「结果」。不是权重记忆，是窗口里的线索。**

`microCompactMessages` **只改 `tool_result.content`**，不删 assistant 的 `tool_call`（名字 + 参数 + `toolCallId`）。送模时 adapter 仍发完整 `tool_calls` 配对，结果行变成：

`[previous: used bash — output dropped from context]`

所以下一轮模型能看见：用过什么、参数是什么、结果被抽走了。硬切且无存根时，这三条都没有，模型不会「想起」自己调过。

`after_text_assistant` 要等助手写出正文才折叠，连续 tool 波里上一跳的结果还在。`after_any_assistant` 只要后面出现任意 assistant（包括纯 tool_call）就折，更容易只剩存根。

### 4.2 精简掉的内容能否用 `read` 找回来？

**`read_file` 读的是磁盘，不是会话库。**

| 来源 | 现网能否找回 | 条件 |
|------|-------------|------|
| `read_file` / `grep` 等文件类 | 能再调 `read_file` | 路径还在幸存的 `tool_call.input` 里，且文件还在 |
| `ls` / `git status` / 测试栈等 stdout | **不能**靠 `read_file` | 事实只活在被折掉的正文里；`command: ls` 不够还原 listing |
| 当时 `spill_tool_result` 写过的 spill | 能 | spill 路径还在窗口里 |
| 落库原文 | 能 | [#24](https://github.com/magele758/ppeng-agent-core/pull/24) 的 `retrieve_tool_result`（占位带 `msg=`/`part=`/`seq=`） |

路径若只出现在被折叠的 `ls` 输出里、从未写进 `tool_call` 或助手正文，现网回不来，除非再跑一遍命令（这会碰到 4.3）。

### 4.3 去掉结果会不会同一工具死循环？

**会有重调冲动，现有 LoopGuard 能兜底，占位策略会放大冲动。**

模型看到 `output dropped` 可能再调同一工具。护栏：

- `after_text_assistant`（推荐实验档）：连续 tool 波不抽离，直到写出正文，少一次「结果没了所以再 ls」。
- `after_any_assistant`：第二次 tool_call 后就抽 `ls`，更容易再 ls。
- `SessionLoopGuard`：同一 **工具调用内容**（整轮 `(name + 规范化参数)` 序列）连续 5 轮 → abort（默认 `RAW_AGENT_RECOVERY_SAME_TOOL_STREAK`）；失败连 3 次也会 abort。同名但参数不同（例如每轮 `bash` 命令分别是 `ls` / `cat`）会打断 streak，不会硬停。
- 相同 `tool_call` 指纹重复（默认窗口 8、比例 0.75）也会 abort。
- `AdvisoryGrace`：第一次先注入 `[recovery-advisory]`，再犯才硬停（`stopReason: tool_loop`）。

占位已带 `msg=`/`part=`/`seq=`。重调应优先 `retrieve_tool_result`，而不是再跑一遍有副作用的命令。`SessionLoopGuard` 仍兜底同工具连打。

compact-ab 评测的后续追问（`followUpPrompt`）禁止重跑命令，允许通过本会话历史恢复输出；若模型在后续轮调了 `bash`/`exec`/`bg_run`/`work_evidence` 等命令工具则计为 recalled=false（召回失败，非错误），见 `packages/core/src/session/compact-ab-harness.ts` 的 `scoreRecall`。

---

## 5. 明确不做（本轮）

- 吐字中途改 KV / 本轮已发出的 prompt。
- 把 Context Compiler 全套（query 编包、图谱、硬切）塞进这次。
- 新的 `RAW_AGENT_*` 策略开关。
- 每次 CI 自动跑 live A/B。
- SWE-bench 金标（除非另开任务）。

---

## 6. 建议顺序

A 与 B 可同时开。C 依赖占位文案，建议 A 的 API 形状稳定后再接「点开原文」，或 C 先做 core retrieve、Lab 点开跟 A 的开关复用。

合入顺序：B（评测可信）→ A（人能看见）→ C（线索可回指）。
