#!/usr/bin/env node
/**
 * Regenerate the schema snapshots in scripts/migration-fixtures/snapshots/.
 *
 *   node scripts/migration-fixtures/generate.mjs            all revisions
 *   node scripts/migration-fixtures/generate.mjs 20 19      only these schema versions
 *
 * For each pinned revision (the last commit whose LATEST_SCHEMA_VERSION was N):
 * detached `git worktree` → build packages/core there → seed.mjs writes a DB with
 * that revision's code → dump to vN.sql. Snapshots are committed; tests only load
 * them, so this runs when a new schema version needs a "previous version" snapshot.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dumpDatabase } from './sql-dump.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SNAPSHOT_DIR = join(HERE, 'snapshots');

/** Last commit at each schema version (v16–v18 never shipped alone: v19 landed with them). */
export const SNAPSHOT_REVISIONS = [
  { version: 14, ref: '6bdad1c', note: 'before bots roster (v15)' },
  { version: 15, ref: '9970779', note: 'bots roster, before memory profiles / goals / workspace (v16-v19)' },
  { version: 19, ref: '7335508', note: 'before oauth identities (v20)' },
  { version: 20, ref: '70f3982', note: 'before agent_memory.agent_id (v21); bots default to bypass' },
  { version: 21, ref: '9187946', note: 'agent_memory.agent_id added but old rows NULL; bots still default to bypass' },
  { version: 22, ref: '67ced21', note: 'legacy bot memory backfilled, before resource_owners (v23)' },
  { version: 23, ref: '57ecc35', note: 'resource_owners, before approvals expiry columns (v24)' }
];

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

/**
 * Old checkout gets the host's third-party packages, but its own workspace
 * packages (@ppeng/*) must resolve inside the checkout, not to today's code.
 */
function linkNodeModules(checkout) {
  const dest = join(checkout, 'node_modules');
  mkdirSync(join(dest, '@ppeng'), { recursive: true });
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry === '@ppeng' || entry === '.bin') continue;
    symlinkSync(join(ROOT, 'node_modules', entry), join(dest, entry));
  }
  for (const pkg of readdirSync(join(ROOT, 'node_modules/@ppeng'))) {
    symlinkSync(readlinkSync(join(ROOT, 'node_modules/@ppeng', pkg)), join(dest, '@ppeng', pkg));
  }
}

function generate({ version, ref, note }) {
  const sha = run('git', ['rev-parse', ref], ROOT);
  const checkout = mkdtempSync(join(tmpdir(), `schema-v${version}-`));
  rmSync(checkout, { recursive: true });
  run('git', ['worktree', 'add', '--detach', checkout, sha], ROOT);
  try {
    linkNodeModules(checkout);
    run(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-b', 'packages/core'], checkout);
    const dbFile = join(checkout, 'seed-state', 'state.sqlite');
    const seeded = JSON.parse(run(process.execPath, [join(HERE, 'seed.mjs'), checkout, dbFile], checkout));
    if (seeded.version !== version) {
      throw new Error(`revision ${ref} seeded schema v${seeded.version}, expected v${version}`);
    }
    const db = new DatabaseSync(dbFile);
    const sql = dumpDatabase(db, [
      `schema v${version} snapshot: ${note}`,
      `seeded from ${sha} by scripts/migration-fixtures/generate.mjs (regenerate, do not edit)`,
      `seed ids: ${JSON.stringify(seeded)}`
    ]);
    db.close();
    writeFileSync(join(SNAPSHOT_DIR, `v${version}.sql`), sql);
    console.log(`[schema-snapshots] v${version} <- ${sha.slice(0, 12)} (${sql.length} bytes)`);
  } finally {
    run('git', ['worktree', 'remove', '--force', checkout], ROOT);
    if (existsSync(checkout)) rmSync(checkout, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = new Set(process.argv.slice(2).map(Number));
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const rev of SNAPSHOT_REVISIONS) {
    if (only.size === 0 || only.has(rev.version)) generate(rev);
  }
}
