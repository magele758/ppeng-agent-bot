import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-fence-")),
    stateDir = join(root, "state");
  mkdirSync(stateDir);
  const db = new DatabaseSync(join(stateDir, "runtime.sqlite"));
  db.exec(
    "CREATE TABLE schema_version(version); INSERT INTO schema_version VALUES(30); CREATE TABLE tasks(id TEXT,budget INTEGER); INSERT INTO tasks VALUES('accepted',8)",
  );
  db.close();
  const entrypoint = join(root, "writer.mjs");
  writeFileSync(
    entrypoint,
    "setInterval(()=>{},1000); process.send?.('ready')",
  );
  const api = await import("../release/state-fence.mjs");
  const writer = new api.ManagedStateWriter({ stateDir, entrypoint });
  t.after(async () => {
    await writer.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    stateDir,
    writer,
    ...api,
    ...(await import("../release/state-backup.mjs")),
  };
}
test("real writer is stopped and cannot restart or write SQLite while recovery fence holds [AC:multi-machine-local-foundation#AC-6]", async (t) => {
  const f = await setup(t);
  await f.writer.start();
  assert.ok(f.writer.running);
  await f.withQuiescedWriter(f.writer, async (lease) => {
    assert.equal(f.writer.running, false);
    lease.assertHeld();
    await assert.rejects(() => f.writer.start(), /fenc|pending/i);
    const db = new DatabaseSync(join(f.stateDir, "runtime.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout=1");
      assert.throws(() => db.exec("UPDATE tasks SET budget=0"), /locked|busy/);
    } finally {
      db.close();
    }
    const p = await f.createStateBackup({
      stateDir: f.stateDir,
      backupDir: join(f.root, "backup"),
      candidate: "a".repeat(40),
      fence: lease,
    });
    const restored = await f.restoreStateBackup({
      backupDir: p.backupDir,
      targetDir: join(f.root, "restored"),
      expectedCandidate: p.candidate,
      expectedDigest: p.digest,
      maxAgeMs: 3600000,
    });
    assert.equal(restored.ok, true);
    lease.assertHeld();
  });
});
test("tampered fence ownership or live writer claims cannot authorize recovery [AC:multi-machine-local-foundation#AC-6]", async (t) => {
  const f = await setup(t);
  await f.writer.start();
  let activated = false;
  await assert.rejects(() =>
    f.withQuiescedWriter(f.writer, async (lease) => {
      writeFileSync(f.stateDir + ".recovery-lock", "changed");
      lease.assertHeld();
      activated = true;
    }),
  );
  assert.equal(activated, false);
  await assert.rejects(() => f.writer.start(), /pending|fenc/i);
});
test("factory recovery needs an owned native writer, not a supplied boolean or pid [AC:multi-machine-local-foundation#AC-7]", async (t) => {
  const f = await setup(t);
  await assert.rejects(() =>
    f.withQuiescedWriter({ stopped: true, pid: process.pid }, async () => {
      throw Error("must not activate");
    }),
  );
  assert.equal(existsSync(f.stateDir + ".recovery-lock"), false);
});
test("isolated recovery switches only after real writer exit and preserves state on data changes or activation failure [AC:multi-machine-local-foundation#AC-6]", async (t) => {
  const f = await setup(t);
  await f.writer.start();
  let p, identity;
  await f.withQuiescedWriter(f.writer, async (fence) => {
    identity = f.stateContentIdentity(f.stateDir).fingerprint;
    p = await f.createStateBackup({
      stateDir: f.stateDir,
      backupDir: join(f.root, "backup"),
      candidate: "a".repeat(40),
      fence,
    });
  });
  let activated = 0;
  const r = await f.recoverIsolatedState({
    writer: f.writer,
    backupDir: p.backupDir,
    targetDir: join(f.root, "restored"),
    expectedDigest: p.digest,
    expectedCandidate: p.candidate,
    expectedContentFingerprint: identity,
    activate: async (dir) => {
      assert.equal(f.writer.running, false);
      const db = new DatabaseSync(join(dir, "runtime.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(db.prepare("SELECT budget FROM tasks").get().budget, 8);
      } finally {
        db.close();
      }
      activated++;
      return { ok: true };
    },
    probe: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.productionRollbackAuthorized, false);
  assert.equal(activated, 1);
  const db = new DatabaseSync(join(f.stateDir, "runtime.sqlite"));
  db.exec("UPDATE tasks SET budget=7");
  db.close();
  const rejected = await f.recoverIsolatedState({
    writer: f.writer,
    backupDir: p.backupDir,
    targetDir: join(f.root, "reject"),
    expectedDigest: p.digest,
    expectedCandidate: p.candidate,
    expectedContentFingerprint: identity,
    activate: async () => {
      activated++;
      return { ok: true };
    },
    probe: async () => true,
  });
  assert.equal(rejected.stage, "RECOVERY_PENDING");
  assert.equal(activated, 1);
  assert.equal(existsSync(join(f.root, "reject")), false);
  await assert.rejects(() => f.writer.start(), /pending|fenc/i);
});
test("new local preparation does not disable the existing A/B promotion policy [AC:multi-machine-local-foundation#AC-7]", async () => {
  const { promoteWithRollback } =
    await import("../release/promotion-policy.mjs");
  let changed = 0;
  const images = (d) => ({
    daemon: "sha256:" + d.repeat(64),
    web: "sha256:" + d.repeat(64),
  });
  const r = await promoteWithRollback({
    candidateImages: images("a"),
    previousImages: images("b"),
    candidateSchema: 30,
    stableSchema: 30,
    activate: async () => {
      changed++;
      return { ok: true };
    },
    probe: async () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(changed, 1);
});
test("same-candidate old snapshot cannot replace newer accepted budgets during isolated recovery [AC:multi-machine-local-foundation#AC-6]", async (t) => {
  const f = await setup(t);
  let p;
  await f.withQuiescedWriter(f.writer, async (fence) => {
    p = await f.createStateBackup({
      stateDir: f.stateDir,
      backupDir: join(f.root, "old"),
      candidate: "a".repeat(40),
      fence,
    });
  });
  const db = new DatabaseSync(join(f.stateDir, "runtime.sqlite"));
  db.exec("UPDATE tasks SET budget=7");
  db.close();
  let activated = false;
  const r = await f.recoverIsolatedState({
    writer: f.writer,
    backupDir: p.backupDir,
    targetDir: join(f.root, "old-restore"),
    expectedCandidate: p.candidate,
    expectedDigest: p.digest,
    expectedContentFingerprint: f.stateContentIdentity(f.stateDir).fingerprint,
    activate: async () => {
      activated = true;
      return { ok: true };
    },
    probe: async () => true,
  });
  assert.equal(activated, false);
  assert.equal(r.stage, "RECOVERY_PENDING");
  const check = new DatabaseSync(join(f.stateDir, "runtime.sqlite"), {
    readOnly: true,
  });
  try {
    assert.equal(check.prepare("SELECT budget FROM tasks").get().budget, 7);
  } finally {
    check.close();
  }
});
test("naturally exited owned writer releases its registration and cannot leave a reused process-group identity", async (t) => {
  const f = await setup(t),
    entrypoint = join(f.root, "exit.mjs");
  writeFileSync(entrypoint, "process.exit(0)");
  const writer = new f.ManagedStateWriter({ stateDir: f.stateDir, entrypoint });
  await writer.start();
  if (writer.child.exitCode === null && writer.child.signalCode === null)
    await new Promise((resolve) => writer.child.once("exit", resolve));
  assert.equal(writer.running, false);
  await writer.start();
  await writer.stop();
});
test("owned rehearsal writer cannot create detached descendants or worker threads", async (t) => {
  const f = await setup(t);
  const entrypoint = join(f.root, "escape.mjs");
  writeFileSync(
    entrypoint,
    `import {spawn} from 'node:child_process';import {Worker} from 'node:worker_threads';
const results=[];
try {const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); c.kill(); results.push('spawn-allowed');} catch(e){results.push(e.code);}
try {const w=new Worker('setInterval(()=>{},1000)',{eval:true});w.terminate();results.push('worker-allowed');}catch(e){results.push(e.code);}
process.send(results);setInterval(()=>{},1000);`,
  );
  const writer = new f.ManagedStateWriter({ stateDir: f.stateDir, entrypoint });
  t.after(() => writer.stop());
  await writer.start();
  const results = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("missing writer result")),
      3000,
    );
    writer.child.once("message", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.deepEqual(results, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
  await f.withQuiescedWriter(writer, (lease) => lease.assertHeld());
});
