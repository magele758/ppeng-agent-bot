import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "../dist/storage.js";
import { createBot } from "../dist/bots/index.js";
import { BotRoomService } from "../dist/rooms/index.js";

async function fixture(t, capacities = [2, 2]) {
  const { FactoryService } = await import("../dist/factory/service.js");
  const dir = mkdtempSync(join(tmpdir(), "factory-test-")),
    store = new SqliteStateStore(join(dir, "db"));
  const facade = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
  };
  const principal = { userId: "owner", tenantId: "team" };
  const bots = [
    createBot(facade, { name: "Coordinator" }),
    createBot(facade, { name: "Worker" }),
  ];
  for (const bot of bots)
    store.updateSession(bot.canonicalSessionId, {
      metadata: {
        ...store.getSession(bot.canonicalSessionId).metadata,
        ...principal,
      },
    });
  const rooms = new BotRoomService({
    store,
    createChatSession() {
      throw Error("No model should run");
    },
    runSession() {
      throw Error("No model should run");
    },
    cancelSession() {},
  });
  const room = rooms.create(principal, {
    title: "Factory",
    botIds: bots.map((b) => b.id),
    hostBotId: bots[0].id,
  });
  let now = Date.parse("2026-10-18T04:00:00Z");
  const starts = [],
    probes = [],
    inspections = [],
    pending = new Map(),
    reports = new Map();
  let online = true;
  const transport = {
    async probe(m) {
      probes.push(m.id);
      if (!online) throw Error("unreachable");
      return { identity: "host-" + m.id, hostname: m.id };
    },
    async start(m, task) {
      starts.push(task.id);
      return new Promise((resolve) => pending.set(task.id, resolve));
    },
    async status(m, task) {
      if (!online) throw Error("unreachable");
      return (
        reports.get(task.id) ?? {
          status: "running",
          identity: "host-" + m.id,
          seq: 1,
        }
      );
    },
    async inspect(m, task) {
      inspections.push(task.id);
      return { process: false, fresh: false, commit: "abc", cpu: 0 };
    },
  };
  const host = { store, rooms };
  const service = new FactoryService(host, transport, () => now);
  const machines = capacities.map((capacity, i) => ({
    id: "u" + i,
    name: "Ubuntu" + i,
    sshAlias: "ubuntu" + i,
    capacity,
    botIds: bots.map((b) => b.id),
    allowedUserIds: ["owner"],
    repositories: [{ id: "core", path: "/repo" }],
  }));
  service.saveSettings(principal, {
    machines,
    roomId: room.id,
    coordinatorBotId: bots[0].id,
  });
  const submit = (extra = {}) =>
    service.submit(principal, {
      machineId: "u0",
      repositoryId: "core",
      operation: "snapshot",
      requestKey: "request-" + Math.random(),
      roomId: room.id,
      ...extra,
    });
  const finish = (id, status = "succeeded", seq = 2) => {
    const r = {
      status,
      seq,
      identity: "host-" + service.get(principal, id).machineId,
      result: { branch: "main", sha: "abc", path: "/repo" },
      error: status === "succeeded" ? undefined : "failure",
      finished: true,
    };
    reports.set(id, r);
    pending.get(id)?.(r);
  };
  t.after(async () => {
    await service.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    service,
    host,
    transport,
    store,
    principal,
    bots,
    room,
    machines,
    starts,
    probes,
    inspections,
    submit,
    finish,
    reports,
    pending,
    setOnline(v) {
      online = v;
    },
    advance(ms) {
      now += ms;
    },
  };
}
const settle = () => new Promise((r) => setImmediate(r));
test("queued removal and access revocation fail affected tasks without starving other machines", async (t) => {
  for (const revoke of [false, true]) {
    const f = await fixture(t);
    const a = f.submit();
    const b = f.submit({ machineId: "u1" });
    const machines = structuredClone(f.machines);
    if (revoke) machines[0].allowedUserIds = [];
    else machines.shift();
    f.service.saveSettings(f.principal, {
      machines,
      roomId: f.room.id,
      coordinatorBotId: f.bots[0].id,
    });
    await f.service.tick();
    assert.equal(f.service.get(f.principal, a.id).status, "failed");
    assert.match(
      f.service.get(f.principal, a.id).error,
      /configuration|permission|machine/i,
    );
    assert.equal(f.service.get(f.principal, b.id).status, "running");
  }
});
test("closing during probe cannot start work or access closed storage", async (t) => {
  const f = await fixture(t);
  f.submit();
  let release;
  f.transport.probe = () => new Promise((r) => (release = r));
  const tick = f.service.tick();
  await settle();
  const closing = f.service.close();
  release({ identity: "host-u0", hostname: "u0" });
  await tick;
  await closing;
  assert.equal(f.starts.length, 0);
});
test("closing during status reconciliation prevents later storage writes", async (t) => {
  const f = await fixture(t);
  f.submit();
  await f.service.tick();
  let release;
  f.transport.status = () => new Promise((r) => (release = r));
  const tick = f.service.tick();
  await settle();
  const closing = f.service.close();
  f.advance(1000);
  release({ status: "running", seq: 1, identity: "host-u0" });
  await tick;
  await closing;
  assert.equal(
    f.service.settings(f.principal).machines[0].checkedAt,
    f.service.get(f.principal, f.starts[0]).startedAt,
  );
});
test("closing during patrol inspect prevents storage writes and notifications", async (t) => {
  const f = await fixture(t);
  f.submit();
  await f.service.tick();
  f.advance(3600001);
  let release;
  f.transport.inspect = () => new Promise((r) => (release = r));
  const patrol = f.service.patrol(f.principal);
  await settle();
  await f.service.close();
  const before = f.service.patrolState(f.principal);
  release({ process: false, fresh: false, commit: "abc", cpu: 0 });
  await patrol;
  assert.deepEqual(f.service.patrolState(f.principal), before);
});
test("status acknowledgements contain canonical progress and scope query dedupe to the task", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  const b = f.submit();
  await f.service.tick();
  f.finish(a.id);
  await settle();
  f.service.acknowledge(f.service.get(f.principal, a.id), "query");
  f.service.acknowledge(f.service.get(f.principal, b.id), "query");
  const rows = f.store.db
    .prepare("SELECT body FROM factory_outbox WHERE key LIKE 'ack:%'")
    .all();
  assert.equal(rows.length, 2);
  assert.match(rows[0].body, /updatedAt/);
  assert.match(rows[0].body, /abc/);
});
test("factory transactions compose with a room atomic transaction", async (t) => {
  const f = await fixture(t);
  f.store.db.exec("BEGIN IMMEDIATE");
  try {
    f.submit();
    f.store.db.exec("COMMIT");
  } catch (e) {
    f.store.db.exec("ROLLBACK");
    throw e;
  }
  assert.equal(f.service.list(f.principal).length, 1);
});
test("paused room refuses new dispatch while retaining task status access", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  f.host.rooms.patch(f.principal, f.room.id, { status: "paused" });
  assert.throws(
    () =>
      f.service.fromRoom(
        f.principal,
        f.room.id,
        "/factory run u0 core snapshot",
        "paused-request",
      ),
    /paused/i,
  );
  assert.equal(
    f.service.fromRoom(
      f.principal,
      f.room.id,
      `/factory status ${a.id}`,
      "query",
    ).id,
    a.id,
  );
  assert.equal(f.service.list(f.principal).length, 1);
});
test("endpoint edits during a probe cannot reuse the old host identity to bypass capacity", async (t) => {
  const f = await fixture(t, [1, 1]);
  f.submit({ machineId: "u1" });
  await f.service.tick();
  f.submit();
  let release;
  f.transport.probe = (m) =>
    m.id === "u0"
      ? new Promise((r) => (release = r))
      : Promise.resolve({ identity: "host-u1", hostname: "u1" });
  const tick = f.service.tick();
  await settle();
  const cfg = f.service.settings(f.principal);
  cfg.machines[0].sshAlias = "second-alias-of-u1";
  f.service.saveSettings(f.principal, cfg);
  release({ identity: "host-u0", hostname: "old-u0" });
  await tick;
  assert.equal(f.starts.length, 1);
  assert.equal(f.service.settings(f.principal).machines[0].identity, undefined);
  f.transport.probe = async () => ({ identity: "host-u1", hostname: "u1" });
  await f.service.tick();
  assert.equal(f.starts.length, 1);
});
test("removal and revoked access during a probe discard stale connection metadata", async (t) => {
  for (const revoke of [false, true]) {
    const f = await fixture(t);
    const task = f.submit();
    let release;
    f.transport.probe = () => new Promise((r) => (release = r));
    const tick = f.service.tick();
    await settle();
    const cfg = f.service.settings(f.principal);
    if (revoke) cfg.machines[0].allowedUserIds = [];
    else cfg.machines.shift();
    f.service.saveSettings(f.principal, cfg);
    release({ identity: "stale-host", hostname: "stale" });
    await tick;
    assert.equal(f.starts.length, 0);
    assert.equal(f.service.get(f.principal, task.id).status, "failed");
    const current = f.service
      .settings(f.principal)
      .machines.find((m) => m.id === "u0");
    if (current) assert.equal(current.identity, undefined);
  }
});
