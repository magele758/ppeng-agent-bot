# 上线后真实运行复查（2026-11-11）

## 数据边界

本机观察窗为 2026-11-11 10:48:23—17:46:07（Asia/Shanghai），实际监听进程 76086 的 cwd 是 f77e787d release，打开的是主开发目录实时 SQLite。快照以只读事务提取消息、例行运行与 inbox，trace 从原 JSONL 逐行读取并保留原始行号；采样时间单独记录，不声称库与 trace 跨文件原子一致。

ubuntu2 是独立状态目录 `~/wt/ppeng-deploy-state`，不与本机共用数据库。10:46—17:46 没有新增会话消息、定时运行或 trace；16:35:29 已部署 ce5db43e。因此 ubuntu2 就绪只能证明部署成功，不能当成真实业务稳定性样本。不能把开发目录 HEAD 当成本机已上线版本。

## 真实样本结果

- 本机 17 个有 trace 的会话，330 条持久消息（136 assistant / 152 tool / 37 user / 5 system）。174 条 turn_end 中，39 条是 terminal、135 条是模型结束，不能混为 174 次模型请求。
- 152 条 tool_end，19 条失败。无 repetition_abort / reasoning_spin_abort / recovery_abort / recovery_advisory / model_error / turn_truncated，也没有五次相同工具输入与结果的连续序列。这只能表述为本窗口未发现持续循环，不能证明未来不会发生。
- 33 次应触发的例行 occurrence 均有运行记录：9 completed、24 silent；没有 queued/running/failed。9 个 published 回执均有真实 summaryMessageId，实时数据库可查到对应消息；24 个结果均以 `[NO_UPDATE]` 收尾。健康/发布巡检按指纹无变化静默，不能算成漏答，也不能补发成新通知。
- 24 次静默中健康检查仍有 `daily_wrong_day` 业务异常，首次/变化时有通知，指纹不变按任务规则静默；框架完成不代表业务对象健康。
- 19 个工具失败涉及命令超时、数据或命令不存在、一次技能候选拒绝与已不存在的 cron 删除，以及健康检查返回的不健康状态。未观察到因此挂住的例行运行。保留原错误，不将 ok=false 直接统计为用户任务失败。
- 已存正文里发现 15 条包含重复短段落的 assistant 消息，最长重复块 32 字符；例如 session_c5722febe6504314a15ab2a8e391617b seq 862/869/876、session_85d7310afd8f4ee68b329e5983d23f12 seq 594/600。不是单纯前端重画。未发现相邻助手消息的整段相同长正文；没有历史浏览器逐帧/SSE 接收记录，不能据此断言 UI 从未重复或闪动。
- 本机 daemon/Lab 本次发布独立 stderr 文件为空；client-errors.jsonl 最后记录在 11 月 10 日。没有客户端错误记录不等于没有视觉异常。
- 资料采集器上线后 85 条错误均为已删除的 CubeSandbox 目标，后续信息流资料仍更新，12:00 / 16:00 摘要均完成，未复现兄弟目标被饿死；不会重建用户已删除的任务。旧 helper 仍缺少准备阶段隔离，部署时应与已合并 #511 的主脚本成对更新。

## 新定位并修复的漏洞

运行时仅在**启动时**有 direct 回调或已有订阅者时才连接流式 dispatcher。后台定时启动通常没有网页，因而选择了非流式模型方法。其后网页加入也收不到后续 token；更严重的是 `runTurnWithRetries` 只有流式路径经过轮内复读 guard，无人观看的后台运行绕过这层保护。

这不是把本次 15 条短复述都归因于该漏洞：它们低于退化看门狗的保守阈值，本次没有真实持续循环实例。确定的证据是两个集成回归修复前失败：后台后订阅时 streaming call 为 0；后台生成 500 个重复字符走 plain runTurn，未进入 guard。

修复：始终连接现有、带写入者校验的 dispatcher，保留同一 AbortController 和 commit 身份。无需预先打开网页才能获得保护或稍后观察。显式 RAW_AGENT_STREAM=0 和没有流式能力的 adapter 仍沿用原有非流式路径。没有按正文相同就删除内容，没有修改历史消息。

在两种 kernel 上验证重复流只干净重答一次，第二次即停止，退化正文不落库；后订阅能收到剩余正文与 assistant_saved，模型只调用一次、答案只存一次。已保留断线、写入者撤销、审批续跑和流式回退的回归。

此外，真实验证入口发现已合并的 abort-lineage.ts 未进入 source mapping。现已审阅其父子信号 WeakMap、重复链接拒绝和有界环检测，补入四种验证的原有 tool-loop 映射。没有移除检查、负例或降低门槛。

## 验证与发布边界

修复前失败记录、修复后检查、只读采样及后续部署证据保存在本机 `test-results/post-deploy-20261111/`。新规格为 `unattended-stream-observation`；105 项相关检查与补充的非流式边界通过，验收静态门禁通过。完整形式化检查与发布后的真实观察分别记录，不能把 isolated 模型回放当成线上复发已被消除。
