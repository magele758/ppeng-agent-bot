#!/usr/bin/env node
import {linkHistoricalDependencies} from '../lib/package-manager.mjs';
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
import { sanitizeScriptEnv } from '../spawn-utils.mjs';

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
  { version: 23, ref: '57ecc35', note: 'resource_owners, before approvals expiry columns (v24)' },
  { version: 24, ref: '96d55dc', note: 'unattended approval expiry, before reliable Bot/history schemas (v25)' },
  { version: 25, ref: 'eaf1f44', note: 'reliable Bot work schemas, before saved face shape and color (v26)' },
  { version: 26, ref: '16bcceb', note: 'saved face shape and color, before routine leases and summary links (v27)' },
  { version: 27, ref: 'b9518b3', note: 'routine leases and summary links, before context stack snapshots (v28)' },
  { version: 28, ref: 'd0caa00', note: 'context stack snapshots, before bots.avatar (v29)' },
  { version: 29, ref: '1b4d428', note: 'bots.avatar, before bot_work_messages.source_room (v30)' },
  { version: 30, ref: 'decf8cfca70fabf81d22994f939594ae53664c0a', note: 'room work provenance, before queued steer attachment context (v31)' },
  { version: 31, ref: '831290374f1e5189b16084e14dc497a4230b5fa0', note: 'queued steer attachment context, before bot reply quote pointer (v32)' },
  { version: 32, ref: 'a0d12d79803dd7cb0a1a066ee2fc780b9f85f1c1', note: 'bot reply quote pointer, before durable memory deletion suppression (v33)' },
  { version: 33, ref: '71b7cf4a994a6b1c963419837e8638e53c09209b', note: 'durable memory deletion suppression, before bot face style and expression (v34)' },
  { version: 34, ref: '11afdca52697d8e963fad9cdc09d704e46ff6269', note: 'bot face style and expression, before host-owned message provenance (v35)' }
];

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: sanitizeScriptEnv() });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout.trim();
}

/**
 * Old checkout gets the host's third-party packages, but its own workspace
 * packages (@ppeng/*) must resolve inside the checkout, not to today's code.
 */
function linkNodeModules(checkout) { linkHistoricalDependencies(checkout, ROOT); }

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
