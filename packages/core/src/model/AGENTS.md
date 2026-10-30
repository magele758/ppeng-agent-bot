# model/ — prompt & adapter harness notes

## `STABLE_SYSTEM_VERSION` bump discipline

`STABLE_SYSTEM_VERSION`（`prompt-builder.ts`）是 **stable system prefix 的可观测指纹**，写入 `turn_end` trace，**不进 prompt、不进 prompt-cache key**。

改 `PromptBuilder.buildStablePrefix`（或它调用的、会进入 stable 前缀的文案）时，**同步递增**该常量。目的是归因（哪一版 stable 文案在跑），不是保缓存命中。

漏 bump 不会掉缓存，只会造成 trace 上的版本标错。

## Upstream request id

`upstream-request-id.ts` 从 header / JSON / SSE / 嵌套 error 串提取上游 `request_id`，经 `ModelTurnResult.requestId` 进 `turn_end`。纯观测，不改循环控制。

## Prompt variant A/B (Lab UI)

Stable system prefix has two wordings: `anthropic5` (default) and `legacy`. Operators pick the active variant in Lab **Settings → Behavior → System prompt variant**. To roll back, select `legacy` and save — no env switch.
