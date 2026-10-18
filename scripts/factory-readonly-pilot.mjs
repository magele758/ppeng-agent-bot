#!/usr/bin/env node
/** Explicit real-host pilot. Config comes from a local JSON file, never personal paths in source.
 * Creates an isolated local daemon and factory objects; remote writes are factory receipts only.
 * Usage: node scripts/factory-readonly-pilot.mjs <config.json> <evidence-directory>
 * config: { machines:[{id,name,sshAlias,capacity,repositoryPath}] }
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  RawAgentRuntime,
  AuthStore,
  resolveBotPrincipal,
  sanitizeSpawnEnv,
} from "@ppeng/agent-core";
import { createDaemonApp } from "../apps/daemon/dist/app.js";

const [configPath, outPath] = process.argv.slice(2);
if (!configPath || !outPath)
  throw Error("Expected config JSON path and evidence directory");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!Array.isArray(config.machines) || config.machines.length < 2)
  throw Error("At least two real machines required");
const out = resolve(outPath);
mkdirSync(out, { recursive: true });
const stateDir = mkdtempSync(join(out, "state-"));
const runtime = new RawAgentRuntime({
  repoRoot: process.cwd(),
  stateDir,
  modelAdapter: {
    name: "pilot-no-model",
    async runTurn() {
      throw Error("Pilot command must not call a model");
    },
    async summarizeMessages() {
      return "";
    },
  },
});
const principal = resolveBotPrincipal(runtime.store);
const coordinator = runtime.createBot({ name: "工厂-协调员" }),
  workers = config.machines.map((m) =>
    runtime.createBot({ name: "工厂-" + m.name }),
  );
const room = runtime.rooms.create(principal, {
  title: "工厂-多机开发协作",
  botIds: [coordinator.id, ...workers.map((b) => b.id)],
  hostBotId: coordinator.id,
});
const app = createDaemonApp({
  runtime,
  authStore: new AuthStore(runtime.store.db),
  env: {},
  repoRoot: process.cwd(),
  config: { storageCtx: {}, domainsMounted: [] },
  pkgName: "factory-pilot",
  pkgVersion: "1",
  readBody: async (req) => {
    let text = "";
    for await (const p of req) text += p;
    return text ? JSON.parse(text) : {};
  },
  readBodyLimit: 1000000,
});
const server = createServer(async (req, res) => {
  try {
    if (!(await app.handle(req, res))) {
      res.statusCode = 404;
      res.end("{}");
    }
  } catch (e) {
    res.statusCode = e.statusCode ?? 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(JSON.stringify({ status: response.status, result }));
  return result;
}
function direct(machine) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(machine.sshAlias))
    throw Error("Invalid alias");
  // Separate direct observation: encode the configured repository path as JSON into a fixed Python reader.
  const data = Buffer.from(JSON.stringify(machine.repositoryPath)).toString(
    "base64",
  );
  const program = `import base64,json,subprocess,hashlib; p=json.loads(base64.b64decode('${data}')); g=lambda *a:subprocess.check_output(['git','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',p,*a],stderr=subprocess.PIPE).decode().strip();print(json.dumps({'branch':g('rev-parse','--abbrev-ref','HEAD'),'sha':g('rev-parse','HEAD'),'status':g('status','--porcelain=v1','--untracked-files=normal'),'contentDigest':hashlib.sha256(g('diff','--no-ext-diff','--no-textconv','--binary','HEAD').encode()).hexdigest()}))`;
  const encoded = Buffer.from(program).toString("base64");
  const r = spawnSync(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      machine.sshAlias,
      `python3 -I -c "import base64;exec(base64.b64decode('${encoded}'))"`,
    ],
    {
      encoding: "utf8",
      timeout: 20000,
      env: sanitizeSpawnEnv({ stripCredentials: true }),
    },
  );
  if (r.status !== 0) throw Error("Independent read failed");
  const v = JSON.parse(r.stdout);
  return {
    ...v,
    status: undefined,
    statusDigest: createHash("sha256").update(v.status).digest("hex"),
  };
}
try {
  const before = config.machines.map(direct);
  await call("PATCH", "/api/factory/settings", {
    roomId: room.id,
    coordinatorBotId: coordinator.id,
    machines: config.machines.map((m, i) => ({
      id: m.id,
      name: m.name,
      sshAlias: m.sshAlias,
      capacity: m.capacity,
      botIds: [workers[i].id],
      allowedUserIds: [principal.userId],
      repositories: [{ id: "core", path: m.repositoryPath }],
    })),
  });
  const probes = [];
  for (const m of config.machines)
    probes.push(await call("POST", `/api/factory/machines/${m.id}/probe`, {}));
  if (
    probes.some((p) => !p.online) ||
    new Set(probes.map((p) => p.identity)).size !== config.machines.length
  )
    throw Error("Machines unavailable or not distinct");
  const tasks = [];
  for (const m of config.machines) {
    const result = await call("POST", `/api/bot-rooms/${room.id}/messages`, {
      text: `/factory run ${m.id} core snapshot`,
      idempotencyKey: "pilot-" + m.id,
    });
    tasks.push(result.task.id);
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await runtime.factory.tick();
    const board = await call("GET", "/api/factory/board");
    if (
      tasks.every(
        (id) => board.tasks.find((t) => t.id === id)?.status === "succeeded",
      )
    )
      break;
    if (
      board.tasks.some((t) =>
        ["failed", "timed_out", "unknown"].includes(t.status),
      )
    )
      throw Error("Real execution requires attention");
    await new Promise((r) => setTimeout(r, 200));
  }
  const board = await call("GET", "/api/factory/board"),
    evidence = await call("GET", "/api/factory/evidence"),
    messages = (await call("GET", `/api/bot-rooms/${room.id}/messages`))
      .messages;
  const after = config.machines.map(direct);
  for (let i = 0; i < tasks.length; i++) {
    const task = board.tasks.find((t) => t.id === tasks[i]);
    if (
      task?.status !== "succeeded" ||
      JSON.stringify(before[i]) !== JSON.stringify(after[i]) ||
      task.result.sha !== after[i].sha ||
      task.result.branch !== after[i].branch
    )
      throw Error("Snapshot mismatch or repository changed");
  }
  const document = {
    at: new Date().toISOString(),
    passed: true,
    stateDir,
    roomId: room.id,
    probes,
    observations: config.machines.map((m, i) => ({
      machineId: m.id,
      before: before[i],
      after: after[i],
      unchanged: JSON.stringify(before[i]) === JSON.stringify(after[i]),
    })),
    ...evidence,
    messages,
    notes: [
      "Only remote factory receipt files were written. No repository writes, installs, pushes, merges, deployments, or service restarts were requested.",
      "Existing remote services were not stopped or restarted.",
    ],
  };
  writeFileSync(
    join(out, "evidence.json"),
    JSON.stringify(document, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        machines: config.machines.map((m) => m.id),
        tasks,
        evidence: join(out, "evidence.json"),
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((r) => server.close(r));
  await runtime.destroy();
}
