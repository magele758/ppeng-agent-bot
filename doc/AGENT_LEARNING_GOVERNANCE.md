# Agent learning and governance

Open a Bot chat, then **Context → Learning and governance**. All settings are saved immediately per session; no new environment variables are required.

## Correct a response and replay it

An assistant response has a **Capture correction** action. Enter required text, forbidden text and/or exact forbidden tool names, one per line. Captures retain the source message references, a bounded textual input window and matching recorded tool results. Known environment secrets, token patterns and email addresses are removed; remaining recognizable credentials reject capture. Images and reasoning are not copied. A counterexample requires an explicit variant task.

Refresh the learning panel to see saved drafts. Replay calls the configured model with only fixture tool declarations. It never invokes a production tool executor. Unrecorded tool/input combinations, forbidden calls, missing assertions, model errors and a six-turn/60-second limit fail the report. Reports expose text assertions, latency and input tokens when supplied by the adapter. These checks are narrow regression evidence, not an independent proof of correctness. Review the sanitized case before reuse; do not capture unnecessary personal data.

## Validate and release a skill

Select at least one original regression and one counterexample, then enter a skill name, description and Markdown body. Validation compares the installed Bot-local skill with the candidate on every selected case. Publication accepts only the exact passing candidate and unchanged baseline. Edited installed content requires a fresh evaluation. This workflow cannot publish a shared skill or change tool permissions.

Published and previous versions retain their exact content. Restore compares the current file digest with the version shown in Lab, rejects stale views, and cannot restore a version owned by another Bot or broaden sharing. The runtime reloads the skills after publish/restore. Existing manual skill management remains available; it is not labeled as evaluated and cannot create a passing candidate report.

## Sources and authorization

Host admission records direct user requests, routine/event inputs, mailbox inputs and externally fenced tool/attachment data separately from the transcript. Generated summaries and continuations cannot turn these records into user authorization. Delegation snapshots external ancestry; a later unrelated user message in the parent does not grant new rights to an existing child.

After external input, effectful tools require an exact saved tool grant or a current matching approval. Child scopes may narrow ancestor grants; they cannot expand them. Ordinary approval and sandbox checks still apply. Read-only tools remain available. Source history and allowed tool names appear in the panel. The boundary relies on accurate tool side-effect declarations and host external-content fencing; it is not model-level prompt-injection prevention.

## Input queue

Inputs have a host-assigned source. Direct user inputs start at priority 100, background inputs at 20; each aging interval adds 10. A safe-boundary claim takes the highest priority tier, up to the configured batch size. Older background work can eventually outrank new corrections. The default aging interval is 60 seconds, batch size 32.

Repeated keys coalesce only within the same source. External keys are namespaced so later transcript application cannot hide a direct correction. The panel shows pending/claimed/coalesced decisions and replacement IDs. Queue priority applies at inbox drains, not to an already executing external effect. Existing overflow capacity remains independently configurable.

## Validation

- Core behavioral coverage: `packages/core/test/learning-governance.test.js`
- HTTP workflow: `apps/daemon/test/learning-http.test.ts`
- Lab persistence: `e2e/learning-governance.spec.ts`
- Acceptance: `acceptance/agent-learning-governance.yaml`

Full build, i18n parity and bounded multiprocess/restart/lifecycle/pairing gates supplement the feature tests. These process checks retain their original scope and do not model arbitrary external integrations.
