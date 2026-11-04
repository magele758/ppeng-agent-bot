<!-- 本文件由 scripts/prd/build-catalog.mjs 生成，不要手改。改验收规格或技能说明后重新运行该脚本。 -->

## ci-action-reliability
Actions 长短验证可靠性

去修复一下这个项目的Action，看看怎么改造合适，现在长任务一直失败，短任务好像也没完全卡住bug

## ci-audit-p1-p2
CI audit P1/P2 release gate hardening

Remaining CI P1/P2 items from the earlier ppeng-agent-core audit: retry-pass must not be silently green; acceptance status downgrade/removal must fail the gate; CRAP baseline relaxations and apps/web-console must be covered; only an explicit approve counts as approval; trustProxy=false ignores X-Forwarded-For (test); recursive test:unit discovery; no slack for zero-coverage CRAP entries; TLA sanity check in test:formal; mutation/real-model smoke/Harness/compaction A/B failures feed the Main release gate (missing secrets may skip); pinned bot-release evidence items.

## ci-fast-and-bihourly-gates
两分钟快速门禁与每两小时完整验证

按这个办，改标准和门禁。
日常提交继续走 2 分钟快速门禁，并加上改动函数的复杂度检查和核心单测。
全量检查仍不放进每次提交。代码合入主分支后立刻跑与两小时定时相同的完整验证，定时任务保留。
主分支最新完整验证失败时暂停再合并；这个分支自己已经完整验证通过时可以合并，避免修复被挡住。

## ci-http-fixture-timing
共享持续集成 HTTP 夹具计时

云端的Action又报错了，去排查修复一下问题

## ci-parallel-validation
完整验证职责并行与覆盖率产物复用

按这个方案继续推进，保持验证范围和阈值不变，把单测、Formal、SDK拆开并行，CRAP复用覆盖率产物，Quick保持2分钟以内。先把这次调整的验收标准写出来给我确认。

## ci-review-drift-signal
评审指纹不一致时不要再报一次结果缺失

分多个agent去彻底解决这几个问题

## ci-zero-coverage-complexity
零覆盖画面仍能通过复杂度门禁

分多个agent去彻底解决这几个问题
