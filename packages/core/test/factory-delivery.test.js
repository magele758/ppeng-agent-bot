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
test("delivery policy is durable, disabled by default and independent of process env [AC:multi-machine-controlled-delivery#AC-1]", async (t) => {
  const f = await fixture(t);
  assert.equal(
    f.service.delivery.settings(f.principal, "u0", "core").enabled,
    false,
  );
  f.service.delivery.save(f.principal, "u0", "core", policy);
  assert.equal(
    f.service.delivery.settings(f.principal, "u0", "core").repository,
    "example/trial",
  );
});
test("preflight refuses unknown protections and downstream effects [AC:multi-machine-controlled-delivery#AC-2]", async (t) => {
  const f = await setup(t, { strict: false, downstreamSafe: false });
  const p = await f.api.preflight(f.principal, "u0", "core");
  assert.equal(p.ready, false);
  assert.ok(p.reasons.length);
});
test("readonly and unauthorized requests cannot acquire a delivery grant [AC:multi-machine-controlled-delivery#AC-3]", async (t) => {
  const f = await setup(t);
  const ro = f.submit();
  assert.throws(
    () => f.api.grant(f.principal, ro.id, { scope: "MERGED" }),
    /development|READY/i,
  );
  assert.throws(() =>
    f.api.grant({ userId: "other", tenantId: "team" }, f.task.id, {
      scope: "MERGED",
    }),
  );
  assert.equal(f.effects.length, 0);
});
test("task scoped grant is recorded once and revoke halts new writes [AC:multi-machine-controlled-delivery#AC-4]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.grant();
  assert.equal(f.state().grants.length, 1);
  assert.equal(f.state().grants[0].userId, "owner");
  await f.api.control(f.principal, f.task.id, "revoke");
  await f.step();
  assert.equal(
    f.effects.filter((x) => ["push", "pr", "merge"].includes(x.action)).length,
    0,
  );
});
test("stale READY or missing local artifact cannot enqueue [AC:multi-machine-controlled-delivery#AC-5]", async (t) => {
  const f = await setup(t);
  delete f.task.result.development.artifact;
  f.service.updateDevelopment(f.task);
  assert.throws(() => f.grant(), /artifact|READY/i);
});
test("privacy findings and unconfirmed sensitive files block before push [AC:multi-machine-controlled-delivery#AC-6]", async (t) => {
  const f = await setup(t);
  const transport = f.transport.delivery;
  f.transport.delivery = async (m, r) =>
    r.action === "artifact"
      ? {
          ...(await transport(m, r)),
          privacy: { sha, findings: ["secret"] },
          sensitive: [".github/workflows/test.yml"],
        }
      : transport(m, r);
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.equal(f.facts.headSha, null);
});
test("publisher refuses general commands credentials and arbitrary refs [AC:multi-machine-controlled-delivery#AC-7]", async () => {
  const { validateDeliveryRequest } =
    await import("../dist/factory/delivery-policy.js");
  assert.throws(() =>
    validateDeliveryRequest({ action: "shell", argv: ["printenv"] }),
  );
  assert.throws(() =>
    validateDeliveryRequest({
      action: "push",
      branch: "main",
      sha,
      taskId: "factory_x",
    }),
  );
});
test("artifact from wrong host or oversized receipt defers without push [AC:multi-machine-controlled-delivery#AC-8]", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) =>
    r.action === "artifact"
      ? { ...(await call(m, r)), identity: "other", bytes: 700001 }
      : call(m, r);
  f.grant();
  await f.step();
  assert.equal(f.facts.headSha, null);
  assert.equal(f.state().stage, "DEFERRED");
});
test("canonical repository aliases serialize remote writes [AC:multi-machine-controlled-delivery#AC-9]", async (t) => {
  const f = await setup(t);
  const { deliveryQueueKey } =
    await import("../dist/factory/delivery-policy.js");
  assert.equal(
    deliveryQueueKey({ ...policy, repository: "Alias/Repo" }),
    deliveryQueueKey(policy),
  );
  assert.notEqual(
    deliveryQueueKey({ ...policy, target: "release" }),
    deliveryQueueKey(policy),
  );
});
test("waiting for CI releases execution capacity [AC:multi-machine-controlled-delivery#AC-10]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "CI_WAIT");
  assert.equal(f.service.board(f.principal).machines[0].occupied, 0);
  f.submit();
  await f.service.tick();
  assert.equal(f.starts.length, 1);
});
test("uncertain writer retains durable queue ownership without time based takeover [AC:multi-machine-controlled-delivery#AC-11]", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) => {
    if (r.action === "push") throw Error("connection lost");
    return call(m, r);
  };
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "VERIFYING");
  f.advance(86400000);
  assert.equal(f.api.queue()[0].taskId, f.task.id);
});
test("advanced target queues original machine for merge and revalidation [AC:multi-machine-controlled-delivery#AC-12]", async (t) => {
  const f = await setup(t, { baseSha: "e".repeat(40) });
  f.grant();
  await f.step();
  const task = f.service.get(f.principal, f.task.id);
  assert.equal(task.status, "queued");
  assert.equal(task.machineId, "u0");
  assert.equal(task.development.deliveryInput.baseSha, "e".repeat(40));
  assert.equal(task.development.baseline, base);
  assert.equal(f.facts.headSha, null);
});
test("merge conflict evidence remains pending and code is preserved [AC:multi-machine-controlled-delivery#AC-13]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.task.development.stage = "WAITING_DECISION";
  f.task.status = "failed";
  f.task.error = "Merge conflict";
  f.service.updateDevelopment(f.task);
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.match(f.service.get(f.principal, f.task.id).error, /conflict/);
});
test("policy or candidate changes invalidate current grant evidence [AC:multi-machine-controlled-delivery#AC-14]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.api.save(f.principal, "u0", "core", {
    ...policy,
    requiredChecks: [{ workflowId: 99, job: "other", appId: 15368 }],
  });
  await f.step();
  assert.equal(f.facts.headSha, null);
  assert.equal(f.state().stage, "WAITING_DECISION");
});
test("only normal task branch push is emitted [AC:multi-machine-controlled-delivery#AC-15]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  const p = f.effects.find((e) => e.action === "push");
  assert.equal(p.branch, "factory/" + f.task.id);
  assert.equal(p.force, undefined);
  assert.notEqual(p.branch, "main");
});
test("lost successful push response is reconciled before retry [AC:multi-machine-controlled-delivery#AC-16]", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  let lost = true;
  f.transport.delivery = async (m, r) => {
    const out = await call(m, r);
    if (r.action === "push" && lost) {
      lost = false;
      throw Error("lost response");
    }
    return out;
  };
  f.grant();
  await f.step();
  await f.step();
  assert.equal(f.effects.filter((e) => e.action === "push").length, 1);
  assert.equal(f.state().pr.number, 1);
});
test("push exit alone never proves remote head [AC:multi-machine-controlled-delivery#AC-17]", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) =>
    r.action === "push" ? {} : call(m, r);
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "VERIFYING");
  assert.equal(f.state().pushedSha, undefined);
});
test("unrelated or externally retargeted PR is not adopted [AC:multi-machine-controlled-delivery#AC-18]", async (t) => {
  const f = await setup(t, {
    pr: { number: 9, marker: "other", head: sha, base: "wrong", state: "open" },
  });
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.equal(f.effects.filter((e) => e.action === "merge").length, 0);
});
test("forged same name, stale base, skip and stale attempts cannot satisfy CI [AC:multi-machine-controlled-delivery#AC-19]", async () => {
  const { trustedCi } = await import("../dist/factory/delivery-policy.js");
  const check = {
    id: 1,
    workflowId: 42,
    job: "test",
    appId: 15368,
    sha,
    baseSha: base,
    attempt: 1,
    status: "completed",
    conclusion: "success",
    trusted: true,
  };
  assert.equal(trustedCi(policy, sha, base, [check]).state, "passed");
  for (const mutation of [
    { appId: 1 },
    { baseSha: merge },
    { conclusion: "skipped" },
    { trusted: false },
    { sha: merge },
  ])
    assert.notEqual(
      trustedCi(policy, sha, base, [{ ...check, ...mutation }]).state,
      "passed",
    );
  assert.notEqual(
    trustedCi(policy, sha, base, [
      check,
      { ...check, id: 2, attempt: 2, conclusion: "failure" },
    ]).state,
    "passed",
  );
});
test("CI blockers consume original task rounds and return to original bot [AC:multi-machine-controlled-delivery#AC-20]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  f.facts.checks[0].conclusion = "failure";
  await f.step();
  const tsk = f.service.get(f.principal, f.task.id);
  assert.equal(tsk.development.round, 1);
  assert.equal(tsk.status, "queued");
  assert.equal(tsk.botId, f.task.botId);
  assert.equal(f.state().ciHistory[0].checks[0].conclusion, "failure");
});
test("CI timeout is bounded and histories survive repeated polling [AC:multi-machine-controlled-delivery#AC-21]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.advance(60001);
  await f.step();
  assert.equal(f.state().stage, "DEFERRED");
  assert.equal(f.effects.filter((e) => e.action === "rerun").length, 0);
});
test("new candidate invalidates old CI without a second PR [AC:multi-machine-controlled-delivery#AC-22]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.task = f.service.get(f.principal, f.task.id);
  f.task.result.development.sha = merge;
  f.service.updateDevelopment(f.task);
  await f.step();
  assert.notEqual(f.state().stage, "MERGED");
  assert.equal(f.effects.filter((e) => e.action === "pr").length, 1);
});
test("project blockers prohibit merge despite green checks [AC:multi-machine-controlled-delivery#AC-23]", async (t) => {
  const f = await setup(t, { reviewApproved: false });
  f.grant();
  await f.step();
  f.green();
  await f.step();
  assert.notEqual(f.state().stage, "MERGED");
  assert.equal(f.effects.filter((e) => e.action === "merge").length, 0);
});
test("automatic merge requires provider strict current target protection [AC:multi-machine-controlled-delivery#AC-24]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  f.facts.strict = false;
  await f.step();
  assert.equal(f.effects.filter((e) => e.action === "merge").length, 0);
  assert.equal(f.state().stage, "WAITING_DECISION");
});
test("squash records tested and merged SHAs only after independent target verification [AC:multi-machine-controlled-delivery#AC-25]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  await f.step();
  assert.equal(f.state().stage, "MERGED");
  assert.equal(f.state().candidate, sha);
  assert.equal(f.state().mergeSha, merge);
});
test("revocation after push retains occurred remote facts [AC:multi-machine-controlled-delivery#AC-26]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  await f.api.control(f.principal, f.task.id, "cancel");
  f.green();
  await f.step();
  assert.equal(f.state().pushedSha, sha);
  assert.equal(f.state().pr.number, 1);
  assert.equal(
    f.effects.filter((e) => ["merge", "delete", "close"].includes(e.action))
      .length,
    0,
  );
});
test("restart resumes same PR without repeating push or create [AC:multi-machine-controlled-delivery#AC-27]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  const { FactoryDelivery } = await import("../dist/factory/delivery.js");
  const restarted = new FactoryDelivery(f.store, f.service, f.transport, () =>
    Date.parse("2026-10-18T04:00:00Z"),
  );
  await restarted.advance(f.principal, f.task.id);
  assert.equal(restarted.current(f.principal, f.task.id).pr.number, 1);
  assert.equal(f.effects.filter((e) => e.action === "push").length, 1);
  assert.equal(f.effects.filter((e) => e.action === "pr").length, 1);
});
test("external close is recorded and never automatically reopened [AC:multi-machine-controlled-delivery#AC-28]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.facts.pr.state = "closed";
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.equal(f.effects.filter((e) => e.action === "pr").length, 1);
  assert.ok(f.state().history.some((x) => x.kind === "external"));
});
test("platform outage retries are bounded with no privileged fallback [AC:multi-machine-controlled-delivery#AC-29]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.transport.delivery = async () => {
    throw Error("rate limited");
  };
  await f.step();
  await f.step();
  await f.step();
  assert.equal(f.state().stage, "DEFERRED");
  assert.equal(f.state().attempts, 2);
});
test("PR grant stops at PR and deployment remains separate [AC:multi-machine-controlled-delivery#AC-30]", async (t) => {
  const f = await setup(t);
  f.grant("PR");
  await f.step();
  f.green();
  await f.step();
  assert.equal(f.state().stage, "PR_READY");
  assert.equal(f.state().deployment, "not_deployed");
  assert.equal(f.effects.filter((e) => e.action === "merge").length, 0);
});
test("audit evidence redacts credential shaped values [AC:multi-machine-controlled-delivery#AC-31]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.transport.delivery = async () => {
    throw Error("Authorization: Bearer highly-secret-value");
  };
  await f.step();
  assert.ok(!JSON.stringify(f.state()).includes("highly-secret-value"));
  assert.equal(f.state().originalBase, base);
});
test("unchanged waiting state produces no repeated delivery notifications [AC:multi-machine-controlled-delivery#AC-32]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  const before = f.store.db
    .prepare("SELECT count(*) AS n FROM factory_outbox")
    .get().n;
  await f.step();
  await f.step();
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM factory_outbox").get().n,
    before,
  );
});
test("only authorized explicit delivery decision resumes blocked scope [AC:multi-machine-controlled-delivery#AC-33]", async (t) => {
  const f = await setup(t);
  f.grant();
  assert.throws(() =>
    f.api.decide({ userId: "other", tenantId: "team" }, f.task.id, {
      action: "resume",
    }),
  );
  assert.throws(() =>
    f.api.decide(f.principal, f.task.id, { action: "deploy" }),
  );
  assert.equal(f.state().decisions.length, 0);
});
test("existing development tasks never receive automatic delivery grants [AC:multi-machine-controlled-delivery#AC-34]", async (t) => {
  const f = await setup(t);
  await f.step();
  assert.equal(f.state(), null);
  assert.equal(f.effects.length, 0);
  assert.equal(
    f.service.get(f.principal, f.task.id).development.delivery,
    "not_pushed",
  );
});
test("pilot validator requires two distinct hosts actual CI repair and advanced baseline [AC:multi-machine-controlled-delivery#AC-35]", async () => {
  const { verifyDeliveryPilot } =
    await import("../dist/factory/delivery-policy.js");
  assert.throws(
    () => verifyDeliveryPilot({ tasks: [], recovery: {} }),
    /two|machine/i,
  );
});
test("recovery validator rejects duplicate side effects and uncertain occupancy [AC:multi-machine-controlled-delivery#AC-36]", async () => {
  const { verifyDeliveryPilot } =
    await import("../dist/factory/delivery-policy.js");
  const row = {
    identity: "a",
    merged: true,
    candidate: sha,
    mergeSha: merge,
    sourceUnchanged: true,
    ciRepair: true,
    baseAdvanced: true,
    real: true,
  };
  assert.throws(
    () =>
      verifyDeliveryPilot({
        tasks: [row, { ...row, identity: "b" }],
        recovery: {
          real: true,
          pushes: 2,
          prs: 3,
          merges: 2,
          occupied: 0,
          live: 0,
        },
      }),
    /duplicate|recovery/i,
  );
});
test("revoking during an in-flight push survives the late publisher response", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  let resume, entered;
  const started = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (resume = r));
  f.transport.delivery = async (m, r) => {
    const out = await call(m, r);
    if (r.action === "push") {
      entered();
      await hold;
    }
    return out;
  };
  f.grant();
  const advance = f.step();
  await started;
  f.api.control(f.principal, f.task.id, "revoke");
  resume();
  await advance;
  assert.equal(f.state().grants.at(-1).revoked, true);
  assert.equal(f.facts.pr, null);
  assert.equal(f.state().pushedSha, sha);
});
test("two coordinators cannot concurrently execute a task write", async (t) => {
  const f = await setup(t);
  const { FactoryDelivery } = await import("../dist/factory/delivery.js");
  const other = new FactoryDelivery(f.store, f.service, f.transport, () =>
    Date.parse("2026-10-18T04:00:00Z"),
  );
  const call = f.transport.delivery;
  let resume, entered;
  const started = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (resume = r));
  f.transport.delivery = async (m, r) => {
    if (r.action === "push") {
      entered();
      await hold;
    }
    return call(m, r);
  };
  f.grant();
  const a = f.step();
  await started;
  const b = other.advance(f.principal, f.task.id);
  await new Promise((r) => setTimeout(r, 10));
  resume();
  await Promise.all([a, b]);
  assert.equal(f.effects.filter((e) => e.action === "push").length, 1);
});
test("a newer run failure outranks an older successful rerun at the same SHA", async () => {
  const { trustedCi } = await import("../dist/factory/delivery-policy.js");
  const c = {
    workflowId: 42,
    job: "test",
    appId: 15368,
    sha,
    baseSha: base,
    status: "completed",
    trusted: true,
  };
  assert.notEqual(
    trustedCi(policy, sha, base, [
      { ...c, id: 2, runId: 10, attempt: 2, conclusion: "success" },
      { ...c, id: 3, runId: 11, attempt: 1, conclusion: "failure" },
    ]).state,
    "passed",
  );
});
for (const action of ["pr", "merge"])
  test(
    "lost successful " +
      action +
      " response reconciles one effect without replay",
    async (t) => {
      const f = await setup(t);
      const call = f.transport.delivery;
      let lost = true;
      f.transport.delivery = async (m, r) => {
        const result = await call(m, r);
        if (r.action === action && lost) {
          lost = false;
          throw Error("lost successful response");
        }
        return result;
      };
      f.grant();
      await f.step();
      f.green();
      await f.step();
      await f.step();
      assert.equal(f.effects.filter((e) => e.action === action).length, 1);
      assert.equal(f.state().stage, "MERGED");
    },
  );
