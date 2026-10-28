# Bot v2 linked watchers: review and evidence

This slice links a temporary routine to its existing durable Bot goal, optional registered background job and current SOP skill. It keeps the existing Goal service as completion authority and reuses main's generic durable wait store for process waits.

Fail-first evidence includes missing/foreign work links, no-observation quiet, stale copied SOP, cached filesystem skill content, edits during async skill loading, a parked stale anchor, external job identity changes, and failed observations. Host-only background bindings require the real active Goal/Routine owner plus persisted job session/start time. `bg_run` returns `waitFor` fields; `wait_for` owns registration, readiness and one-time consumption. A process exit resumes inspection rather than proving delivery. Cancelled/amended work stays draining while its own background process is live or unverified.

Review checked real same-principal ancestry; current schedule/goal rechecks after async loading; saved allowlists and skill routing; exact job identity and ownership rechecks before every wait observation; stale evidence timestamps; no model calls during passive waiting; and no automatic stop of independent health checks. Only verified-completed or cancelled linked goals stop temporary watchers. Prior routine provenance, approval/lease fencing and source permission rules remain in force. SDK contracts and sources are unchanged. Existing routines are not migrated by guessing prompt text.

Validation on the merged durable-wait base:

- Core/daemon TypeScript build and production Lab build pass.
- 72 focused core, real kernel, scheduler, authenticated HTTP and regression tests pass.
- 18 i18n tests pass; Chinese/English keys remain aligned.
- 5 Playwright tests pass: linked-work save/reload and existing task/routine delivery flows.
- Acceptance gate passes all 826 runnable test files.
- Changed functions were inspected against the existing complexity limit; reviewed-source fingerprints cover the changed boundaries and the two new helpers.

The earlier full formal run passed before integration with main's generic wait module. Final formal verification is rerun on the committed integrated source; that final result must be checked before merging. This is bounded verification, not an unbounded or production-load proof. No live bot state, remote development process or local credentials were changed.

Final integrated verification completed successfully: the full formal regression passed pairing, lifecycle, process restart and concurrent-process probes, mutation controls, and 25 invariant/property/mock-loop checks. Quick gate also passed its existing complexity, fingerprint, build, regression, integration and acceptance checks. These results apply to the committed generic-wait integration; no criterion or model bound was relaxed.
