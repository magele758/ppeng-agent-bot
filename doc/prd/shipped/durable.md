<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## durable-agent-waits
Agent 持久化条件等待与恢复

按这个通用方案开始实现，复用现有 Goal、Routine 和执行器能力，不要针对具体 case 写特殊逻辑。先把持久化等待、条件触发和恢复执行这条链路跑通，再用我的真实日志做回归验证。

## durable-artifact-port
大结果落盘并按页引用

implement a SMALL cut of DurableArtifactPort + Pages (paged artifact by-reference for large results).
Prefer the durable artifact port + paged-by-reference slice over full five-stage ingestion.
invent the DurableArtifactPort abstraction that persists artifacts and returns page/refs for large model-facing results instead of dumping full blobs into the loop.
Pages here means paged artifact by-reference (large tool/result paging), NOT a Cursor/Grok Bot Canvas UI clone.
Keep the cut small: port interface + persistence + by-reference paging + acceptance tests.

## durable-page-port
库级持久页面与分享链接

implement a SMALL cut of a library-level durable Page Port (shareable markdown page).
This is NOT DurableArtifactPort and NOT paged tool-result by-reference (#328).
A Page has a title, a monotonic revision, a shareable id, and a markdown body.
It persists in the runtime store and can be created, updated, fetched, and listed
through the same daemon/core patterns as other library resources.
Rendering may reuse a read-only A2UI basic-catalog surface. Do not clone a
Grok/Cursor canvas, and do not turn session A2UI cards into library pages.

## durable-wait-default
Durable wait is the default Goal/Routine park path

waiting_condition / wait_for is the default path for Goal and Routine when suspending
for an owned observable. Host parks waiting goal_dispatch results onto durable wait
without requiring the model to call wait_for. Cron/sleep/history-poll are not substitutes.
