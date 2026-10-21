---
name: verify-session-restart
description: Run and review bounded process restart recovery verification for running, retrying and approval-paused sessions. Preserve actual failures and request separate repair acceptance before product changes.
---

# Process restart recovery verification

Run from repository root: `pnpm run test:restart`. Requires Node >=22 with SQLite FTS5, installed dependencies and TypeScript 5.9.3. No real model keys or host .env are loaded. Existing process settings used by the hermetic children are not new product configuration.

## What executes

1. `restart-model.mjs` exhausts a finite, independent durable-state model: chat/task, one retry, two approvals, two tools, two runs and up to three process generations. Crash and orderly exit are different events. Replaying model counterexamples is supported. This is not TLC or an unbounded proof.
2. `restart-runtime.mjs` starts separate Node OS processes running the production `RawAgentRuntime` constructor, SQLite store, default assembled kernel and `destroy()`. Model and local tool I/O are controlled. IPC observes execution phases; it never overwrites product state or supplies recovery policy. The HTTP server, HTTP connection draining and scheduler boot are not exercised; do not claim daemon HTTP/E2E recovery coverage from this test.
3. The child acknowledges a real model call, actual retry timer registration, tool execution before result persistence, or a settled approval wait. Parent sends SIGTERM (child calls production destroy) or SIGKILL (no cleanup). Parent waits for exit before opening the same state directory in a different process. Another restart checks idempotence. Ordinary chat/task sessions are deliberately outside Bot-specific queue recovery.
4. Actual snapshots include status/outcome, interrupt, durable approvals, transcript tool parts and a separate append-only controlled I/O ledger. Fresh-run admission and approval failures are product counterexamples; process startup failure/timeouts are incomplete checks. Persisted random IDs are compared for continuity then normalized in reports, along with process generations and logical runs.
5. Three isolated ESM source mutations alter real product startup: retain phantom running state, re-run a previously cancelled retry, and forget a persisted approval decision. Source files are never edited. Each mutant must load, add a failure to a previously passing scenario, and restore exactly to its baseline. A pre-existing red case is not a killed mutation.
6. The command includes current lifecycle and pairing verifiers. All must pass to report overall pass. Source/model mappings and SHA-256 fingerprints require review.

Independent scenarios run in pairs, each with its own temporary repository and state directory. Within one scenario, every predecessor still exits before the next generation opens its database. Results retain the fixed inventory order; infrastructure failures wait for peer cleanup and propagate without retry. This scheduling avoids serial startup and retry-observation waits exceeding the existing 180-second batch budget; no scenario, observation window, mutation or timeout is removed or relaxed.

## Evidence and exit codes

`coverage/formal/restart/report.json` and `report.md`, or `pnpm run test:restart --out <directory>`. Exit 0 only for complete, reviewed, all-green checks. Exit 1 for actual mismatches or unreviewed changes; exit 2 for missing tools, child failure, timeout or incomplete evidence. CI has an explicit no-retry step and uploads evidence even on failure. `pnpm run test:formal` keeps both existing gates and adds restart verification.

For a defect, retain the failed actual-process trace, affected acceptance IDs, observed phase and SIGTERM/SIGKILL exit evidence. Follow `skills/acceptance-first/SKILL.md`: create a separate draft repair specification and request confirmation, without changing product code or weakening this approved verification spec. Leave `session-restart-recovery-verification` approved until its actual acceptance tests pass.

## Review after source changes

Read `specs/formal/restart-review.json` mappings, inspect every changed source path and its relevant startup/control flow. Run verification before updating hashes to observe `needs-review`. Update only hashes you actually reviewed; explain the change in `reviewNote`. Re-run real probes and source mutations; changing a hash alone is never verification. Keep earlier pairing/lifecycle standards intact and refresh their overlapping fingerprints only after reviewing the shared gate changes.

## Boundaries

One live writer process at a time; already committed SQLite data on a healthy local filesystem; one configured retry, at most two unexpired approvals and a small controlled tool wave. No host power loss, torn storage, corrupted database, migration, multiple live writer processes, independent scheduler/Bot queue recovery protocol, arbitrary external effects, or external exactly-once guarantee. Missing saved results mean unconfirmed effects, not permission to repeat the action.

## Production recovery contract

`packages/core/src/runtime/restart-recovery.ts` guards boot recovery with the existing kernel-owned SQLite file lock (`runtime-recovery.lock.db`); a live holder is not recovered by another runtime. The OS releases it on process death, including SIGKILL, and normal teardown releases only its own handle. This is coordination infrastructure, not a user setting, feature flag, PID lease or new supervisor.

For ordinary chat/task sessions left running, boot clears the obsolete active writer claim, appends non-success interrupted results for unmatched tool calls, records `failed/process_interrupted`, and blocks implicit continuation of the old run. Approved pauses keep their interrupt checkpoint and approval decisions; only the predecessor's active WAL claim is cleared so public input can proceed, and an explicit kernel resume reclaims its checkpoint writer ID. Saved results and terminal outcomes are preserved. Bot queue and delegated-child recovery keep their own protocols.

Multiprocess repair compatibility: paused kernels now release their execution claim while preserving the checkpoint; each resume uses a fresh nonce rather than reusing checkpoint authorization. Startup recovery also checks per-run OS-held writer liveness so acquiring boot ownership does not invalidate a live peer. These protections are exercised by the separate concurrency verifier; this restart verifier retains its sequential-process scope and all original criteria.
