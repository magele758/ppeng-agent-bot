import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boot } from "./helpers/bot-http-fixture.mjs";
import {
  createStateBackup,
  restoreStateBackup,
  stateContentIdentity,
} from "../release/state-backup.mjs";

test("actual runtime schema, production records and authorization tables survive isolated backup [AC:multi-machine-local-foundation#AC-5]", async (t) => {
  const f = await boot(),
    root = mkdtempSync(join(tmpdir(), "actual-runtime-backup-"));
  t.after(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  const defaults = (
    await f.call("alice", "GET", "/api/factory/production/settings")
  ).body.settings;
  const saved = await f.call(
    "alice",
    "PATCH",
    "/api/factory/production/settings",
    {
      ...defaults,
      repository: "owner/approved-local",
      maxRounds: 8,
      maxCostUsd: 20,
    },
  );
  assert.equal(saved.status, 200);
  const created = await f.call(
    "alice",
    "POST",
    "/api/factory/production/runs",
    {
      requestKey: "snapshot-real-store",
      expectedRevision: saved.body.settings.revision,
    },
  );
  assert.equal(created.status, 201);
  const source = dirname(f.runtime.store.dbPath),
    expected = stateContentIdentity(source);
  const proof = await createStateBackup({
    stateDir: source,
    backupDir: join(root, "backup"),
    candidate: "a".repeat(40),
  });
  const targetDir = join(root, "restored");
  await restoreStateBackup({
    backupDir: proof.backupDir,
    targetDir,
    expectedDigest: proof.digest,
    expectedCandidate: proof.candidate,
    maxAgeMs: 3600000,
  });
  assert.deepEqual(stateContentIdentity(targetDir), expected);
  const db = new DatabaseSync(join(targetDir, "runtime.sqlite"), {
    readOnly: true,
  });
  try {
    const run = JSON.parse(
      db
        .prepare("SELECT data FROM factory_production_runs WHERE id=?")
        .get(created.body.run.id).data,
    );
    assert.equal(run.settings.maxRounds, 8);
    assert.equal(run.settings.maxCostUsd, 20);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM memberships").get().n,
      f.runtime.store.db.prepare("SELECT COUNT(*) n FROM memberships").get().n,
    );
  } finally {
    db.close();
  }
});
