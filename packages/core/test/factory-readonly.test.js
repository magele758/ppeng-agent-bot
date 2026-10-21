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
test("saved machine settings survive reopening and apply immediately [AC:multi-machine-readonly-pilot#AC-1]", async (t) => {
  const f = await fixture(t);
  const { FactoryService } = await import("../dist/factory/service.js");
  f.service.saveSettings(f.principal, {
    machines: f.machines.map((m) => ({ ...m, capacity: 1 })),
    roomId: f.room.id,
    coordinatorBotId: f.bots[0].id,
  });
  const other = new FactoryService(f.host, f.transport);
  assert.equal(other.settings(f.principal).machines[0].capacity, 1);
  await other.close();
});
test("connection probe exposes identity and sanitized failure [AC:multi-machine-readonly-pilot#AC-2]", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.probe(f.principal, "u0")).identity, "host-u0");
  f.setOnline(false);
  assert.equal((await f.service.probe(f.principal, "u0")).online, false);
});
test("room dispatch creates durable work and starts in background [AC:multi-machine-readonly-pilot#AC-3]", async (t) => {
  const f = await fixture(t);
  const task = f.service.fromRoom(
    f.principal,
    f.room.id,
    "/factory run u0 core snapshot",
    "room-message-1",
  );
  assert.ok(task.id);
  await f.service.tick();
  assert.deepEqual(f.starts, [task.id]);
  assert.equal(f.service.get(f.principal, task.id).status, "running");
});
test("duplicate room dispatch and retry start only once [AC:multi-machine-readonly-pilot#AC-4]", async (t) => {
  const f = await fixture(t);
  const a = f.submit({ requestKey: "same" }),
    b = f.submit({ requestKey: "same" });
  assert.equal(a.id, b.id);
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.starts.length, 1);
});
test("unauthorized principals and missing machines cannot submit [AC:multi-machine-readonly-pilot#AC-5]", async (t) => {
  const f = await fixture(t);
  assert.throws(() =>
    f.service.submit(
      { userId: "intruder", tenantId: "team" },
      { machineId: "u0" },
    ),
  );
  assert.throws(() => f.submit({ machineId: "missing" }));
  assert.equal(f.starts.length, 0);
});
test("execution carries configured target repository and identity [AC:multi-machine-readonly-pilot#AC-6]", async (t) => {
  const f = await fixture(t);
  const a = f.submit({ machineId: "u1" });
  await f.service.tick();
  f.finish(a.id);
  await settle();
  const task = f.service.get(f.principal, a.id);
  assert.equal(task.identity, "host-u1");
  assert.equal(task.result.path, "/repo");
  assert.equal(task.repositoryPath, "/repo");
});
test("mutation requests and shell payloads are refused before execution [AC:multi-machine-readonly-pilot#AC-7]", async (t) => {
  const f = await fixture(t);
  for (const operation of [
    "push",
    "merge",
    "deploy",
    "install",
    "delete",
    "snapshot; git push",
    "snapshot\nrm -rf /repo",
  ])
    assert.throws(() => f.submit({ operation }));
  assert.throws(() => f.submit({ command: "git push" }));
  await f.service.tick();
  assert.equal(f.starts.length, 0);
});
test("atomic claims honor machine capacity across services and ingress [AC:multi-machine-readonly-pilot#AC-8]", async (t) => {
  const f = await fixture(t, [2]);
  const { FactoryService } = await import("../dist/factory/service.js");
  const peer = new FactoryService(f.host, f.transport);
  for (let i = 0; i < 8; i++) f.submit();
  await Promise.all([f.service.tick(), peer.tick()]);
  assert.equal(f.starts.length, 2);
  assert.equal(
    f.service.list(f.principal).filter((x) => x.status === "queued").length,
    6,
  );
  await peer.close();
});
test("bots bound to same machine share execution capacity [AC:multi-machine-readonly-pilot#AC-9]", async (t) => {
  const f = await fixture(t, [1]);
  f.submit({ botId: f.bots[0].id });
  f.submit({ botId: f.bots[1].id });
  await f.service.tick();
  assert.equal(f.starts.length, 1);
});
test("zero capacity refuses rather than creating endless queue [AC:multi-machine-readonly-pilot#AC-10]", async (t) => {
  const f = await fixture(t, [0]);
  assert.throws(() => f.submit(), /capacity|容量/i);
  assert.equal(f.service.list(f.principal).length, 0);
});
test("verified completion starts earliest eligible queued task [AC:multi-machine-readonly-pilot#AC-11]", async (t) => {
  const f = await fixture(t, [1]);
  const a = f.submit(),
    b = f.submit(),
    c = f.submit();
  await f.service.tick();
  f.finish(a.id);
  await settle();
  await f.service.tick();
  assert.deepEqual(f.starts, [a.id, b.id]);
  assert.equal(f.service.get(f.principal, c.id).status, "queued");
});
test("offline running tasks remain unknown and hold capacity [AC:multi-machine-readonly-pilot#AC-12]", async (t) => {
  const f = await fixture(t, [1]);
  const a = f.submit();
  await f.service.tick();
  f.setOnline(false);
  f.advance(31000);
  await f.service.tick();
  assert.equal(f.service.get(f.principal, a.id).status, "unknown");
  assert.equal(f.service.board(f.principal).machines[0].occupied, 1);
  f.submit();
  await f.service.tick();
  assert.equal(f.starts.length, 1);
});
test("board detail and room status use one task record [AC:multi-machine-readonly-pilot#AC-13]", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  const task = f.service.get(f.principal, a.id);
  assert.deepEqual(f.service.board(f.principal).tasks[0], task);
  assert.equal(
    f.service.fromRoom(
      f.principal,
      f.room.id,
      "/factory status " + a.id,
      "query",
    ).id,
    a.id,
  );
});
test("task timeline proves queue execution and read-only completion [AC:multi-machine-readonly-pilot#AC-14]", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  f.finish(a.id);
  await settle();
  const b = f.service.get(f.principal, a.id);
  assert.deepEqual(
    b.history.map((h) => h.status),
    ["queued", "running", "succeeded"],
  );
  assert.ok(b.startedAt && b.finishedAt);
  assert.equal(b.result.sha, "abc");
});
test("confirmed timeout releases slot while unverified timeout stays unknown [AC:multi-machine-readonly-pilot#AC-15]", async (t) => {
  const f = await fixture(t);
  const a = f.submit({ timeoutMs: 1000 });
  await f.service.tick();
  f.finish(a.id, "timed_out");
  await settle();
  assert.equal(f.service.get(f.principal, a.id).status, "timed_out");
  assert.ok(f.service.get(f.principal, a.id).error);
  const b = f.submit({ timeoutMs: 1000 });
  await f.service.tick();
  f.setOnline(false);
  f.advance(31000);
  await f.service.tick();
  assert.equal(f.service.get(f.principal, b.id).status, "unknown");
});
test("restart reconciles existing executions without replay [AC:multi-machine-readonly-pilot#AC-16]", async (t) => {
  const f = await fixture(t, [1]);
  const a = f.submit(),
    b = f.submit();
  await f.service.tick();
  const { FactoryService } = await import("../dist/factory/service.js");
  const recovered = new FactoryService(
    f.host,
    f.transport,
    () => Date.now() + 60000,
  );
  await recovered.tick();
  assert.equal(f.starts.length, 1);
  f.reports.set(a.id, {
    status: "succeeded",
    seq: 2,
    finished: true,
    identity: "host-u0",
    result: { sha: "abc" },
  });
  await recovered.tick();
  assert.equal(recovered.get(f.principal, a.id).status, "succeeded");
  assert.deepEqual(f.starts, [a.id, b.id]);
  await recovered.close();
});
test("late and duplicate reports cannot rewind terminal results [AC:multi-machine-readonly-pilot#AC-17]", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  f.finish(a.id);
  await settle();
  f.service.acceptReport(a.id, { status: "running", seq: 1 });
  assert.equal(f.service.get(f.principal, a.id).status, "succeeded");
});
test("outbox retries post one result and do not schedule room bots [AC:multi-machine-readonly-pilot#AC-18]", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  f.finish(a.id);
  await settle();
  await f.service.tick();
  await f.service.tick();
  const messages = f.host.rooms
    .messages(f.principal, f.room.id)
    .messages.filter(
      (m) => m.text.includes(a.id) && m.text.includes("succeeded"),
    );
  assert.equal(messages.length, 1);
  assert.equal(f.host.rooms.turns(f.principal, f.room.id).length, 0);
});
test("hourly Shanghai patrol starts paused and stops when paused [AC:multi-machine-readonly-pilot#AC-19]", async (t) => {
  const f = await fixture(t);
  assert.equal(f.service.settings(f.principal).patrol.enabled, false);
  assert.equal(
    f.service.settings(f.principal).patrol.timezone,
    "Asia/Shanghai",
  );
  f.service.setPatrol(f.principal, true);
  await f.service.tick();
  const first = f.service.patrolState(f.principal).lastRunAt;
  f.service.setPatrol(f.principal, false);
  f.advance(3600001);
  await f.service.tick();
  assert.equal(f.service.patrolState(f.principal).lastRunAt, first);
});
test("cheap patrol skips network and notifications for unchanged work [AC:multi-machine-readonly-pilot#AC-20]", async (t) => {
  const f = await fixture(t);
  await f.service.patrol(f.principal);
  assert.equal(f.probes.length, 0);
  assert.equal(f.inspections.length, 0);
  const a = f.submit();
  await f.service.tick();
  await f.service.patrol(f.principal);
  const n = f.inspections.length;
  await f.service.patrol(f.principal);
  assert.equal(f.inspections.length, n);
  assert.equal(
    f.host.rooms.messages(f.principal, f.room.id).messages.length,
    0,
  );
});
test("stale execution is inspected on all four signals before nudge [AC:multi-machine-readonly-pilot#AC-21]", async (t) => {
  const f = await fixture(t, [1]);
  const a = f.submit();
  f.submit();
  await f.service.tick();
  f.advance(3600001);
  await f.service.patrol(f.principal);
  const entry = f.service.patrolState(f.principal).checks[a.id];
  assert.deepEqual(Object.keys(entry.signals).sort(), [
    "commit",
    "cpu",
    "fresh",
    "process",
  ]);
  assert.equal(f.inspections.length, 1);
  assert.equal(
    f.host.rooms.messages(f.principal, f.room.id).messages.length,
    1,
  );
});
test("patrol dedupe survives restart and quiet hours suppress routine updates [AC:multi-machine-readonly-pilot#AC-22]", async (t) => {
  const f = await fixture(t);
  f.submit();
  await f.service.tick();
  f.advance(3600001);
  await f.service.patrol(f.principal);
  const { FactoryService } = await import("../dist/factory/service.js");
  const peer = new FactoryService(f.host, f.transport, () =>
    Date.parse("2026-10-19T19:00:00Z"),
  );
  await peer.patrol(f.principal);
  assert.equal(
    f.host.rooms.messages(f.principal, f.room.id).messages.length,
    1,
  );
  await peer.close();
});
test("two-target pilot evidence requires distinct identities and matching snapshots [AC:multi-machine-readonly-pilot#AC-23]", async (t) => {
  const f = await fixture(t);
  const a = f.submit(),
    b = f.submit({ machineId: "u1" });
  await f.service.tick();
  f.finish(a.id);
  f.finish(b.id);
  await settle();
  const evidence = f.service.pilotEvidence(f.principal);
  assert.equal(evidence.tasks.length, 2);
  assert.equal(new Set(evidence.tasks.map((x) => x.identity)).size, 2);
  assert.equal(
    evidence.tasks.every((x) => x.result.sha === "abc"),
    true,
  );
});

