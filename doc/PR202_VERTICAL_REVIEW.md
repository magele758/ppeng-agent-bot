# PR202 vertical review

The reviewed change supports quoting a Bot reply in private chat and Rooms. Only a short source pointer and excerpt are persisted on the user message; the answering model resolves the full original assistant text. Excerpts are limited to 120 characters, and reasoning/tool output is excluded.

The review traced Lab selection and cancellation, API admission, durable inbox/edit/claim, both runtime kernels, model preparation, history refresh, compaction continuation and Room recipients. Independent security and UI reviews found and closed:

- Running-session steering lost the quote on admission and in multiple inbox drain implementations.
- The default agent-loop kernel omitted full original text when preparing its model view.
- Room routing trusted a caller-supplied author, or broadcast after the original author departed.
- Shared-context revocation could be bypassed by loading quoted history.
- Compaction continuation and opt-in overflow summarization could lose the source pointer.

Quote admission validates the same-session assistant source. Revoked shared ranges cannot enter model context through quoting. Room author identity is derived from the stored message; absent authors yield an explicit empty recipient list, while explicit mentions remain authoritative. Quoted inbox items remain pending separately from lossy overflow summaries; the overflow cap applies to summarizable items. Quoted steering into a parallel child is explicitly rejected, and promotion leaves the queued item intact; Lab retains the quote on rejection.

Failure evidence preceded the fixes: actual route/runtime tests exposed inbox loss, default-kernel missing text, revoked-source recall, continuation restoration and overflow loss. Additional fixtures were corrected to identify the exact user message rather than an undefined key, and to open a Bot conversation and match its streaming endpoint.

Validation:

- SDK: 415 Vitest tests passed; SDK build passed; both SDK guides synchronized.
- Core quote, continuation and schema: 39 passed; 1 pre-existing environment-dependent skip (Node without FTS5).
- Quote UI/i18n and migration upgrade/rollback: 123 passed.
- Real browser against temporary daemon and production Next: quote selection, real streaming send, persisted excerpt and reload passed without retries.
- Workspace build, Lab type check, acceptance traceability and source review preflight pass through the unchanged Quick gate.

The four formal source-review mappings include these changes and targeted regressions as supplemental dependencies. Their existing bounded process/source checks are not a proof of all quote or UI behavior. Verification scope, approved acceptance criteria and thresholds are unchanged. Full validation remains scheduled every two hours and available manually; deployment remains deferred.
