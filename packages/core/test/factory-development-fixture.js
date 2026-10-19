import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "../dist/storage.js";
import { createBot } from "../dist/bots/index.js";
import { BotRoomService } from "../dist/rooms/index.js";

export async function fixture(t, capacities = [2, 2]) {
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
