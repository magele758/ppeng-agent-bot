# Full validation: schema snapshot drift (2026-10-28)

## Failing job
`Full validation` → reusable `Release gate` → **Functional unit tests + coverage**
(`Run unit coverage lane`), then cascading **Acceptance criteria gate** and
**Main release gate**.

## Root cause
`LATEST_SCHEMA_VERSION` advanced to **35** (host-owned message provenance) while
`scripts/migration-fixtures/snapshots/` and `SNAPSHOT_REVISIONS` still topped out
at **v33**. Unit coverage then failed deterministically on both first run and
isolated retry:

- `snapshots cover the last schema versions, including the one right before latest`
  (`35-1=34` missing)
- `real v24 ownerless Bot/cron upgrade...` asserted `LATEST_SCHEMA_VERSION === 34`
  while runtime reported `35`

Not a flake (timeout/OOM/race). Same class as earlier
`fix(ci): repair schema and roster fixtures` / `test: cover schema v34...`.

## Immediate fix already on main
`6e43c76c` added `v34.sql` + registry entry and bumped the rollback pin to 35.
Subsequent main Full validation runs after that commit went green.

## Stabilization in this change
1. Fast `scripts/test/schema-snapshot-freshness.test.mjs` keeps
   `SNAPSHOT_REVISIONS`, on-disk `vN.sql`, and `LATEST` locked together.
2. Quick gate runs that test right after `build-workspace` so drift fails in
   seconds, not after the ~15m unit coverage lane.
3. Rollback test no longer hardcodes `35`; it requires
   `max(SNAPSHOT_REVISIONS) === LATEST - 1`.
4. Full snapshot suite also asserts the registry matches on-disk files.

## Operator checklist when bumping schema
1. Land the migration that raises `LATEST_SCHEMA_VERSION` to N.
2. Append `{ version: N-1, ref, note }` to `SNAPSHOT_REVISIONS` (ref = last
   commit whose LATEST was N-1).
3. `node scripts/migration-fixtures/generate.mjs N-1`
4. Confirm Quick gate / `schema-snapshot-freshness` is green before merge.
