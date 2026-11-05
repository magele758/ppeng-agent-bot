<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## routine-failure-governance
例行任务连续故障治理

先按你建议的顺序推进第一批：记忆删除抑制、严格预检、定时任务故障治理。按仓库的验收优先流程，先写验收标准给我确认。

## routine-owner-permission
定时任务沿用 Bot 免审批

很奇怪，这个定时任务，是单次的？还有这个定时任务还失败了，帮我排查下原因并修复下

## routine-precheck-fail-closed
例行预检失败不唤醒模型

Fix: if a bot routine precheck throws, exits non-zero, or otherwise fails, do NOT wake the model (wakeAgent false). A stdout {"wakeAgent":false} must still suppress the model even if the process exits non-zero — or if you treat non-zero as failure, failure means do not wake, never wake. The precheck subprocess must not inherit the daemon environment (use sanitizeSpawnEnv or an explicit minimal env) and must not get general network access unless the existing design already required it for a documented reason; default is no network. No new RAW_AGENT_* env. Acceptance-first, user asked to fix now, tests first. Open a PR and merge if relevant checks are green. Do not publish npm. Do not edit compact thresholds, software private-IP checks, GitHub webhook verification, or the web console.

## routine-quiet-chat
无结论的定时回执不进主对话

“定时任务结果 … [NO_UPDATE] 查看详情” 这个感觉完全没用啊，还徒增了我理解的负担，这个到底是要干嘛用的？
那你就优化一下这个

## routine-strict-precheck
严格例行预检与持久游标

先按你建议的顺序推进第一批：记忆删除抑制、严格预检、定时任务故障治理。按仓库的验收优先流程，先写验收标准给我确认。

## routine-weekday-daytime-default
新建例行任务默认工作日白天

Make new routines default to a weekday daytime run window (工作日白天窗). When a user creates a routine without an explicit schedule/window, the defaults should prefer weekday daytime hours rather than firing overnight or on weekends by default.
Creating a routine (API / tool / Lab — whichever path(s) set defaults today) should default the schedule/timing window to weekday daytime (Mon–Fri daytime local hours, aligned with existing flexible timing / cron attention / quiet-hours semantics).
Explicit user-provided cron/schedule/timing must still win; only fill defaults when the user omitted them.
Existing routines must not be mass-rewritten; this is about new creates / default fields.