test("disconnect recovery accepts verified result without losing remote sequence", async (t) => {
  const f = await fixture(t, [1]);
  const a = f.submit();
  await f.service.tick();
  f.setOnline(false);
  await f.service.tick();
  assert.equal(f.service.get(f.principal, a.id).status, "unknown");
  f.setOnline(true);
  f.reports.set(a.id, {
    status: "succeeded",
    seq: 2,
    identity: "host-u0",
    finished: true,
    result: { sha: "verified" },
  });
  await f.service.tick();
  assert.equal(f.service.get(f.principal, a.id).result.sha, "verified");
  assert.equal(f.starts.length, 1);
});
test("SSH aliases resolving to one identity cannot bypass capacity", async (t) => {
  const f = await fixture(t, [1, 1]);
  f.transport.probe = async () => ({ identity: "same-host", hostname: "same" });
  f.submit();
  f.submit({ machineId: "u1" });
  await f.service.tick();
  assert.equal(f.starts.length, 1);
});
test("remote identity mismatch cannot produce a successful task", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  f.service.acceptReport(a.id, {
    status: "succeeded",
    seq: 2,
    identity: "wrong-host",
    finished: true,
    result: { sha: "wrong" },
  });
  assert.equal(f.service.get(f.principal, a.id).status, "unknown");
  assert.equal(f.service.get(f.principal, a.id).result, undefined);
});
test("factory results redact credential-shaped log text before persistence or notification [AC:multi-machine-readonly-pilot#AC-2]", async (t) => {
  const f = await fixture(t);
  const a = f.submit();
  await f.service.tick();
  f.service.acceptReport(a.id, {
    status: "succeeded",
    seq: 2,
    identity: "host-u0",
    finished: true,
    result: {
      log: "Authorization: Bearer example-private-token\napi_key=example-private-key",
    },
  });
  await f.service.tick();
  const text =
    JSON.stringify(f.service.get(f.principal, a.id)) +
    JSON.stringify(f.host.rooms.messages(f.principal, f.room.id));
  assert.ok(!text.includes("example-private-token"));
  assert.ok(!text.includes("example-private-key"));
});

