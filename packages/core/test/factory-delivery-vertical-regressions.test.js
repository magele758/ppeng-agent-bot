import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./factory-development-fixture.js";
const sha = "a".repeat(40),
  base = "b".repeat(40),
  merge = "c".repeat(40);
const policy = {
  enabled: true,
  allowedUserIds: ["owner"],
  repository: "example/trial",
  repositoryNodeId: "R_123",
  target: "main",
  credentialRef: "trial",
  operations: ["push", "pr", "merge"],
  requiredChecks: [{ workflowId: 42, job: "test", appId: 15368 }],
  mergeMethod: "squash",
  maxRetries: 1,
  deadlineMs: 60000,
  downstream: { confirmed: true, deploys: false },
};
const development = {
  enabled: true,
  allowedUserIds: ["owner"],
  image: "image@sha256:" + "a".repeat(64),
  toolPath: "/opt/claude",
  model: "model",
  modelUrl: "https://model.example",
  credentialRef: "test",
  checks: [{ id: "unit", argv: ["node", "--test"], required: true }],
  redCheck: "unit",
  install: ["node", "--version"],
  reviewArgv: ["/tools/claude", "--print"],
  codeArgv: ["/tools/claude", "--print"],
  timeoutMs: 60000,
  maxRounds: 6,
  maxRetries: 1,
  minDiskMb: 128,
  criteria: [{ id: "AC-1", given: "numbers", when: "add", then: "sum" }],
  criteriaApproved: true,
  baselineFailures: [],
};
function ready(revision) {
  return {
    generation: 1,
    stage: "READY",
    round: 0,
    sha,
    policyRevision: revision,
    clean: true,
    artifact: { sha, baseline: base, digest: "d".repeat(64), bytes: 42 },
    red: {
      exitCode: 1,
      reason: "assertion",
      criteria: ["AC-1"],
      testDigest: "frozen",
    },
    greenTestDigest: "frozen",
    manifest: {
      baseline: base,
      path: "/work",
      sourcePath: "/repo",
      independentGit: true,
      sourceBefore: "source",
      sourceAfter: "source",
    },
    dependencies: { exitCode: 0, isolated: true },
    checks: [
      { id: "unit", sha, passed: true, exitCode: 0, output: "ok 1 - addition" },
    ],
    review: {
      sha,
      covered: true,
      verdict: "CLEAN",
      issues: [],
      policyRevision: revision,
      files: ["sum.mjs"],
      segments: [
        { sha, files: ["sum.mjs"], verdict: "CLEAN", policyRevision: revision },
      ],
    },
  };
}
async function setup(t, extra = {}) {
  const f = await fixture(t, [1, 1]);
  f.service.development.save(f.principal, "u0", "core", development);
  const task = f.service.development.submit(f.principal, {
    machineId: "u0",
    repositoryId: "core",
    requestKey: "delivery",
    requirement: "sum",
    baseline: base,
  });
  task.identity = "host-u0";
  task.status = "succeeded";
  task.development.stage = "READY";
  task.result = { development: ready(task.development.policy.revision) };
  f.service.updateDevelopment(task);
  const effects = [],
    facts = {
      repositoryNodeId: "R_123",
      baseSha: base,
      headSha: null,
      pr: null,
      checks: [],
      protected: true,
      strict: true,
      atomicTarget: true,
      canPush: true,
      canMerge: true,
      downstreamSafe: true,
      reviewApproved: true,
      mergeable: true,
      ...extra,
    };
  f.transport.delivery = async (machine, request) => {
    effects.push({ machine: machine.id, ...request });
    switch (request.action) {
      case "preflight":
      case "snapshot":
        return structuredClone(facts);
      case "artifact":
        return {
          sha,
          baseline: base,
          digest: "d".repeat(64),
          bytes: 42,
          identity: "host-u0",
          valid: true,
          privacy: { sha, findings: [] },
          sensitive: [],
        };
      case "push":
        facts.headSha = request.sha;
        return {};
      case "pr":
        facts.pr = {
          number: 1,
          url: "https://github.com/example/trial/pull/1",
          head: sha,
          base: "main",
          branch: request.branch,
          marker: task.id,
          state: "open",
        };
        return {};
      case "sync-artifact":
        return {};
      case "merge":
        facts.pr.state = "merged";
        facts.pr.mergeSha = merge;
        facts.merge = {
          sha: merge,
          candidate: sha,
          base: base,
          onTarget: true,
          treeMatches: true,
        };
        return {};
      default:
        throw Error("unexpected action");
    }
  };
  const api = f.service.delivery;
  api.save(f.principal, "u0", "core", policy);
  const grant = (scope = "MERGED") =>
    api.grant(f.principal, task.id, { scope });
  const step = () => api.advance(f.principal, task.id);
  const state = () => api.current(f.principal, task.id);
  const green = () => {
    facts.checks = [
      {
        id: 7,
        workflowId: 42,
        job: "test",
        appId: 15368,
        sha,
        baseSha: base,
        attempt: 1,
        status: "completed",
        conclusion: "success",
        trusted: true,
      },
    ];
  };
  return { ...f, task, api, facts, effects, grant, step, state, green };
}

