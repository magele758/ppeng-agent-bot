import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/bot-http-fixture.mjs";
const url = "/api/factory/production";
const plan = {
  environment: "local",
  host: "",
  entryUrl: "",
  visibility: "private",
  repository: "",
  repositoryNodeId: "",
  target: "main",
  workerIds: [],
  modelIds: [],
  connectionIds: [],
  sourceSha: "",
  daemonDigest: "",
  webDigest: "",
  maxTasks: 2,
  maxRounds: 8,
  maxCostUsd: 0,
  deadlineMs: 14400000,
  minFreeDiskGiB: 14,
  scopeConfirmed: false,
  publicConfirmed: false,
};
async function setup(t) {
  const f = await boot();
  t.after(() => f.close());
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  return f;
}
test("local production settings persist with revision and require administrator access [AC:multi-machine-local-foundation#AC-2] [AC:multi-machine-production-readiness#AC-2] [AC:multi-machine-production-readiness#AC-6]", async (t) => {
  const f = await setup(t);
  assert.equal(
    (await f.call("bob", "PATCH", url + "/settings", plan)).status,
    403,
  );
  const saved = await f.call("alice", "PATCH", url + "/settings", plan);
  assert.equal(saved.status, 200);
  assert.match(saved.body.settings.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await f.call("alice", "GET", url + "/settings")).body.settings,
    saved.body.settings,
  );
  assert.equal((await f.call("bob", "GET", url + "/settings")).status, 403);
});
test("incomplete local scope reports missing targets and cannot authorize deployment [AC:multi-machine-local-foundation#AC-4] [AC:multi-machine-production-readiness#AC-1] [AC:multi-machine-production-readiness#AC-5] [AC:multi-machine-production-readiness#AC-11]", async (t) => {
  const f = await setup(t);
  await f.call("alice", "PATCH", url + "/settings", plan);
  const r = await f.call("alice", "POST", url + "/preflight", {});
  assert.equal(r.status, 200);
  assert.equal(r.body.canDeploy, false);
  assert.equal(r.body.ready, false);
  assert.equal(r.body.scope, "local");
  assert.ok(r.body.blockers.includes("deployment-scope-unconfirmed"));
  assert.ok(r.body.blockers.includes("real-project-unconfirmed"));
  assert.equal(r.body.observed.database, true);
});
test("credentials, unexpected commands, public disclosure and URL credentials are refused before persistence [AC:multi-machine-local-foundation#AC-2] [AC:multi-machine-production-readiness#AC-3] [AC:multi-machine-production-readiness#AC-4] [AC:multi-machine-production-readiness#AC-24]", async (t) => {
  const f = await setup(t);
  for (const extra of [
    { token: "do-not-store-this-secret" },
    { argv: ["sh"] },
    { visibility: "public", publicConfirmed: false },
    { entryUrl: "https://user:password@private.example/" },
    { environment: "production" },
    { daemonDigest: "latest" },
    { sourceSha: "main" },
  ]) {
    const r = await f.call("alice", "PATCH", url + "/settings", {
      ...plan,
      ...extra,
    });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.ok(!JSON.stringify(r.body).includes("do-not-store-this-secret"));
  }
  assert.equal(
    (await f.call("alice", "GET", url + "/settings")).body.settings.revision,
    undefined,
  );
});
test("local validation runs are idempotent, principal-isolated and freeze their original settings [AC:multi-machine-production-readiness#AC-7] [AC:multi-machine-production-readiness#AC-29] [AC:multi-machine-production-readiness#AC-35]", async (t) => {
  const f = await setup(t);
  await f.call("alice", "PATCH", url + "/settings", plan);
  const first = await f.call("alice", "POST", url + "/runs", {
    requestKey: "local-1",
  });
  assert.equal(first.status, 201);
  const id = first.body.run.id;
  assert.equal(first.body.run.stage, "LOCAL_ONLY");
  assert.equal(
    (await f.call("alice", "POST", url + "/runs", { requestKey: "local-1" }))
      .body.run.id,
    id,
  );
  await f.call("alice", "PATCH", url + "/settings", { ...plan, maxTasks: 3 });
  assert.equal(
    (await f.call("alice", "POST", url + "/runs", { requestKey: "local-1" }))
      .status,
    409,
  );
  assert.equal(
    (await f.call("alice", "GET", url + "/runs/" + id)).body.run.settings
      .maxTasks,
    2,
  );
  assert.equal((await f.call("bob", "GET", url + "/runs/" + id)).status, 403);
  const checked = await f.call(
    "alice",
    "POST",
    url + "/runs/" + id + "/assess",
    { checks: [{ gate: "soak", status: "passed" }] },
  );
  assert.equal(checked.status, 400);
  const report = await f.call(
    "alice",
    "POST",
    url + "/runs/" + id + "/assess",
    {},
  );
  assert.equal(report.status, 200);
  assert.equal(report.body.assessment.ready, false);
  assert.ok(report.body.assessment.blockers.includes("settings-changed"));
  assert.ok(report.body.assessment.missing.includes("soak"));
});
test("local evaluation never labels submitted reports as a deployed or release-ready system [AC:multi-machine-local-foundation#AC-8] [AC:multi-machine-production-readiness#AC-8] [AC:multi-machine-production-readiness#AC-22] [AC:multi-machine-production-readiness#AC-40]", async (t) => {
  const f = await setup(t);
  await f.call("alice", "PATCH", url + "/settings", plan);
  const { body } = await f.call("alice", "POST", url + "/runs", {
    requestKey: "status-1",
  });
  const result = await f.call(
    "alice",
    "POST",
    url + "/runs/" + body.run.id + "/assess",
    {},
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.assessment.canPromote, false);
  assert.equal(result.body.assessment.deployment, "not_deployed");
  assert.equal(result.body.assessment.businessDeployment, "not_authorized");
  assert.equal(result.body.run.stage, "LOCAL_ONLY");
  assert.equal(
    (await f.call("alice", "GET", url + "/runs")).body.runs.length,
    1,
  );
});
test("preflight overrides and credential-shaped connection IDs are rejected without leaking or persisting values [AC:multi-machine-production-readiness#AC-4]", async (t) => {
  const f = await setup(t);
  await f.call("alice", "PATCH", url + "/settings", plan);
  assert.equal(
    (await f.call("alice", "POST", url + "/preflight", { ready: true })).status,
    400,
  );
  const token = "ghp_" + "x".repeat(36);
  const denied = await f.call("alice", "PATCH", url + "/settings", {
    ...plan,
    modelIds: [token],
  });
  assert.equal(denied.status, 400);
  assert.ok(!JSON.stringify(denied.body).includes(token));
  assert.deepEqual(
    (await f.call("alice", "GET", url + "/settings")).body.settings.modelIds,
    [],
  );
});
test("preflight accepts only an empty object, never primitive or array overrides", async (t) => {
  const f = await setup(t);
  for (const input of [true, 0, [], null, ""])
    assert.equal(
      (await f.call("alice", "POST", url + "/preflight", input)).status,
      400,
      JSON.stringify(input),
    );
});
test("production settings, original run and idempotency survive a real store reopen [AC:multi-machine-local-foundation#AC-3]", async (t) => {
  const { dirname } = await import("node:path");
  const first = await boot();
  const stateDir = dirname(first.runtime.store.dbPath);
  first.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  const saved = await first.call("alice", "PATCH", url + "/settings", plan);
  const created = await first.call("alice", "POST", url + "/runs", {
    requestKey: "durable-reopen",
  });
  await first.close();
  const reopened = await boot(false, { stateDir });
  t.after(() => reopened.close());
  reopened.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  assert.deepEqual(
    (await reopened.call("alice", "GET", url + "/settings")).body.settings,
    saved.body.settings,
  );
  assert.equal(
    (
      await reopened.call("alice", "POST", url + "/runs", {
        requestKey: "durable-reopen",
      })
    ).body.run.id,
    created.body.run.id,
  );
  assert.deepEqual(
    (await reopened.call("alice", "GET", url + "/runs/" + created.body.run.id))
      .body.run,
    created.body.run,
  );
});
test("a stale browser revision cannot freeze another saved scope [AC:multi-machine-local-foundation#AC-3]", async (t) => {
  const f = await setup(t);
  const first = await f.call("alice", "PATCH", url + "/settings", plan);
  await f.call("alice", "PATCH", url + "/settings", {
    ...plan,
    repository: "owner/new-scope",
  });
  const stale = await f.call("alice", "POST", url + "/runs", {
    requestKey: "stale-browser",
    expectedRevision: first.body.settings.revision,
  });
  assert.equal(stale.status, 409);
  assert.equal(
    (await f.call("alice", "GET", url + "/runs")).body.runs.length,
    0,
  );
});

test("anonymous, non-admin and cross-admin production access are all isolated [AC:multi-machine-local-foundation#AC-1]", async (t) => {
  const f = await setup(t);
  assert.equal((await fetch(f.url + url + "/settings")).status, 401);
  assert.equal((await f.call("bob", "GET", url + "/settings")).status, 403);
  await f.call("alice", "PATCH", url + "/settings", plan);
  const { body } = await f.call("alice", "POST", url + "/runs", {
    requestKey: "cross-admin",
  });
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='bob'")
    .run();
  assert.equal(
    (await f.call("bob", "GET", url + "/runs/" + body.run.id)).status,
    404,
  );
  assert.equal(
    (await f.call("bob", "POST", url + "/runs/" + body.run.id + "/assess", {}))
      .status,
    404,
  );
  assert.deepEqual((await f.call("bob", "GET", url + "/runs")).body.runs, []);
  assert.equal(
    (await f.call("bob", "GET", url + "/settings")).body.settings.revision,
    undefined,
  );
});
