import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-backup-"));
  const handles = [];
  t.after(() => {
    for (const db of handles) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const db = new DatabaseSync(join(stateDir, "runtime.sqlite"));
  handles.push(db);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(30); CREATE TABLE tasks(id TEXT PRIMARY KEY,budget INTEGER,result TEXT); INSERT INTO tasks VALUES('accepted',8,'unknown'); CREATE TABLE auth_records(id TEXT,scope TEXT); INSERT INTO auth_records VALUES('grant','one-repo')",
  );
  mkdirSync(join(stateDir, "images"));
  writeFileSync(
    join(stateDir, "images", "asset.bin"),
    Buffer.from([0, 1, 2, 3]),
  );
  return {
    root,
    stateDir,
    db,
    handles,
    ...(await import("../release/state-backup.mjs")),
  };
}
test("isolated backup restores real WAL database, grants, budgets and attached files without touching source [AC:multi-machine-local-foundation#AC-5] [AC:multi-machine-production-readiness#AC-15]", async (t) => {
  const f = await setup(t);
  const backupDir = join(f.root, "backup"),
    targetDir = join(f.root, "restore");
  const proof = await f.createStateBackup({
    stateDir: f.stateDir,
    backupDir,
    candidate: "a".repeat(40),
  });
  f.db.exec("INSERT INTO tasks VALUES('after-cutoff',1,'merged')");
  const restored = await f.restoreStateBackup({
    backupDir,
    targetDir,
    expectedDigest: proof.digest,
    expectedCandidate: "a".repeat(40),
    maxAgeMs: 3600000,
  });
  assert.equal(restored.ok, true);
  assert.ok(restored.elapsedMs < 900000);
  const db = new DatabaseSync(join(targetDir, "runtime.sqlite"), {
    readOnly: true,
  });
  f.handles.push(db);
  assert.deepEqual(
    { ...db.prepare("SELECT * FROM tasks WHERE id='accepted'").get() },
    { id: "accepted", budget: 8, result: "unknown" },
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").get().n, 1);
  assert.equal(
    db.prepare("SELECT scope FROM auth_records").get().scope,
    "one-repo",
  );
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tasks").get().n, 2);
  assert.deepEqual(
    readFileSync(join(targetDir, "images", "asset.bin")),
    Buffer.from([0, 1, 2, 3]),
  );
});
test("corrupt or expired backup never overwrites source or an existing target [AC:multi-machine-local-foundation#AC-5] [AC:multi-machine-production-readiness#AC-16]", async (t) => {
  const f = await setup(t);
  const backupDir = join(f.root, "backup"),
    targetDir = join(f.root, "existing");
  const p = await f.createStateBackup({
    stateDir: f.stateDir,
    backupDir,
    candidate: "a".repeat(40),
  });
  mkdirSync(targetDir);
  writeFileSync(join(targetDir, "keep"), "original");
  await assert.rejects(() =>
    f.restoreStateBackup({
      backupDir,
      targetDir,
      expectedDigest: p.digest,
      expectedCandidate: "a".repeat(40),
      maxAgeMs: 3600000,
    }),
  );
  assert.equal(readFileSync(join(targetDir, "keep"), "utf8"), "original");
  writeFileSync(join(backupDir, "images", "asset.bin"), "tampered");
  const other = join(f.root, "corrupt-restore");
  await assert.rejects(() =>
    f.restoreStateBackup({
      backupDir,
      targetDir: other,
      expectedDigest: p.digest,
      expectedCandidate: "a".repeat(40),
      maxAgeMs: 3600000,
    }),
  );
  assert.equal(existsSync(other), false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM tasks").get().n, 1);
});
test("cross-candidate, expired, nested and symlinked backup inputs are refused [AC:multi-machine-production-readiness#AC-4]", async (t) => {
  const f = await setup(t);
  const backupDir = join(f.root, "backup");
  const p = await f.createStateBackup({
    stateDir: f.stateDir,
    backupDir,
    candidate: "a".repeat(40),
    now: Date.parse("2026-10-19T00:00:00Z"),
  });
  for (const patch of [
    { expectedCandidate: "b".repeat(40) },
    { now: Date.parse("2026-10-20T00:00:00Z") },
  ])
    await assert.rejects(() =>
      f.restoreStateBackup({
        backupDir,
        targetDir: join(f.root, "reject"),
        expectedDigest: p.digest,
        expectedCandidate: "a".repeat(40),
        maxAgeMs: 3600000,
        now: Date.parse("2026-10-19T00:30:00Z"),
        ...patch,
      }),
    );
  await assert.rejects(() =>
    f.createStateBackup({
      stateDir: f.stateDir,
      backupDir: join(f.stateDir, "nested"),
      candidate: "a".repeat(40),
    }),
  );
  symlinkSync("/etc/passwd", join(f.stateDir, "unsafe"));
  await assert.rejects(() =>
    f.createStateBackup({
      stateDir: f.stateDir,
      backupDir: join(f.root, "symlink-backup"),
      candidate: "a".repeat(40),
    }),
  );
});
test("content identity survives SQLite backup layout but detects data-only budget/result changes", async (t) => {
  const f = await setup(t);
  const before = f.stateContentIdentity(f.stateDir),
    backupDir = join(f.root, "backup");
  await f.createStateBackup({
    stateDir: f.stateDir,
    backupDir,
    candidate: "a".repeat(40),
  });
  assert.deepEqual(f.stateContentIdentity(backupDir), before);
  f.db.exec("UPDATE tasks SET budget=7,result='merged' WHERE id='accepted'");
  assert.notEqual(
    f.stateContentIdentity(f.stateDir).fingerprint,
    before.fingerprint,
  );
});
test("content identity includes triggers, views, sequence state and persistent format pragmas", async (t) => {
  const f = await setup(t);
  let prior = f.stateContentIdentity(f.stateDir).fingerprint;
  for (const sql of [
    "CREATE TRIGGER deny_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'deny'); END",
    "CREATE VIEW task_view AS SELECT id FROM tasks",
    "CREATE INDEX task_idx ON tasks(id)",
    "PRAGMA user_version=4",
    "PRAGMA application_id=42",
    "CREATE TABLE ids(id INTEGER PRIMARY KEY AUTOINCREMENT)",
    "INSERT INTO ids DEFAULT VALUES",
    "DELETE FROM ids",
    "UPDATE sqlite_sequence SET seq=100 WHERE name='ids'",
  ]) {
    f.db.exec(sql);
    const next = f.stateContentIdentity(f.stateDir).fingerprint;
    assert.notEqual(next, prior, sql);
    prior = next;
  }
});
test("consistent snapshot preserves implicit rowids including gaps", async (t) => {
  const f = await setup(t);
  f.db.exec(
    "CREATE TABLE ordinal(value TEXT);INSERT INTO ordinal VALUES('one'),('two'),('three');DELETE FROM ordinal WHERE rowid=2",
  );
  const backupDir = join(f.root, "rowid-backup");
  await f.createStateBackup({
    stateDir: f.stateDir,
    backupDir,
    candidate: "a".repeat(40),
  });
  const db = new DatabaseSync(join(backupDir, "runtime.sqlite"), {
    readOnly: true,
  });
  f.handles.push(db);
  assert.deepEqual(
    db
      .prepare("SELECT rowid,value FROM ordinal ORDER BY rowid")
      .all()
      .map((r) => ({ ...r })),
    [
      { rowid: 1, value: "one" },
      { rowid: 3, value: "three" },
    ],
  );
});
test("content identity detects implicit rowid changes and handles shadowed aliases and WITHOUT ROWID", async (t) => {
  const f = await setup(t);
  f.db.exec(
    "CREATE TABLE ordinal(value TEXT);INSERT INTO ordinal VALUES('accepted');CREATE TABLE shadow(rowid TEXT,value TEXT);INSERT INTO shadow VALUES('visible','same');CREATE TABLE keyed(id TEXT PRIMARY KEY) WITHOUT ROWID;INSERT INTO keyed VALUES('one')",
  );
  let prior = f.stateContentIdentity(f.stateDir).fingerprint;
  for (const sql of [
    "UPDATE ordinal SET rowid=99",
    "UPDATE shadow SET _rowid_=100",
  ]) {
    f.db.exec(sql);
    const next = f.stateContentIdentity(f.stateDir).fingerprint;
    assert.notEqual(next, prior);
    prior = next;
  }
  f.db.exec(
    "CREATE TABLE generated(value TEXT,rowid TEXT GENERATED ALWAYS AS (value));INSERT INTO generated(value) VALUES('same')",
  );
  prior = f.stateContentIdentity(f.stateDir).fingerprint;
  f.db.exec("UPDATE generated SET _rowid_=99");
  assert.notEqual(f.stateContentIdentity(f.stateDir).fingerprint, prior);
  f.db.exec("CREATE TABLE hidden(rowid TEXT,_rowid_ TEXT,oid TEXT)");
  assert.throws(() => f.stateContentIdentity(f.stateDir), /rowid/i);
});
