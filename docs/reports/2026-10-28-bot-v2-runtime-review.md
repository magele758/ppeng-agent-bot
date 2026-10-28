# Bot v2 R0/R1 implementation review

Date: 2026-10-28. Scope: reproducible local log regressions and saved source authorization continuity.

## Problem and resulting behavior

Status questions and presentation preferences no longer create unrelated goals. Bot routines collect host-owned per-attempt output, including approval continuations, and link an existing visible answer instead of adding a second summary. A routine's inherited asynchronous context cannot tag a successor writer's output. Structured source refusals remain failed checks even if the model replies NO_UPDATE. Group budget exhaustion closes running member slots and reports failure.

Saved source policy now supports complete argument-exact tool calls through the existing Lab learning/governance panel. Legitimate child and same-principal Bot contexts resolve the canonical saved policy; local child policies can narrow it. Grants do not authorize a changed command, another principal, or another tool; revocation is read at execution time. This does not convert bypass mode or delegated text into source authorization.

## Fail-first evidence

- The initial log replay tests reproduced false new goals, cross-request/recap result contamination, duplicate canonical summaries, refusal converted to silence, and budget-ended members left running.
- The argument-exact and canonical-context tests failed before source-policy implementation.
- Concurrent HTTP regression exposed a too-early user-message boundary. It was replaced with host-owned message provenance.
- An approval-continuation counterexample failed until resumed execution used the same per-attempt provenance.
- A successor-writer counterexample failed until provenance was bound to the first actual writer run.

## Review checks

- Source provenance and message append share a SQLite transaction; the new table is schema migration 35 and is supplementary, not a second execution authority.
- Existing writer admission, expired writer rejection, lease ownership and tool-call/result pairing remain enforced.
- Canonical source-policy selection checks real ancestry, Bot identity and principal; caller-supplied child identity cannot select a different canonical grant.
- Exact grants compare complete canonical arguments. Local scope restrictions and current revocation are checked before execution. Existing approvals and sandbox policy remain independent.
- Normalized invalid settings do not overwrite saved grants. No environment feature flags were added.
- Original history stays intact. The run result uses visible owned messages; compact/recap and previous routine summaries are excluded.
- Review fingerprints were updated only for the inspected changed files; new helper dependencies were added to the mappings. No thresholds or existing acceptance criteria were weakened.

## Validation

- Workspace TypeScript build and Web production build passed.
- Current dedicated R0/R1 suite: 16 passed; affected routine/lease/storage suite: 41 passed; original related suite: 89 passed.
- Affected browser suite: 8 passed.
- Concurrent authenticated HTTP load fixture passed after the approval-continuation fix, including the deliberately failed-shutdown negative control.
- Formal pairing, lifecycle, restart and concurrency pipeline passed; subsequent writer-bound attribution has a dedicated regression, and the four reviewed-source guards passed again.
- Static acceptance gate passed.
- Initial broad unit run: 5,346 passed, 14 failed, 5 skipped. Its failures identified the corrected HTTP boundary, review fingerprint drift, and local fixture prerequisites. The cached full Electron distribution and a realpath TMPDIR repaired the environment cases; their focused reruns passed. Do not report the initial broad run as a green full run.

## Remaining v2 work

Work/watcher lifecycle binding, current workflow references, supervisor evidence freshness and correlated replies, durable group intake and cross-context work continuity remain subsequent slices. No production state or running services were changed by this implementation review.

Additional fail-first consumed-steer counterexample: an already consumed routine prompt followed by another user request now re-anchors the same routine before its owned continuation. Its result must refer to this routine, while completed side effects remain in history and are not replayed. Dedicated 16 tests pass; the genuine mixed HTTP soak normal fixture passes with zero duplicate software keys (43s). Failure-injection cases remain part of the same harness.
