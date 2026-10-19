import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sanitizeScriptEnv } from "../spawn-utils.mjs";
const candidate = "a".repeat(40),
  protocolHash = "b".repeat(64),
  runtimeFingerprint = "c".repeat(64),
  key = Buffer.alloc(32, 9),
  now = Date.parse("2026-10-19T10:00:00Z");
async function fixture(t) {
  const api = await import("../bot-release/evidence-files.mjs");
  const root = mkdtempSync(join(tmpdir(), "production-proof-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = Buffer.from("actual test output\n");
  writeFileSync(join(root, "raw.txt"), raw);
  const manifest = {
    candidate,
    environment: "local-test",
    protocolHash,
    runtimeFingerprint,
    checks: [],
  };
  const reports = new Map();
  for (const gate of api.REQUIRED_GATES) {
    const report = {
      schemaVersion: 1,
      gate,
      candidate,
      environment: "local-test",
      protocolHash,
      runtimeFingerprint,
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
        dedicated: true,
        ssdVerified: true,
        cpuCores: 4,
        memoryGiB: 8,
        bots: 50,
        historyRows: 1000000,
        precompressed: false,
        clients: 20,
        readRps: 40,
        topWorkRps: 2,
        measurementSeconds: 900,
        pageP95Ms: 500,
        statusP95Ms: 500,
        receiveP95Ms: 500,
        searchP95Ms: 1000,
        firstScreenP95Ms: 2000,
        lostWork: 0,
        duplicateEffects: 0,
        unexplainedFailures: 0,
        falseCompletions: 0,
        drainSeconds: 120,
        continuous: true,
        missingSamples: 0,
        hourlyBursts: 24,
        burstSeconds: 60,
        burstTopWorkRps: 20,
        halfHourWindows: 48,
        maxRssP95Ratio: 1.2,
        maxConsecutiveWorseningQueueHours: 2,
        models: [
          {
            id: "test-model",
            trials: Array.from({ length: 3 }, () => ({
              turns: 200,
              compactions: 12,
              facts: 100,
              criticalRecall: 1,
              otherRecall: 0.95,
            })),
          },
        ],
        connections: [
          {
            id: "test-software",
            read: true,
            write: true,
            approval: true,
            resultVerified: true,
          },
        ],
        sequences: 10000,
        consecutivePasses: 3,
        killRestart: true,
        retries: 0,
        trialsPerModel: 3,
        criticalRecall: 1,
        otherRecall: 0.95,
      },
      artifacts: [
        {
          path: "raw.txt",
          bytes: raw.length,
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
      ],
    };
    reports.set(gate, report);
  }
  function save(gate) {
    const text = JSON.stringify(api.signEvidenceReport(reports.get(gate), key));
    writeFileSync(join(root, gate + ".json"), text);
    const check = {
      gate,
      candidate,
      status: "passed",
      artifact: gate + ".json",
      sha256: createHash("sha256").update(text).digest("hex"),
    };
    const i = manifest.checks.findIndex((c) => c.gate === gate);
    if (i < 0) manifest.checks.push(check);
    else manifest.checks[i] = check;
  }
  for (const gate of reports.keys()) save(gate);
  return {
    ...api,
    root,
    manifest,
    reports,
    save,
    verify: () =>
      api.verifyReleaseEvidence(manifest, { root, trustedKey: key, now }),
  };
}
test("unsigned passed labels cannot authorize the release CLI [AC:multi-machine-production-readiness#AC-35] [AC:multi-machine-production-readiness#AC-40]", (t) => {
  const root = mkdtempSync(join(tmpdir(), "unsigned-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gates = [
    "build",
    "unit",
    "integration",
    "browser",
    "faults",
    "migration-rollback",
    "performance",
    "soak",
    "live-model",
    "live-software",
    "acceptance",
    "crap",
  ];
  const file = join(root, "manifest.json");
  writeFileSync(
    file,
    JSON.stringify({
      candidate,
      checks: gates.map((gate) => ({
        gate,
        candidate,
        status: "passed",
        artifact: "missing.json",
        durationSeconds: 86400,
        warmupSeconds: 1800,
        fullProtocol: true,
        referenceHardwareMatched: true,
        dedicated: true,
        ssdVerified: true,
        cpuCores: 4,
        memoryGiB: 8,
        bots: 50,
        historyRows: 1000000,
        precompressed: false,
        clients: 20,
        readRps: 40,
        topWorkRps: 2,
        measurementSeconds: 900,
        pageP95Ms: 500,
        statusP95Ms: 500,
        receiveP95Ms: 500,
        searchP95Ms: 1000,
        firstScreenP95Ms: 2000,
        lostWork: 0,
        duplicateEffects: 0,
        unexplainedFailures: 0,
        falseCompletions: 0,
        drainSeconds: 120,
        continuous: true,
        missingSamples: 0,
        hourlyBursts: 24,
        burstSeconds: 60,
        burstTopWorkRps: 20,
        halfHourWindows: 48,
        maxRssP95Ratio: 1.2,
        maxConsecutiveWorseningQueueHours: 2,
        models: [
          {
            id: "test-model",
            trials: Array.from({ length: 3 }, () => ({
              turns: 200,
              compactions: 12,
              facts: 100,
              criticalRecall: 1,
              otherRecall: 0.95,
            })),
          },
        ],
        connections: [
          {
            id: "test-software",
            read: true,
            write: true,
            approval: true,
            resultVerified: true,
          },
        ],
        sequences: 10000,
        consecutivePasses: 3,
        killRestart: true,
        retries: 0,
        trialsPerModel: 3,
        criticalRecall: 1,
        otherRecall: 1,
      })),
    }),
  );
  const r = spawnSync(
    process.execPath,
    ["scripts/bot-release/evidence.mjs", file],
    { env: sanitizeScriptEnv(), encoding: "utf8" },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.equal(JSON.parse(r.stdout).ready, false);
});
test("verified synthetic artifacts pass file checks but cannot authorize production [AC:multi-machine-local-foundation#AC-8]", async (t) => {
  const f = await fixture(t);
  assert.equal(f.verify().artifactChecksPassed, true);
  assert.equal(f.verify().ready, false);
  assert.equal(f.verify().authoritative, false);
});
test("tampered raw artifacts invalidate signed summaries [AC:multi-machine-production-readiness#AC-35]", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "raw.txt"), "modified output");
  assert.equal(f.verify().ready, false);
  assert.equal(f.verify().missing.length, 12);
});
test("report hash and collector signature are independently required [AC:multi-machine-production-readiness#AC-35]", async (t) => {
  const f = await fixture(t);
  f.manifest.checks[0].sha256 = "f".repeat(64);
  assert.ok(f.verify().missing.includes("build"));
  f.save("build");
  const unsigned = { ...f.reports.get("build"), signature: "0".repeat(64) };
  const text = JSON.stringify(unsigned);
  writeFileSync(join(f.root, "build.json"), text);
  f.manifest.checks[0].sha256 = createHash("sha256").update(text).digest("hex");
  assert.ok(f.verify().missing.includes("build"));
});
test("cross-candidate, environment, protocol and runtime evidence is rejected [AC:multi-machine-production-readiness#AC-8] [AC:multi-machine-production-readiness#AC-35]", async (t) => {
  const f = await fixture(t);
  for (const field of [
    "candidate",
    "environment",
    "protocolHash",
    "runtimeFingerprint",
  ]) {
    const old = f.reports.get("build")[field];
    f.reports.get("build")[field] = "another";
    f.save("build");
    assert.ok(f.verify().missing.includes("build"), field);
    f.reports.get("build")[field] = old;
    f.save("build");
  }
});
test("expiry, impossible future times and missing full-duration windows cannot become ready [AC:multi-machine-production-readiness#AC-38]", async (t) => {
  const f = await fixture(t);
  const r = f.reports.get("soak");
  r.validUntil = "2026-10-19T09:59:00Z";
  f.save("soak");
  assert.ok(f.verify().missing.includes("soak"));
  r.validUntil = "2026-10-20T09:30:00Z";
  r.startedAt = "2026-10-19T09:00:00Z";
  f.save("soak");
  assert.ok(f.verify().missing.includes("soak"));
  r.startedAt = "2026-10-18T09:00:00Z";
  r.completedAt = "2026-10-20T09:00:00Z";
  f.save("soak");
  assert.ok(f.verify().missing.includes("soak"));
});
test("manifest claims cannot overwrite signed measurements [AC:multi-machine-production-readiness#AC-13] [AC:multi-machine-production-readiness#AC-36] [AC:multi-machine-production-readiness#AC-37]", async (t) => {
  const f = await fixture(t);
  for (const [gate, patch] of [
    ["performance", { referenceHardwareMatched: false }],
    ["faults", { sequences: 9999 }],
    ["browser", { retries: 1 }],
  ]) {
    Object.assign(f.reports.get(gate).measurements, patch);
    f.save(gate);
    Object.assign(
      f.manifest.checks.find((c) => c.gate === gate),
      { referenceHardwareMatched: true, sequences: 10000, retries: 0 },
    );
    assert.ok(f.verify().missing.includes(gate));
  }
});
test("simulated models and reduced recall cannot pass real-model evidence [AC:multi-machine-production-readiness#AC-39]", async (t) => {
  const f = await fixture(t);
  f.reports.get("live-model").mode = "controlled";
  f.save("live-model");
  assert.ok(f.verify().missing.includes("live-model"));
  f.reports.get("live-model").mode = "real";
  f.reports.get("live-model").measurements.otherRecall = 0.94;
  f.save("live-model");
  assert.ok(f.verify().missing.includes("live-model"));
});
test("artifact traversal, absolute files and symlinks never authorize evidence [AC:multi-machine-production-readiness#AC-4] [AC:multi-machine-production-readiness#AC-35]", async (t) => {
  const f = await fixture(t);
  const original = f.manifest.checks[0].artifact;
  for (const path of ["../secret.json", "/etc/passwd", ".env"]) {
    f.manifest.checks[0].artifact = path;
    assert.ok(f.verify().missing.includes("build"));
  }
  f.manifest.checks[0].artifact = original;
  symlinkSync(join(f.root, "raw.txt"), join(f.root, "link"));
  f.reports.get("build").artifacts[0].path = "link";
  f.save("build");
  assert.ok(f.verify().missing.includes("build"));
});

test("complete signed metrics still reject over-limit observations and numeric strings", async (t) => {
  const f = await fixture(t);
  for (const [gate, key, value] of [
    ["performance", "pageP95Ms", 501],
    ["performance", "lostWork", 1],
    ["performance", "readRps", "40"],
    ["soak", "maxRssP95Ratio", 1.21],
    ["soak", "missingSamples", 1],
    ["soak", "maxConsecutiveWorseningQueueHours", 3],
    ["faults", "duplicateEffects", 1],
  ]) {
    const m = f.reports.get(gate).measurements,
      old = m[key];
    m[key] = value;
    f.save(gate);
    assert.ok(f.verify().missing.includes(gate), `${gate}.${key}`);
    m[key] = old;
    f.save(gate);
  }
  assert.equal(f.verify().artifactChecksPassed, true);
});
test("invalid candidate text is never echoed in verification output", async (t) => {
  const f = await fixture(t);
  const secret = "ghp_" + "x".repeat(36);
  f.manifest.candidate = secret;
  const result = f.verify();
  assert.equal(result.candidate, null);
  assert.ok(!JSON.stringify(result).includes(secret));
});