test("a cancelled in-flight merge is reported as MERGED when the remote fact is verified", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  let entered, resume;
  const started = new Promise((r) => (entered = r)),
    hold = new Promise((r) => (resume = r));
  f.grant();
  await f.step();
  f.green();
  f.transport.delivery = async (m, r) => {
    const out = await call(m, r);
    if (r.action === "merge") {
      entered();
      await hold;
    }
    return out;
  };
  const advance = f.step();
  await started;
  f.api.control(f.principal, f.task.id, "cancel");
  resume();
  await advance;
  assert.equal(f.state().stage, "MERGED");
  assert.equal(f.state().mergeSha, merge);
  assert.equal(
    f.effects.filter((e) => ["delete", "revert", "close"].includes(e.action))
      .length,
    0,
  );
});
test("an explicitly finished refused merge reconciles no effect then syncs advanced base", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.grant();
  await f.step();
  f.green();
  f.transport.delivery = async (m, r) => {
    if (r.action === "merge") {
      f.facts.baseSha = "e".repeat(40);
      throw Object.assign(Error("protected branch advanced"), {
        publisherFinished: true,
        publisherRefused: true,
      });
    }
    return call(m, r);
  };
  await f.step();
  assert.equal(f.state().stage, "VERIFYING");
  await f.step();
  assert.equal(f.state().stage, "SYNC_WAIT");
  assert.equal(f.facts.pr.state, "open");
  assert.equal(
    f.service.get(f.principal, f.task.id).development.deliveryInput.baseSha,
    "e".repeat(40),
  );
});
test("cancelling after verified merge cannot erase the merged remote fact", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  await f.step();
  f.api.control(f.principal, f.task.id, "cancel");
  assert.equal(f.state().stage, "MERGED");
  assert.equal(f.state().mergeSha, merge);
});
test("a fresh explicit grant can resume a previously revoked task", async (t) => {
  const f = await setup(t);
  f.grant();
  f.api.control(f.principal, f.task.id, "revoke");
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "CI_WAIT");
  assert.equal(f.state().grants.length, 2);
});
test("a completely revalidated CI repair normally updates the same existing PR", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  f.facts.checks[0].conclusion = "failure";
  await f.step();
  const task = f.service.get(f.principal, f.task.id);
  const next = "f".repeat(40);
  const r = ready(task.development.policy.revision);
  r.sha = next;
  r.generation = task.development.generation;
  r.round = task.development.round;
  r.deliveryBase = base;
  r.artifact.sha = next;
  r.checks.forEach((x) => (x.sha = next));
  r.review.sha = next;
  r.review.segments.forEach((x) => (x.sha = next));
  task.status = "succeeded";
  task.development.stage = "READY";
  task.result = { development: r };
  f.service.updateDevelopment(task);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, q) => {
    if (q.action === "artifact")
      return {
        ...r.artifact,
        valid: true,
        identity: "host-u0",
        privacy: { sha: next, findings: [] },
        sensitive: [],
      };
    const value = await call(m, q);
    if (q.action === "push") f.facts.pr.head = q.sha;
    return value;
  };
  f.facts.checks = [];
  await f.step();
  assert.equal(f.state().stage, "CI_WAIT");
  assert.equal(f.state().candidate, next);
  assert.equal(f.state().pr.number, 1);
  assert.equal(f.effects.filter((x) => x.action === "pr").length, 1);
  assert.equal(f.effects.filter((x) => x.action === "push").length, 2);
});
test("oversize CI history preserves a bounded deferred snapshot instead of throwing from recovery", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  f.facts.checks[0].evidence = "x".repeat(600000);
  await f.step();
  const d = f.state();
  assert.equal(d.stage, "DEFERRED");
  assert.equal(d.evidenceRecoveryRequired, true);
  assert.equal(d.evidenceSnapshot.available, true);
  assert.ok(JSON.stringify(d).length < 524288);
  const page = f.api.evidence(
    f.principal,
    f.task.id,
    d.evidenceSnapshot.digest,
    0,
  );
  assert.ok(page.text.length <= 65536);
  assert.equal(page.totalBytes, d.evidenceSnapshot.bytes);
});
test("disabling new delivery cannot prevent the task owner revoking existing grants", async (t) => {
  const f = await setup(t);
  f.grant();
  f.api.save(f.principal, "u0", "core", { ...policy, enabled: false });
  assert.doesNotThrow(() => f.api.control(f.principal, f.task.id, "revoke"));
  assert.equal(f.state().grants.at(-1).revoked, true);
});
test("delivery policy changed while artifact inspection awaits cannot authorize a push", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) => {
    const out = await call(m, r);
    if (r.action === "artifact")
      f.api.save(f.principal, "u0", "core", { ...policy, target: "release" });
    return out;
  };
  f.grant();
  await f.step();
  assert.equal(f.effects.filter((e) => e.action === "push").length, 0);
  assert.equal(f.state().stage, "WAITING_DECISION");
});
test("repository auto-delete on merge is an unauthorized cleanup side effect", async (t) => {
  const f = await setup(t, { deletesBranchOnMerge: true });
  const result = await f.api.preflight(f.principal, "u0", "core");
  assert.equal(result.ready, false);
  f.grant();
  await f.step();
  assert.equal(f.effects.filter((e) => e.action === "push").length, 0);
});
test("an expired delivery budget cannot push or schedule another baseline sync", async (t) => {
  const f = await setup(t, { baseSha: "e".repeat(40) });
  f.grant();
  f.advance(60001);
  await f.step();
  assert.equal(f.state().stage, "DEFERRED");
  assert.equal(f.effects.length, 0);
  assert.equal(f.service.get(f.principal, f.task.id).status, "succeeded");
});
test("deleting previously confirmed CI variables invalidates the saved strategy", async (t) => {
  const f = await setup(t, {
    ciVariablesCount: 0,
    ciConfigDigest: "e".repeat(64),
  });
  f.api.save(f.principal, "u0", "core", {
    ...policy,
    ciVariablesDigest: "d".repeat(64),
  });
  const result = await f.api.preflight(f.principal, "u0", "core");
  assert.equal(result.ready, false);
});
test("explicit CI budget decision adds bounded task rounds without resetting consumed work or creating a new grant", async (t) => {
  const f = await setup(t);
  f.task.development.round = 6;
  f.task.result.development.round = 6;
  f.service.updateDevelopment(f.task);
  f.grant();
  await f.step();
  f.green();
  f.facts.checks[0].conclusion = "failure";
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  const grants = f.state().grants.length;
  f.api.decide(f.principal, f.task.id, { action: "add-rounds", rounds: 2 });
  const task = f.service.get(f.principal, f.task.id);
  assert.equal(task.development.round, 6);
  assert.equal(task.development.policy.maxRounds, 8);
  assert.equal(f.state().grants.length, grants);
  assert.equal(f.state().decisions.at(-1).rounds, 2);
  await f.step();
  const repair = f.service.get(f.principal, f.task.id);
  assert.equal(repair.development.round, 7);
  assert.equal(repair.status, "queued");
  assert.equal(repair.machineId, f.task.machineId);
});
test("canonical GitHub identity accepts valid legacy opaque node IDs", async () => {
  const { parseDeliveryPolicy } =
    await import("../dist/factory/delivery-policy.js");
  assert.equal(
    parseDeliveryPolicy({
      ...policy,
      repositoryNodeId: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
    }).repositoryNodeId,
    "MDEwOlJlcG9zaXRvcnkxMjk2MjY5",
  );
});
test("a confirmed artifact scan bound defers with its specific reason before any write", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) => {
    if (r.action === "artifact")
      throw Object.assign(Error("Privacy history size budget exceeded"), {
        publisherFinished: true,
        publisherRefused: true,
        action: "artifact",
      });
    return call(m, r);
  };
  f.grant();
  await f.step();
  assert.equal(f.state().stage, "DEFERRED");
  assert.match(f.state().reason, /history size/i);
  assert.equal(f.facts.headSha, null);
});
test("a provider without atomic authorized-target enforcement stops automatic merging [AC:multi-machine-controlled-delivery#AC-24]", async (t) => {
  const f = await setup(t, { atomicTarget: false });
  f.grant();
  await f.step();
  f.green();
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.match(f.state().reason, /atomically.*target/i);
  assert.equal(f.effects.filter((e) => e.action === "merge").length, 0);
  assert.equal(f.facts.pr.state, "open");
});
test("a legacy error journal is not evidence that an ambiguous remote writer stopped [AC:multi-machine-controlled-delivery#AC-27]", async (t) => {
  const f = await setup(t);
  f.grant();
  const call = f.transport.delivery;
  let pushes = 0;
  f.transport.delivery = async (m, r) => {
    if (r.action === "push") {
      pushes++;
      throw Error("read timeout after request sent");
    }
    const value = await call(m, r);
    if (r.action === "snapshot" && f.state().pending)
      value.operation = {
        operationId: f.state().pending.id,
        completed: true,
        error: true,
      };
    return value;
  };
  await f.step();
  await f.step();
  await f.step();
  assert.equal(pushes, 1);
  assert.equal(f.state().stage, "VERIFYING");
  assert.ok(f.state().pending);
  assert.equal(f.api.queue(f.principal).length, 1);
  f.facts.headSha = sha;
  await f.step();
  assert.equal(pushes, 1);
  assert.equal(f.state().pr.number, 1);
});
test("stable terminal delivery records do not acquire controller locks on every tick", async (t) => {
  const f = await setup(t);
  f.grant();
  const d = f.state();
  d.stage = "MERGED";
  d.mergeSha = merge;
  f.store.db
    .prepare("UPDATE factory_delivery SET data=? WHERE task_id=?")
    .run(JSON.stringify(d), d.taskId);
  let advances = 0;
  f.api.advance = async () => {
    advances++;
  };
  await f.api.tick();
  assert.equal(advances, 0);
});
test("slow delivery snapshots do not block other machines or subsequent Factory polls [AC:multi-machine-controlled-delivery#AC-34]", async (t) => {
  const f = await setup(t);
  f.grant();
  const call = f.transport.delivery;
  let release, entered;
  const barrier = new Promise((r) => {
      release = r;
    }),
    seen = new Promise((r) => {
      entered = r;
    });
  f.transport.delivery = async (m, r) => {
    if (r.action === "snapshot") {
      entered();
      await barrier;
    }
    return call(m, r);
  };
  const first = f.service.tick();
  await seen;
  const task = f.submit({ machineId: "u1" });
  try {
    await f.service.tick();
    assert.ok(
      f.starts.includes(task.id),
      "another host must start before delivery snapshot finishes",
    );
    await f.service.tick();
    assert.equal(f.service.get(f.principal, task.id).status, "running");
  } finally {
    release();
    await first;
    f.finish(task.id);
  }
});
test("a pending write remains reconcilable after external PR mismatch is corrected [AC:multi-machine-controlled-delivery#AC-28]", async (t) => {
  const f = await setup(t);
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) => {
    const value = await call(m, r);
    if (r.action === "pr") {
      f.facts.pr.base = "unexpected";
      throw Error("created but reply lost");
    }
    return value;
  };
  f.grant();
  await f.step();
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.ok(f.state().pending);
  const writes = f.effects.filter((e) =>
    ["push", "pr", "merge"].includes(e.action),
  ).length;
  f.facts.pr.base = "main";
  await f.step();
  assert.equal(f.state().pending, undefined);
  assert.equal(
    f.state().stage,
    "WAITING_DECISION",
    "fact recovery must not silently resume authorization",
  );
  assert.equal(f.api.queue(f.principal).length, 0);
  assert.equal(
    f.effects.filter((e) => ["push", "pr", "merge"].includes(e.action)).length,
    writes,
  );
});
test("transient stopped reconciliation cannot silently resume remote writes [AC:multi-machine-controlled-delivery#AC-28]", async (t) => {
  const f = await setup(t);
  f.grant();
  const d = f.state();
  d.stage = "WAITING_DECISION";
  d.reason = "External PR changed; owner decision required";
  d.pending = {
    id: "11111111-1111-1111-1111-111111111111",
    action: "push",
    sha,
    at: d.updatedAt,
  };
  f.store.db
    .prepare("UPDATE factory_delivery SET data=? WHERE task_id=?")
    .run(JSON.stringify(d), d.taskId);
  const call = f.transport.delivery;
  let failed = false;
  f.transport.delivery = async (m, r) => {
    if (r.action === "snapshot" && !failed) {
      failed = true;
      throw Error("temporary read unavailable");
    }
    return call(m, r);
  };
  await f.step();
  f.facts.headSha = sha;
  await f.step();
  assert.equal(f.state().stage, "WAITING_DECISION");
  assert.equal(f.state().reason, d.reason);
  assert.equal(f.state().pending, undefined);
  assert.equal(f.api.queue(f.principal).length, 0);
  assert.equal(
    f.effects.filter((e) => ["push", "pr", "merge"].includes(e.action)).length,
    0,
  );
});
test("a legacy verified MERGED record does not display its old transient recovery reason [AC:multi-machine-controlled-delivery#AC-30]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  await f.step();
  const d = f.state();
  assert.equal(d.stage, "MERGED");
  d.reason = "Remote write outcome unknown; reconcile before replay";
  f.store.db
    .prepare("UPDATE factory_delivery SET data=? WHERE task_id=?")
    .run(JSON.stringify(d), d.taskId);
  assert.equal(f.state().reason, undefined);
  assert.equal(f.state().mergeSha, merge);
});
for (const action of ["pause", "cancel"])
  test(`a ${action} decision survives transient pending-write verification errors [AC:multi-machine-controlled-delivery#AC-26]`, async (t) => {
    const f = await setup(t);
    f.grant();
    const call = f.transport.delivery;
    let readsFail = false;
    f.transport.delivery = async (m, r) => {
      if (r.action === "snapshot" && readsFail)
        throw Error("temporary read failure");
      const v = await call(m, r);
      if (r.action === "push") throw Error("push reply lost");
      return v;
    };
    await f.step();
    assert.ok(f.state().pending);
    f.api.control(f.principal, f.task.id, action);
    readsFail = true;
    await f.step();
    readsFail = false;
    await f.step();
    assert.equal(f.state().stage, action === "pause" ? "PAUSED" : "CANCELLED");
    assert.equal(f.state().pending, undefined);
    assert.equal(f.effects.filter((e) => e.action === "pr").length, 0);
    assert.equal(f.effects.filter((e) => e.action === "push").length, 1);
  });