test("coordinator tool converts a human Room request to a task and refuses another member [AC:multi-machine-readonly-pilot#AC-3]", async (t) => {
  const f = await fixture(t);
  const { createFactoryTools } = await import("../dist/factory/tools.js");
  const dispatch = createFactoryTools(f.store, f.host.rooms, f.service).find(
    (x) => x.name === "factory_dispatch",
  );
  const turn = f.host.rooms.send(f.principal, f.room.id, {
    text: "给 Ubuntu0 派一个读取分支和提交的只读任务",
  }).turn;
  const session = f.store.createSession({
    title: "Coordinator request",
    mode: "chat",
    agentId: f.bots[0].agentId,
    metadata: { ...f.principal, roomId: f.room.id, botId: f.bots[0].id },
  });
  turn.status = "running";
  turn.currentSessionId = session.id;
  f.store.db
    .prepare("UPDATE bot_room_turns SET status=?,data=? WHERE id=?")
    .run("running", JSON.stringify(turn), turn.id);
  const args = { machineId: "u0", repositoryId: "core", operation: "snapshot" };
  const result = await dispatch.execute({ session }, args);
  assert.equal(result.ok, true);
  assert.ok(JSON.parse(result.content).id);
  const again = await dispatch.execute({ session }, args);
  assert.equal(JSON.parse(again.content).id, JSON.parse(result.content).id);
  const unauthorized = await dispatch.execute(
    {
      session: {
        ...session,
        metadata: { ...session.metadata, botId: f.bots[1].id },
      },
    },
    args,
  );
  assert.equal(unauthorized.ok, false);
});