// Seed persisted historical audit evidence immediately below the view budget.
// No transport in this file reaches SSH or GitHub.
function padEvidence(f, targetBytes) {
  const d = f.state();
  d.history.push({
    kind: "prior-audit",
    at: d.createdAt,
    detail: { data: "" },
  });
  const padding = targetBytes - Buffer.byteLength(JSON.stringify(d));
  assert.ok(padding > 0);
  d.history.at(-1).detail.data = "x".repeat(padding);
  const data = JSON.stringify(d);
  assert.equal(Buffer.byteLength(data), targetBytes);
  f.store.db
    .prepare("UPDATE factory_delivery SET data=? WHERE task_id=?")
    .run(data, d.taskId);
}
function observeWrites(f) {
  const call = f.transport.delivery;
  const writes = [];
  f.transport.delivery = async (machine, request) => {
    if (["push", "pr", "merge"].includes(request.action)) {
      writes.push({
        action: request.action,
        recoveryRequired: f.state().evidenceRecoveryRequired === true,
      });
    }
    return call(machine, request);
  };
  return writes;
}
test("evidence overflow at push intent prevents all remote writes [AC:multi-machine-controlled-delivery#AC-31]", async (t) => {
  const f = await setup(t);
  f.grant();
  padEvidence(f, 524000);
  const writes = observeWrites(f);
  await f.step();
  assert.equal(f.state().evidenceRecoveryRequired, true);
  assert.deepEqual(
    writes,
    [],
    "No publisher write may follow evidence overflow at push intent",
  );
  assert.equal(f.facts.headSha, null);
  assert.ok(["DEFERRED", "VERIFYING"].includes(f.state().stage));
  await f.step();
  assert.deepEqual(
    writes,
    [],
    "Another tick must not bypass evidence recovery",
  );
});
test("evidence overflow after push prevents creating a PR [AC:multi-machine-controlled-delivery#AC-31]", async (t) => {
  const f = await setup(t);
  f.grant();
  padEvidence(f, 523900);
  const writes = observeWrites(f);
  await f.step();
  assert.equal(f.state().evidenceRecoveryRequired, true);
  assert.ok(
    writes.every((w) => !w.recoveryRequired),
    "Publisher writes must stop as soon as recovery is required",
  );
  assert.equal(
    f.facts.pr,
    null,
    "Retain the push fact without creating another remote effect",
  );
  assert.ok(["DEFERRED", "VERIFYING"].includes(f.state().stage));
});
test("evidence overflow at merge intent prevents merging [AC:multi-machine-controlled-delivery#AC-31]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  padEvidence(f, 523400);
  const writes = observeWrites(f);
  await f.step();
  assert.equal(f.state().evidenceRecoveryRequired, true);
  assert.deepEqual(
    writes,
    [],
    "The merge intent must be durable without bypassing the evidence gate",
  );
  assert.equal(f.facts.pr.state, "open");
  assert.ok(["DEFERRED", "VERIFYING"].includes(f.state().stage));
});
test("confirmed merge remains MERGED when final evidence exceeds the view budget [AC:multi-machine-controlled-delivery#AC-25]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  const call = f.transport.delivery;
  f.transport.delivery = async (machine, request) => {
    const result = await call(machine, request);
    // The remote merge is already a fact; growing audit evidence must not erase it.
    if (request.action === "merge") padEvidence(f, 600000);
    return result;
  };
  await f.step();
  assert.equal(f.facts.pr.state, "merged");
  assert.equal(f.state().mergeSha, merge);
  assert.equal(f.state().evidenceRecoveryRequired, true);
  assert.equal(f.state().stage, "MERGED");
  assert.equal(f.state().deployment, "not_deployed");
  assert.equal(f.api.queue(f.principal).length, 0);
});
test("distinct blockers at one candidate each notify once [AC:multi-machine-controlled-delivery#AC-32]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.facts.downstreamSafe = false;
  await f.step();
  const firstReason = f.state().reason;
  f.api.decide(f.principal, f.task.id, { action: "resume" });
  f.facts.downstreamSafe = true;
  f.facts.strict = false;
  await f.step();
  const secondReason = f.state().reason;
  assert.notEqual(firstReason, secondReason);
  const notices = () =>
    f.store.db
      .prepare("SELECT body FROM factory_outbox WHERE key LIKE ?")
      .all("delivery:" + f.task.id + ":%")
      .filter((row) => row.body.includes("WAITING_DECISION"));
  assert.equal(
    notices().length,
    2,
    "A new blocking reason is a distinct actionable change",
  );
  assert.ok(notices().some((row) => row.body.includes(firstReason)));
  assert.ok(notices().some((row) => row.body.includes(secondReason)));
  await f.step();
  await f.step();
  assert.equal(notices().length, 2, "Unchanged blockers remain deduplicated");
});
