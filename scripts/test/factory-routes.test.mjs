import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers/bot-http-fixture.mjs";

test("factory HTTP denies non-admin settings and foreign work, room commands persist without model fanout [AC:multi-machine-readonly-pilot#AC-3] [AC:multi-machine-readonly-pilot#AC-5] [AC:multi-machine-readonly-pilot#AC-13]", async (t) => {
  const f = await boot();
  t.after(() => f.close());
  const denied = await f.call("alice", "PATCH", "/api/factory/settings", {
    machines: [],
  });
  assert.equal(denied.status, 403);
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  const bot = (
    await f.call("alice", "POST", "/api/bots", { name: "Factory Coordinator" })
  ).body.bot;
  const room = (
    await f.call("alice", "POST", "/api/bot-rooms", {
      title: "Factory",
      botIds: [bot.id],
      hostBotId: bot.id,
    })
  ).body.room;
  const input = {
    machines: [
      {
        id: "offline",
        name: "Offline",
        sshAlias: "factory-nonexistent-host",
        capacity: 1,
        botIds: [bot.id],
        allowedUserIds: ["alice"],
        repositories: [{ id: "core", path: "/repo" }],
      },
    ],
    roomId: room.id,
    coordinatorBotId: bot.id,
  };
  assert.equal(
    (await f.call("alice", "PATCH", "/api/factory/settings", input)).status,
    200,
  );
  const dispatched = await f.call(
    "alice",
    "POST",
    `/api/bot-rooms/${room.id}/messages`,
    { text: "/factory run offline core snapshot", idempotencyKey: "one" },
  );
  assert.equal(dispatched.status, 202);
  assert.ok(dispatched.body.task.id);
  assert.equal(dispatched.body.turn.terminationReason, "handled_command");
  const again = await f.call(
    "alice",
    "POST",
    `/api/bot-rooms/${room.id}/messages`,
    { text: "/factory run offline core snapshot", idempotencyKey: "one" },
  );
  assert.equal(again.body.task.id, dispatched.body.task.id);
  assert.equal(
    (await f.call("bob", "GET", "/api/factory/board")).body.tasks.length,
    0,
  );
  assert.equal(
    (
      await f.call(
        "bob",
        "GET",
        `/api/factory/tasks/${dispatched.body.task.id}`,
      )
    ).status,
    403,
  );
  const status = await f.call(
    "alice",
    "POST",
    `/api/bot-rooms/${room.id}/messages`,
    {
      text: "/factory status " + dispatched.body.task.id,
      idempotencyKey: "query",
    },
  );
  assert.equal(status.body.task.id, dispatched.body.task.id);
  const board = (await f.call("alice", "GET", "/api/factory/board")).body;
  assert.equal(board.tasks.length, 1);
  assert.equal(
    (
      await f.call("alice", "POST", "/api/factory/tasks", {
        machineId: "offline",
        repositoryId: "core",
        operation: "push",
        requestKey: "bad",
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call("alice", "GET", "/api/factory/patrol")).body.settings.enabled,
    false,
  );
});

test("rejected factory Room requests leave no tasks or messages [AC:multi-machine-readonly-pilot#AC-3]", async (t) => {
  const f = await boot();
  t.after(() => f.close());
  f.runtime.store.db
    .prepare("UPDATE memberships SET role='admin' WHERE user_id='alice'")
    .run();
  const bot = (
    await f.call("alice", "POST", "/api/bots", { name: "Atomic Coordinator" })
  ).body.bot;
  const room = (
    await f.call("alice", "POST", "/api/bot-rooms", {
      title: "Atomic Factory",
      botIds: [bot.id],
    })
  ).body.room;
  await f.call("alice", "PATCH", "/api/factory/settings", {
    roomId: room.id,
    coordinatorBotId: bot.id,
    machines: [
      {
        id: "u0",
        name: "Worker",
        sshAlias: "factory-invalid-host",
        capacity: 1,
        botIds: [bot.id],
        allowedUserIds: ["alice"],
        repositories: [{ id: "core", path: "/repo" }],
      },
    ],
  });
  for (const extra of [
    { mentions: ["not-a-member"] },
    { attachmentIds: ["missing-image"] },
    { operation: "push" },
  ]) {
    const text = extra.operation
      ? "/factory run u0 core push"
      : "/factory run u0 core snapshot";
    const result = await f.call(
      "alice",
      "POST",
      `/api/bot-rooms/${room.id}/messages`,
      { text, idempotencyKey: JSON.stringify(extra), ...extra },
    );
    assert.ok(result.status >= 400);
    assert.equal(
      (await f.call("alice", "GET", "/api/factory/board")).body.tasks.length,
      0,
    );
    assert.equal(
      (await f.call("alice", "GET", `/api/bot-rooms/${room.id}/messages`)).body
        .messages.length,
      0,
    );
  }
  const original = await f.call(
    "alice",
    "POST",
    `/api/bot-rooms/${room.id}/messages`,
    { text: "/factory run u0 core snapshot", idempotencyKey: "same-key" },
  );
  assert.equal(original.status, 202);
  const conflict = await f.call(
    "alice",
    "POST",
    `/api/bot-rooms/${room.id}/messages`,
    { text: "/factory run u0 core count-files", idempotencyKey: "same-key" },
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await f.call("alice", "GET", "/api/factory/board")).body.tasks.length,
    1,
  );
});
