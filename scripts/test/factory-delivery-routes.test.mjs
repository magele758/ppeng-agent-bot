import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/bot-http-fixture.mjs";
async function configure(t) {
  const f = await boot();
  t.after(() => f.close());
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  const bot = (
      await f.call("alice", "POST", "/api/bots", {
        name: "Delivery coordinator",
      })
    ).body.bot,
    room = (
      await f.call("alice", "POST", "/api/bot-rooms", {
        title: "Delivery",
        botIds: [bot.id],
        hostBotId: bot.id,
      })
    ).body.room;
  const result = await f.call("alice", "PATCH", "/api/factory/settings", {
    roomId: room.id,
    coordinatorBotId: bot.id,
    machines: [
      {
        id: "offline",
        name: "offline",
        sshAlias: "factory-invalid-host",
        capacity: 1,
        botIds: [bot.id],
        allowedUserIds: ["alice"],
        repositories: [{ id: "core", path: "/repo" }],
      },
    ],
  });
  assert.equal(result.status, 200);
  const policy = {
    enabled: true,
    allowedUserIds: ["alice"],
    repository: "owner/trial",
    repositoryNodeId: "R_123",
    target: "main",
    credentialRef: "trial",
    operations: ["push", "pr", "merge"],
    requiredChecks: [{ workflowId: 42, job: "test", appId: 15368 }],
    workflowDigests: { ".github/workflows/ci.yml": "c".repeat(40) },
    mergeMethod: "squash",
    maxRetries: 1,
    deadlineMs: 60000,
    downstream: { confirmed: true, deploys: false },
  };
  return { ...f, room, policy };
}
test("delivery HTTP persists policy behind admin access without exposing credentials [AC:multi-machine-controlled-delivery#AC-1]", async (t) => {
  const f = await configure(t),
    url = "/api/factory/delivery/offline/core";
  assert.equal(
    (await f.call("alice", "GET", url)).body.settings.enabled,
    false,
  );
  assert.equal((await f.call("bob", "PATCH", url, f.policy)).status, 403);
  assert.equal((await f.call("alice", "PATCH", url, f.policy)).status, 200);
  assert.equal(
    (await f.call("alice", "GET", url)).body.settings.repositoryNodeId,
    "R_123",
  );
  assert.equal(
    (
      await f.call("alice", "PATCH", url, {
        ...f.policy,
        token: "do-not-store-credential",
      })
    ).status,
    400,
  );
  assert.equal((await f.call("bob", "GET", url)).status, 404);
});
test("actual HTTP and group cannot elevate a readonly task into remote delivery [AC:multi-machine-controlled-delivery#AC-3]", async (t) => {
  const f = await configure(t);
  assert.equal(
    (
      await f.call(
        "alice",
        "PATCH",
        "/api/factory/delivery/offline/core",
        f.policy,
      )
    ).status,
    200,
  );
  const task = (
    await f.call("alice", "POST", "/api/factory/tasks", {
      machineId: "offline",
      repositoryId: "core",
      operation: "snapshot",
      requestKey: "readonly",
    })
  ).body.task;
  assert.equal(
    (
      await f.call(
        "alice",
        "POST",
        `/api/factory/delivery/tasks/${task.id}/grant`,
        { scope: "MERGED" },
      )
    ).status,
    409,
  );
  const before = f.runtime.store.db
    .prepare("SELECT count(*) AS n FROM factory_delivery")
    .get().n;
  const text =
    "/factory deliver " + JSON.stringify({ taskId: task.id, scope: "MERGED" });
  assert.equal(
    (
      await f.call("alice", "POST", `/api/bot-rooms/${f.room.id}/messages`, {
        text,
        idempotencyKey: "reject-ro",
      })
    ).status,
    409,
  );
  assert.equal(
    f.runtime.store.db
      .prepare("SELECT count(*) AS n FROM factory_delivery")
      .get().n,
    before,
  );
  assert.equal(
    (await f.call("bob", "GET", `/api/factory/delivery/tasks/${task.id}`))
      .status,
    403,
  );
});
test("malformed delivery group commands fail atomically as validation errors", async (t) => {
  const f = await configure(t);
  for (const payload of ["null", "[]", "42", '{"scope":"MERGED"}']) {
    const r = await f.call(
      "alice",
      "POST",
      `/api/bot-rooms/${f.room.id}/messages`,
      {
        text: "/factory deliver " + payload,
        idempotencyKey: "malformed-" + payload,
      },
    );
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  assert.equal(
    f.runtime.store.db
      .prepare("SELECT count(*) AS n FROM factory_delivery")
      .get().n,
    0,
  );
});
test('remote observation HTTP remains task-owner scoped',async t=>{
 const f=await configure(t);const {task}= (await f.call('alice','POST','/api/factory/tasks',{machineId:'offline',repositoryId:'core',operation:'snapshot',requestKey:'observe-owner'})).body;
 f.runtime.factory.delivery.verifyRemote=async(p,id)=>{f.runtime.factory.get(p,id);return {taskId:id,stage:'WAITING_DECISION',deployment:'not_deployed'};};
 assert.equal((await f.call('alice','POST',`/api/factory/delivery/tasks/${task.id}/verify`,{})).status,200);assert.equal((await f.call('bob','POST',`/api/factory/delivery/tasks/${task.id}/verify`,{})).status,403);
});
