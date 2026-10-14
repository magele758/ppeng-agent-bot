# Bot Routine lifecycle

Routine configurations remain compatible with `stateDir/cron/jobs.json`. Each trigger first creates a durable SQLite occurrence. Advancing or disabling a schedule does not delete its accepted occurrence. Run history and configuration are separate.

## Creating work

Lab and `POST /api/cron/jobs` support exactly one of `cron` (five fields), `onceAt` (ISO timestamp), `intervalMs` (integer, at least 1000), or `event` (`github/push`, `slack/message`, `email/received`). Supply an IANA `timezone`; Lab defaults to the browser timezone. Event signatures use an existing secret environment reference, never a secret value in the configuration. A GitHub delivery signs the unix-second timestamp, the delivery id, and the raw body together (`X-Github-Timestamp`, `X-Github-Delivery`, `X-Hub-Signature-256`) and is rejected when that timestamp is more than five minutes from now. Slack and email keep their existing five-minute signatures.

`missedPolicy` is `coalesce` by default. `skip` records skipped overdue work. `catch_up` creates at most ten occurrences and records the omitted count. Catch-up admits up to ten planned slots. If capacity allows only a prefix, the remaining planned slots stay pending and the checkpoint advances only over already durable receipts; a later tick admits the rest. A receipt snapshot also preserves that plan across a crash before the configuration checkpoint. A full queue leaves the schedule checkpoint unchanged and exposes `queueBlockedReason`; received occurrences are never evicted. Event intake returns retryable queue-full without consuming its delivery receipt. A repeated DST local minute uses the first offset only; nonexistent local minutes are recorded as skipped when the next due scheduling evaluation covers that transition. Intervals and one-shot tasks use absolute instants. Legacy configurations without timezone are assigned the daemon's current IANA timezone on read and save it on their next update; explicitly save a timezone before moving legacy files across host timezones.

Dialog scheduling tools are mounted by default. `GET/PATCH /api/cron/settings` controls persisted `dialogToolsEnabled`, effective at the next call without restarting. Existing Bot tool allowlists and optional tool-group selection still apply.

## Running and viewing results

Each occurrence has its own working chat, inherits the Bot identity, model and allowlists, and follows existing child permission rules. It does not copy private chat history, compression state or pending approvals. A busy private chat does not block this independent work. Each Routine is serial; approvals hold that Routine's queue. Paused or disabled Bot contexts retain queued work with a reason; hiding a Bot only changes display.

`GET /api/cron/jobs/:id/runs` lists runs with `nextCursor`; request `?before=<nextCursor>` for older terminal history. Active and unknown runs remain visible on every page and must be merged by ID; an old unknown result never disappears behind a history window.

 `GET /api/cron/runs/:id` includes status, scheduled time, missed count, attempts, result and working session reference. Main chat receives only a summary and a link after it becomes idle. `lastRunAt` means trigger time, not successful completion.

A precheck returning false records `skipped` without a model call. A precheck error preserves the existing fail-open behavior and records a diagnostic. Empty model output or denied/expired approval is a failure, not success. Unattended approval expires after the existing ten-minute deadline. Explicit approval resumes the same working session through the shared continuation guard; approving is not treated as completed work. Only the finished continuation's result can complete the occurrence.

## Recovery and control

Unstarted occurrences survive restart. A missing working context during approval also becomes `unknown` and requires effect verification before retry. Interrupted model work becomes `unknown` and is not automatically replayed; later work for that Routine waits for resolution. A live worker's execution is not treated as a restart by another worker. Claims serialize Routine execution, and stale callbacks cannot overwrite a different attempt's result.

`POST /api/cron/runs/:id/cancel` cancels queued work or requests cancellation, rejects pending approvals, and never promises to undo effects already performed. `POST /api/cron/runs/:id/retry` retries failed/cancelled work. Unknown work requires an explicit JSON body `{"confirmUnknown":true}` after checking possible effects. Attempts retain their original working session and result references.

A missing Bot main chat is repaired only from a persisted principal binding. Legacy work with no provable binding is failed visibly rather than reassigned to a new user. Existing completed results are not rerun because their summary notification was delayed.

Schema registration uses `ensureRoutineSchema`; production migrations call this idempotent DDL helper. Backups must include both SQLite and cron configuration files.
