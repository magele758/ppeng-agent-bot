---
name: verify-session-concurrency
description: Run bounded multiprocess session verification for writer contention, stale callbacks and concurrent approval recovery. Preserve failures and request separate repair acceptance before product changes.
---

# Multiprocess session verification

Run `pnpm run test:concurrency` from the repository root. Requires Node >=22 with SQLite FTS5, installed dependencies and TypeScript 5.9.3. No real model key or host .env is loaded. No new product flags/settings are introduced.

## Execution and evidence

- `concurrency-model.mjs` exhausts an independent finite design model: two concurrent processes, two ownership generations, two approvals and two tools in chat/task modes. Counterexamples can be replayed. This is not TLC or a proof over arbitrary schedules.
- `concurrency-runtime.mjs` starts actual simultaneous OS processes constructing production RawAgentRuntime against the same temporary SQLite database. Each scenario checks distinct PIDs and overlapping liveness. Normal runtime/store methods create all product state; the supervisor does not write SQL or reconstruct lifecycle state. External model/tool I/O is controlled and independently logged. Cancellation deliberately leaves some already dispatched I/O delayed, so stale callbacks can actually arrive after a new writer starts.
- The ESM loader adds observation-only synchronous barriers at writer claim/release and approval-decision persistence boundaries. These barriers pause scheduling, emit IPC evidence and await a parent-controlled file token; they neither supply policy nor alter arguments/return values. Fixed release order makes both contenders observe the intended phase without relying on a lucky race. The original loaded code, rather than a substitute algorithm, makes all decisions. Missing anchors, readiness, barriers, timeout or process failure are incomplete evidence.
- Snapshots record normalized durable identities, ownership, status/outcome, interrupt, approvals, transcript sequence and controlled I/O/model views. Parent event order and barrier acknowledgements accompany each case. Random IDs/timestamps and actual PID numbers are normalized for repeatability only after identity/liveness checks on raw data.
- Three isolated product-source mutations bypass the live-writer admission guard, disable conditional release of another writer, and duplicate approval continuation. Each needs a completed green baseline, an actual loaded mutation and a newly failing case. Existing failures do not count. Sources on disk are fingerprinted before/after and never edited by mutation; restored baseline must match exactly.
- The combined command also runs restart verification, which includes lifecycle and pairing. Existing acceptance criteria and verification gates are preserved. All must pass before overall success.

## Gates and review

Reports: `coverage/formal/concurrency/report.json` and `report.md`, or `pnpm run test:concurrency --out <directory>`. Exit 0 means completed, reviewed and all green; exit 1 means actual mismatch or source review required; exit 2 means incomplete evidence. CI has an explicit no-retry command and uploads evidence even after failure. The formal regression command includes this gate.

Read `specs/formal/concurrency-review.json` to review mappings and every changed source path. Observe `needs-review` before updating SHA-256 hashes. Explain reviewed changes, rerun actual probes and mutations, and refresh overlapping older gate metadata only after reviewing those shared changes. Hash changes are not proof. Keep the approved verification standard `approved` while product counterexamples remain; never mark it implemented using only checker/model self-tests.

For a new product defect, preserve the real-process trace, affected AC IDs and expected/actual state; follow `skills/acceptance-first/SKILL.md` to draft separate repair criteria and wait for user confirmation. Do not silently fix product behavior or weaken standards.

## Limits

Healthy same-host local database and ordinary chat/task sessions; bounded controlled schedules, unexpired approvals, finite tools and ownership generations. No multi-host/network filesystem, partitions, power loss, corrupt DB, schema migration, Bot-specific queues, independent schedulers, full daemon HTTP/UI or real upstream reliability. Saved tool results must not replay; unconfirmed external effects are unknown and cannot be rolled back or guaranteed exactly once by this checker. No forced takeover of a valid live owner is authorized.

## Approved production repair

The independent five-criterion repair uses a fresh execution nonce, SQLite compare/update and per-run kernel-owned lock files under writer-locks/. Locks prove liveness without PID leases or user settings; a new boot owner skips a live peer, while dead peer ownership can be reclaimed. Closing the main store closes its auxiliary handles. Generation-bound ALS in the Node store fences state and WAL writes even after an old claim becomes empty. Both SDK and reference kernels await outcome handling before releasing; rejected contenders preserve the active controller. Optional host ports keep mini free of Node imports.

Approval decisions, state and one continuation message commit in one SQLite transaction. The paused checkpoint remains, while its execution claim is released; explicit restoration gets a fresh nonce and re-reads the checkpoint before doing work. Cancellation also covers all-decided-but-not-yet-resumed pauses, and the daemon requires a current uncancelled checkpoint to continue. Tool dispatch checks cancellation/authorization between chunks and before execution. Stream delivery also rejects revoked generations. Already dispatched external effects are not guaranteed reversible or exactly once.

62 real-process scenarios include a new boot owner observing a live peer, a dead non-boot writer handing off while another boot owner lives, stale traces, and explicit fresh work after cancel followed by repeated old approval. The original 58-scenario red evidence remains in doc/formal/.
