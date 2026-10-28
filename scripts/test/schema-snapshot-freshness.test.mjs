/**
 * Fail fast when LATEST_SCHEMA_VERSION advances without a prior-version snapshot.
 *
 * Full validation's unit coverage lane already catches this via
 * schema-migration-snapshots.test.mjs, but only after ~15 minutes. Keep the
 * registry (SNAPSHOT_REVISIONS), on-disk vN.sql, and LATEST in lockstep so
 * Quick gate / Core unit reject the drift before Full validation burns a run.
 *
 * [AC:schema-upgrade-safety#AC-1]
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_REVISIONS } from '../migration-fixtures/generate.mjs';
import { LATEST_SCHEMA_VERSION } from '../../packages/core/dist/stores/migrations/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(HERE, '../migration-fixtures/snapshots');

test('SNAPSHOT_REVISIONS covers the schema version right before LATEST [AC:schema-upgrade-safety#AC-1]', () => {
  assert.ok(SNAPSHOT_REVISIONS.length >= 4, 'expected a retained history of snapshots');
  const versions = SNAPSHOT_REVISIONS.map((r) => r.version);
  const previous = Math.max(...versions);
  assert.equal(
    previous,
    LATEST_SCHEMA_VERSION - 1,
    `schema is v${LATEST_SCHEMA_VERSION} but SNAPSHOT_REVISIONS tops out at v${previous}; ` +
      `add { version: ${LATEST_SCHEMA_VERSION - 1}, ref, note } and run ` +
      `node scripts/migration-fixtures/generate.mjs ${LATEST_SCHEMA_VERSION - 1}`
  );
  assert.ok(versions.includes(20), 'v20 remains a required historical snapshot');
  const sorted = [...versions].sort((a, b) => a - b);
  assert.deepEqual(versions, sorted, 'SNAPSHOT_REVISIONS must stay ordered by version');
});

test('on-disk snapshot SQL exists for every SNAPSHOT_REVISIONS entry and for LATEST-1 [AC:schema-upgrade-safety#AC-1]', () => {
  const files = new Set(readdirSync(SNAPSHOT_DIR).filter((f) => /^v\d+\.sql$/.test(f)));
  for (const { version } of SNAPSHOT_REVISIONS) {
    assert.ok(files.has(`v${version}.sql`), `missing scripts/migration-fixtures/snapshots/v${version}.sql`);
  }
  const need = LATEST_SCHEMA_VERSION - 1;
  assert.ok(
    existsSync(join(SNAPSHOT_DIR, `v${need}.sql`)),
    `missing v${need}.sql for LATEST=${LATEST_SCHEMA_VERSION}; regenerate via generate.mjs`
  );
});
