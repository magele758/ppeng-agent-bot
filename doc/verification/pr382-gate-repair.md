# PR #382 gate repair review

The stored SHA-256 for `packages/core/src/bots/goals/runtime-host.ts` in all four review manifests exactly matches the file before PR #378 (`26e97018^`). Comparing that reviewed source with this candidate shows only two behavior changes: neutral wording for an unverified result, and suppressing unsolicited `pending_review` chat notices. These implement the existing `quiet-goal-results` acceptance contract.

The transactional reload of the latest goal, terminal-version deduplication, message persistence, writer fences, execution routing, tool pairing, cancellation, restart and concurrency logic are unchanged. Only this source fingerprint and the reviewed goal-chain regression file fingerprint are refreshed; the verifiers, mappings, mutation controls, budgets and branch protections are unchanged.

Three stale regression fixtures/expectations caused the unit failures:

- A fixture claimed verified completion but supplied no evidence, so it correctly remained unverified. It now supplies evidence and explicitly asserts `completed`, retaining the original terminal notice, deduplication and stale-checkpoint checks.
- A pending→completed transition expected both notices. It now asserts no pending notice, unchanged pending state/evidence, exactly one completed notice, no duplicate after a stale-state announcement, and preservation of new user input.
- Terminal notice coverage now explicitly exercises completed/failed/blocked, retaining three notices and zero scheduler wakes/inbox entries. Pending silence is checked separately.

`quiet-goal-notice` is retired with its original criteria retained because its pending-review notification requirement conflicts with the later user request implemented in #378. `quiet-goal-results` AC-5 preserves terminal formatting, idempotency and stale-state/new-input guarantees. Existing tests remain active and use the successor criterion tags.

Validation: six focused goal-notice/SQLite regressions passed; all four source-review preflights pass. The actual formal runtime/model/mutation probes and full GitHub validation must also pass on the PR head before merging; fingerprint updates alone are not proof of success. Main full health requires this head's successful Full validation while main is red.
