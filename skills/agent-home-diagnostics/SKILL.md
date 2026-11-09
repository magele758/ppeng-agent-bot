---
name: agent-home-diagnostics
description: 排查 Agent Home 会话卡住、工具未返回、消息遗漏、模型截断、Bot 子任务异常、历史记录不一致或延迟。通过本项目的 sessionId、运行数据和 trace 定位第一处异常，并用原入口验证修复。Use for Agent Home runtime incident investigation and repair.
---

# Agent Home 故障排查

从用户看到的失败动作入手，记录预期结果、发生时间（含时区）、Lab 地址、sessionId 和可见的 taskId 或 botId。多套 daemon、worktree 和测试实例可能同时运行。源码从对应运行版本读取，路径均以该检出目录为根。

## 找到实际写入位置

1. 本地开发用 `jq '{at,labUrl,daemonUrl}' .agent-state/dev-lab.ports.json` 查地址，再用原用户在 Lab 的登录状态访问 `GET /api/readiness` 和 `GET /api/sessions/<id>`。端口记录可能过期。401/403 先核对同源代理、身份和会话归属。
2. 确定该进程使用的 stateDir 和主存储。SQLite 部署用 `lsof -p <daemon-pid>` 确认打开的 runtime.sqlite。PG 部署核对运行时主存储实现和连接目标，再查询 `SELECT current_database(), current_schema();`。记录数据源、schema 和采样时间。配置 DATABASE_URL 可以只启用事件缓冲与技能注册表；名为 agent_home_snapshot 的导入 schema 代表一次快照。用同一条近期会话的 id、消息 seq 和更新时间核对实时性。
3. 先读最少的元数据。SQLite 用只读模式和绑定参数。例如在 sqlite3 会话中执行以下查询。用实际 sessionId 替换示例，先核对表结构。PG 用已鉴权连接和对应 schema，在只读事务中执行等价的参数化查询。

```sql
.open --readonly .agent-state/runtime.sqlite
.parameter init
.parameter set :sid session_example
SELECT id, agent_id, parent_session_id, status, updated_at
FROM sessions WHERE id=:sid OR parent_session_id=:sid;
SELECT seq, role, surface_op, created_at
FROM session_messages WHERE session_id=:sid ORDER BY seq DESC LIMIT 30;
SELECT target, role, claimed_at, created_at
FROM session_inbox WHERE session_id=:sid ORDER BY created_at DESC LIMIT 20;
```

## 重建一次失败的时间线

读取 `GET /api/traces?sessionId=<id>&limit=500`。返回的 events 是尾部；omittedEarlier 大于零时扩大 limit（最多 5000）或读取完整文件。文件缺失、不可读和坏行都可能让 API 看起来没有事件。可选 PG 事件缓冲采用异步追加，统计缺口需再查本地记录。

从项目根运行下面的命令。脚本逐行读取 JSONL，仅输出事件类型、时间、原始行号及部分数值/布尔字段。遇到 invalid_record，检查对应行是否为正在追加的末行，稍后重读。需要更多信息时，只在本地查看目标行的指定字段；对外报告省略对话正文、模型输入、工具参数、凭证和连接串。

```sh
node skills/agent-home-diagnostics/timeline.mjs "$stateDir/traces/$sid/events.jsonl" | tail -100
```

按 sessionId 和 turn 划分轮次，保留原始行号。并行工具按 toolCallId 配对 tool_start / tool_end；旧记录缺 ID 且同名调用重叠时，标记配对不确定。child_session 的 payload.childSessionId 指向另一份 trace。终止事件可能只有 terminal、reason、outcome。跨进程比较时统一到 UTC。

| 用户看到的现象 | 下一条要核对的证据 | 源码入口 |
|---|---|---|
| 提交后一直等待 | 对照用户消息 seq、inbox.claimed_at、turn_start、审批状态。已落库却没开轮，查 admission / scheduler；已开轮，沿该轮找到最后一个已完成动作 | apps/daemon/src/routes/sessions.ts、packages/core/src/session/human-continuation.ts |
| 工具卡住、疑似重复执行 | 对照 toolCallId、tool_end、审批决定、实际业务回执。缺结束事件时，先确认外部操作是否已发生，再决定是否重试 | packages/core/src/runtime/tool-loop.ts、packages/core/src/stores/analyze-execution-log.ts |
| 回复被截断、复读或空转 | turn_truncated 对照 turn_end 的 finishReason 和用量；repetition_abort / reasoning_spin_abort 查轮内 watchdog；recovery_advisory / recovery_abort 查跨轮恢复决策；model_error / model_fallback 关联该轮的上游 requestId（如有） | packages/core/src/turn/kernel.ts、packages/core/src/streaming/ |
| 历史丢失或 UI 重复 | 对照持久化消息的 seq、surface_op、归档 transcript、API 返回及 SSE 接收顺序。compact 发生时查归档路径；micro_compact 只改变模型输入视图 | packages/core/src/stores/session-store.ts、packages/core/src/session/micro-compact.ts、apps/web-console/components/ChatTurns.tsx |
| 子任务或 Bot 一直显示运行中 | 核对父子会话、child_session、持久化任务状态和重启时间；stale_writer_rejected 提示检查写入者所有权 | packages/core/src/bots/、packages/core/src/runtime/restart-recovery.ts |

## 从证据到修复

写下「最后一次符合预期的动作 → 第一处偏离 → 用户看到的后果」。每个判断引用 sessionId、UTC 时间、trace 行号或表的主键/seq。提出能区分两个可能原因的下一项检查。例如 tool_start 后无 tool_end，审批仍挂起与外部操作已执行但进程重启，需要不同修复。只有日志缺口时，把结论标为待验证。

从出错事件的发射点追到负责状态写入的代码。用匿名最小数据在临时 stateDir 或独立测试库复现，保留真实事件顺序和关键条件。按仓库 acceptance-first 约定，先写带 AC 标签的失败测试，再修负责该行为的代码。跑针对性测试和 `pnpm run test:acceptance`；涉及重启、并发或重试时覆盖相应路径。最后走原来的 UI 或 API 操作，对比新的 trace 和持久化结果。报告写清根因、修复位置、验证证据和仍未覆盖的情形。