test("an explicit remote verification can confirm an external merge after deadline and revocation without writing [AC:multi-machine-controlled-delivery#AC-28]", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.api.control(f.principal, f.task.id, "revoke");
  f.advance(120000);
  f.api.save(f.principal, "u0", "core", { ...policy, enabled: false });
  f.facts.pr.state = "merged";
  f.facts.pr.mergeSha = merge;
  f.facts.merge = {
    sha: merge,
    candidate: sha,
    base,
    onTarget: true,
    treeMatches: true,
  };
  const writes = f.effects.filter((e) =>
    ["push", "pr", "merge"].includes(e.action),
  ).length;
  const d = await f.api.verifyRemote(f.principal, f.task.id);
  assert.equal(d.stage, "MERGED");
  assert.equal(d.mergeSha, merge);
  assert.equal(
    f.effects.filter((e) => ["push", "pr", "merge"].includes(e.action)).length,
    writes,
  );
  assert.equal(d.grants.at(-1).revoked, true);
});
test("a failed explicit observation preserves the verified merge and records the failed read", async (t) => {
  const f = await setup(t);
  f.grant();
  await f.step();
  f.green();
  await f.step();
  const call = f.transport.delivery;
  f.transport.delivery = async (m, r) => {
    if (r.action === "snapshot") throw Error("read unavailable");
    return call(m, r);
  };
  await assert.rejects(
    f.api.verifyRemote(f.principal, f.task.id),
    /unverified/,
  );
  assert.equal(f.state().stage, "MERGED");
  assert.equal(f.state().mergeSha, merge);
  assert.ok(
    f
      .state()
      .history.some((e) => e.kind === "stopped-reconciliation-unavailable"),
  );
});
test("a separate merge App identity is pinned in durable policy and cannot reuse the push credential", async () => {
  const { parseDeliveryPolicy } =
    await import("../dist/factory/delivery-policy.js");
  const identity = {
    appId: 123,
    installationId: 456,
    credentialRef: "merge-only",
    rulesetId: 789,
  };
  const p = parseDeliveryPolicy({ ...policy, mergeIdentity: identity });
  assert.deepEqual(p.mergeIdentity, identity);
  assert.notEqual(p.revision, parseDeliveryPolicy(policy).revision);
  assert.throws(() =>
    parseDeliveryPolicy({
      ...policy,
      mergeIdentity: { ...identity, credentialRef: policy.credentialRef },
    }),
  );
  for (const patch of [
    { appId: 0 },
    { installationId: "456" },
    { rulesetId: -1 },
    { privateKey: "must-not-persist" },
  ])
    assert.throws(() =>
      parseDeliveryPolicy({
        ...policy,
        mergeIdentity: { ...identity, ...patch },
      }),
    );
});
test("malformed delivery policy returns a validation error instead of accepting coerced credential references", async () => {
  const { parseDeliveryPolicy } =
    await import("../dist/factory/delivery-policy.js");
  const identity = {
    appId: 123,
    installationId: 456,
    credentialRef: "merge-only",
    rulesetId: 789,
  };
  for (const patch of [
    { target: null },
    { target: 123 },
    { credentialRef: undefined },
    { requiredChecks: [null] },
    { mergeIdentity: { ...identity, credentialRef: undefined } },
  ]) {
    assert.throws(
      () => parseDeliveryPolicy({ ...policy, ...patch }),
      (error) => error.name === "ValidationError",
      JSON.stringify(patch),
    );
  }
});
test("an explicitly renewed grant clears its obsolete blocked reason while retaining audit history [AC:multi-machine-controlled-delivery#AC-30]", async (t) => {
  const f = await setup(t);
  f.grant();
  f.facts.atomicTarget = false;
  await f.step();
  f.green();
  await f.step();
  const before = f.state();
  assert.equal(before.stage, "WAITING_DECISION");
  assert.ok(before.reason);
  const oldHistory = before.history.length;
  f.api.save(f.principal, "u0", "core", { ...policy, deadlineMs: 120000 });
  const renewed = f.api.grant(f.principal, f.task.id, { scope: "MERGED" });
  assert.equal(renewed.stage, "QUEUED");
  assert.equal(renewed.reason, undefined);
  assert.ok(renewed.history.length >= oldHistory);
  assert.equal(renewed.createdAt, before.createdAt);
  assert.equal(renewed.attempts, before.attempts);
});
