import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  REQUIRED_GATES,
  signEvidenceReport,
  verifyReleaseEvidence,
} from "../bot-release/evidence-files.mjs";
import {
  readSchemaIdentity,
  sameStateIdentity,
} from "../release/state-identity.mjs";

function signedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "production-security-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 11),
    digest = (text) => createHash("sha256").update(text).digest("hex");
  const raw = "isolated synthetic collector output";
  writeFileSync(join(root, "raw.txt"), raw);
  const manifest = {
    candidate: "a".repeat(40),
    environment: "isolated-test",
    protocolHash: "b".repeat(64),
    runtimeFingerprint: "c".repeat(64),
    checks: [],
  };
  const reports = new Map();
  for (const gate of REQUIRED_GATES) {
    const report = {
      schemaVersion: 1,
      gate,
      candidate: manifest.candidate,
      environment: manifest.environment,
      protocolHash: manifest.protocolHash,
      runtimeFingerprint: manifest.runtimeFingerprint,
      collector: "ppeng-release-runner-v1",
      mode: ["live-model", "live-software"].includes(gate)
        ? "real"
        : "controlled",
      status: "passed",
      startedAt: "2026-10-18T09:00:00Z",
      completedAt: "2026-10-19T09:30:00Z",
      validUntil: "2026-10-20T09:30:00Z",
      measurements: {
        durationSeconds: 86400,
        warmupSeconds: 1800,
        fullProtocol: true,
        referenceHardwareMatched: true,
        sequences: 10000,
        consecutivePasses: 3,
        killRestart: true,
        retries: 0,
        trialsPerModel: 3,
        criticalRecall: 1,
        otherRecall: 0.95,
      },
      artifacts: [
        { path: "raw.txt", bytes: Buffer.byteLength(raw), sha256: digest(raw) },
      ],
    };
    reports.set(gate, report);
  }
  return {
    reports,
    verify() {
      manifest.checks = [...reports].map(([gate, report]) => {
        const text = JSON.stringify(signEvidenceReport(report, key));
        writeFileSync(join(root, gate + ".json"), text);
        return { gate, artifact: gate + ".json", sha256: digest(text) };
      });
      return verifyReleaseEvidence(manifest, {
        root,
        trustedKey: key,
        now: Date.parse("2026-10-19T10:00:00Z"),
      });
    },
  };
}

test("signed performance labels without measured latency or loss cannot authorize readiness [AC:multi-machine-production-readiness#AC-36]", (t) => {
  const fixture = signedFixture(t);
  fixture.reports.get("performance").measurements = {
    fullProtocol: true,
    referenceHardwareMatched: true,
  };
  const result = fixture.verify();
  assert.equal(
    result.ready,
    false,
    "authentication does not replace missing performance observations",
  );
  assert.ok(result.missing.includes("performance"));
});

test("signed soak duration without memory, queue, loss and drain observations cannot authorize readiness [AC:multi-machine-production-readiness#AC-38]", (t) => {
  const fixture = signedFixture(t);
  fixture.reports.get("soak").measurements = {
    fullProtocol: true,
    durationSeconds: 86400,
    warmupSeconds: 1800,
  };
  const result = fixture.verify();
  assert.equal(
    result.ready,
    false,
    "a signed duration alone does not prove the soak protocol",
  );
  assert.ok(result.missing.includes("soak"));
});

test("late schema writes cannot cross a held local recovery boundary [AC:multi-machine-local-foundation#AC-6]", async (t) => {
  const { mkdirSync } = await import("node:fs");
  const { ManagedStateWriter, withQuiescedWriter } =
    await import("../release/state-fence.mjs");
  const root = mkdtempSync(join(tmpdir(), "late-schema-")),
    stateDir = join(root, "state");
  mkdirSync(stateDir);
  const db = new DatabaseSync(join(stateDir, "runtime.sqlite"));
  db.exec(
    "PRAGMA busy_timeout=1;CREATE TABLE schema_version(version);INSERT INTO schema_version VALUES(30)",
  );
  const entrypoint = join(root, "writer.mjs");
  writeFileSync(entrypoint, "setInterval(()=>{},1000)");
  const writer = new ManagedStateWriter({ stateDir, entrypoint });
  t.after(async () => {
    await writer.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await writer.start();
  let unsafeDowngrade = false,
    blocked = false;
  await withQuiescedWriter(writer, async (lease) => {
    const original = readSchemaIdentity(db);
    queueMicrotask(() => {
      try {
        db.exec("CREATE TABLE late_candidate_migration(id INTEGER)");
      } catch {
        blocked = true;
      }
    });
    await Promise.resolve();
    lease.assertHeld();
    unsafeDowngrade = !sameStateIdentity(original, readSchemaIdentity(db));
  });
  assert.equal(blocked, true);
  assert.equal(unsafeDowngrade, false);
});