test("factory bots and room cannot escape read-only mode through shell or dynamic tools [AC:multi-machine-readonly-pilot#AC-7]", async (t) => {
  const f = await fixture(t);
  f.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  const { filterToolsForSession, resolveTurnTools } =
    await import("../dist/turn/resolve-turn-tools.js");
  const names = [
    "bash",
    "write_file",
    "ptc_exec",
    "factory_dispatch",
    "factory_status",
    "malicious_dynamic",
  ];
  const tools = names.map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    execute: async () => ({ ok: true, content: "" }),
  }));
  const session = {
    id: "factory-session",
    mode: "chat",
    metadata: { ...f.principal, botId: f.bots[0].id, roomId: f.room.id },
  };
  const input = {
    env: {},
    tools,
    agent: { id: "general" },
    session,
    settingsStore: f.store,
    sessionId: session.id,
    systemPromptChars: 100,
    dynTools: [tools.at(-1)],
  };
  assert.deepEqual(
    filterToolsForSession(input).tools.map((x) => x.name),
    ["factory_dispatch", "factory_status"],
  );
  assert.deepEqual(
    resolveTurnTools(input).turnTools.map((x) => x.name),
    ["factory_dispatch", "factory_status"],
  );
  const privateChat = {
    ...session,
    metadata: { ...f.principal, botId: f.bots[1].id },
  };
  assert.deepEqual(
    filterToolsForSession({ ...input, session: privateChat }).tools.map(
      (x) => x.name,
    ),
    ["factory_status"],
  );
});
