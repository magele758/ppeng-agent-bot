#!/usr/bin/env node
/** Explicit isolated two-host GitHub trial. Private configuration stays outside Git. */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  RawAgentRuntime,
  AuthStore,
  resolveBotPrincipal,
  sanitizeSpawnEnv,
} from "@ppeng/agent-core";
import { createDaemonApp } from "../apps/daemon/dist/app.js";
import { verifyDeliveryPilot } from "../packages/core/dist/factory/delivery-policy.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] === "--serve") {
  const [stateDir, addressFile, lostFile] = process.argv.slice(3);
  const runtime = new RawAgentRuntime({
    repoRoot: process.cwd(),
    stateDir,
    modelAdapter: {
      name: "delivery-coordinator-no-model",
      async runTurn() {
        throw Error("Explicit factory commands only");
      },
      async summarizeMessages() {
        return "";
      },
    },
  });
  const transport = runtime.factory.transport,
    original = transport.delivery.bind(transport);
  transport.delivery = async (...args) => {
    const value = await original(...args);
    if (args[1].action === "push" && !existsSync(lostFile)) {
      writeFileSync(
        lostFile,
        JSON.stringify({
          at: new Date().toISOString(),
          taskId: args[1].taskId,
          operationId: args[1].operationId,
          sha: args[1].sha,
        }),
      );
      throw Error(
        "Approved trial: discard actual successful remote write response",
      );
    }
    return value;
  };
  const app = createDaemonApp({
    runtime,
    authStore: new AuthStore(runtime.store.db),
    env: {},
    repoRoot: process.cwd(),
    config: { storageCtx: {}, domainsMounted: [] },
    pkgName: "factory-delivery-pilot",
    pkgVersion: "1",
    readBody: async (req) => {
      let text = "";
      for await (const x of req) {
        text += x;
        if (text.length > 1000000) throw Error("body limit");
      }
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
  writeFileSync(
    addressFile,
    JSON.stringify({
      base: `http://127.0.0.1:${server.address().port}`,
      principal: resolveBotPrincipal(runtime.store),
      pid: process.pid,
    }),
  );
  const timer = setInterval(
    () => void runtime.factory.tick().catch(() => {}),
    1000,
  );
  process.on("SIGTERM", async () => {
    clearInterval(timer);
    server.close();
    await runtime.destroy();
    process.exit(0);
  });
} else {
  const [configFile, outPath] = process.argv.slice(2);
  if (!configFile || !outPath)
    throw Error("Private config and evidence directory required");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const out = resolve(outPath);
  mkdirSync(out, { recursive: true });
  const state = join(out, "state"),
    addressFile = join(out, "address.json"),
    lostFile = join(out, "lost-response.json");
  mkdirSync(state, { recursive: true });
  let child, base, principal;
  const env = sanitizeSpawnEnv({ stripCredentials: true });
  async function start() {
    const old = existsSync(addressFile)
      ? readFileSync(addressFile, "utf8")
      : null;
    child = spawn(
      process.execPath,
      [resolve(process.argv[1]), "--serve", state, addressFile, lostFile],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (x) => (errors = (errors + x).slice(-16000)));
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error("Coordinator failed: " + errors);
      if (
        existsSync(addressFile) &&
        readFileSync(addressFile, "utf8") !== old
      ) {
        ({ base, principal } = JSON.parse(readFileSync(addressFile, "utf8")));
        return;
      }
      await pause(100);
    }
    throw Error("Coordinator startup timeout");
  }
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((cause) => {
      throw new Error(`Trial ${method} ${path} transport failed`, { cause });
    });
    const value = await res.json();
    if (!res.ok)
      throw Error(JSON.stringify({ path, status: res.status, result: value }));
    return value;
  }
  function remote(m, program) {
    const r = spawnSync(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "--",
        m.sshAlias,
        `python3 -I -c "import base64;exec(base64.b64decode('${Buffer.from(program).toString("base64")}'))"`,
      ],
      { env, encoding: "utf8", timeout: 30000, maxBuffer: 2097152 },
    );
    if (r.status !== 0)
      throw Error(
        "Independent host verification failed: " + r.stderr.slice(-500),
      );
    return JSON.parse(r.stdout);
  }
  function source(m) {
    return remote(
      m,
      `import json,pathlib,subprocess,hashlib\np=${JSON.stringify(m.repositoryPath)}\ng=lambda *a:subprocess.check_output(['git','--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',p,*a],text=True).strip()\nprint(json.dumps({'identity':hashlib.sha256(pathlib.Path('/etc/machine-id').read_bytes().strip()).hexdigest(),'head':g('rev-parse','HEAD'),'refs':g('show-ref'),'branch':g('rev-parse','--abbrev-ref','HEAD'),'status':g('status','--porcelain'),'diff':hashlib.sha256(g('diff','--no-ext-diff','--binary','HEAD').encode()).hexdigest()}))`,
    );
  }
  function gh(path) {
    const r = spawnSync("gh", ["api", path], {
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2097152,
    });
    if (r.status !== 0)
      throw Error("Independent GitHub observation unavailable");
    return JSON.parse(r.stdout);
  }
  let before, tasks, recovery;
  try {
    if (process.argv.includes("--attach")) {
      ({ base, principal } = JSON.parse(readFileSync(addressFile, "utf8")));
    } else await start();
    const progress = join(out, "progress.json");
    if (process.argv.includes("--resume")) {
      const old = JSON.parse(readFileSync(progress, "utf8"));
      tasks = old.tasks.map((t) => t.id);
      before = JSON.parse(
        readFileSync(join(out, "source-before.json"), "utf8"),
      );
      recovery = old.recovery;
      if (
        process.argv.includes("--resume-stopped") ||
        process.argv.includes("--verify-stopped")
      )
        for (const id of tasks) {
          const current = (
            await call("GET", `/api/factory/development/tasks/${id}`)
          ).task;
          if (
            ["DEFERRED", "PAUSED", "FAILED"].includes(current.development.stage)
          )
            await call(
              "POST",
              `/api/factory/development/tasks/${id}/decision`,
              {
                action: process.argv.includes("--verify-stopped")
                  ? "verify-current"
                  : "resume",
              },
            );
        }
    } else {
      if (existsSync(progress))
        throw Error("Existing trial: resume instead of duplicating work");
      const bot = (
          await call("POST", "/api/bots", {
            name: "工厂-第三阶段专用试跑协调员",
          })
        ).bot,
        workers = [];
      for (const m of config.machines)
        workers.push(
          (await call("POST", "/api/bots", { name: "交付试跑-" + m.id })).bot,
        );
      const room = (
        await call("POST", "/api/bot-rooms", {
          title: "工厂-第三阶段专用远端试跑",
          botIds: [bot.id, ...workers.map((b) => b.id)],
          hostBotId: bot.id,
        })
      ).room;
      await call("PATCH", "/api/factory/settings", {
        roomId: room.id,
        coordinatorBotId: bot.id,
        machines: config.machines.map((m, i) => ({
          id: m.id,
          name: m.name,
          sshAlias: m.sshAlias,
          capacity: 1,
          botIds: [workers[i].id],
          allowedUserIds: [principal.userId],
          repositories: [{ id: "pilot", path: m.repositoryPath }],
        })),
      });
      before = config.machines.map(source);
      writeFileSync(
        join(out, "source-before.json"),
        JSON.stringify(before, null, 2),
      );
      tasks = [];
      for (let i = 0; i < config.machines.length; i++) {
        const m = config.machines[i],
          feature = i === 0 ? "sum" : "product";
        const profile = {
          enabled: true,
          allowedUserIds: [principal.userId],
          image: m.image,
          toolPath: m.toolPath,
          model: m.model,
          modelUrl: m.modelUrl,
          credentialRef: "claude-settings",
          codeArgv: [
            "/tools/claude",
            "--print",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
            "--max-turns",
            "10",
            "--tools",
            "Read,Write,Edit,Glob,Grep",
            "--no-session-persistence",
          ],
          reviewArgv: [
            "/tools/claude",
            "--print",
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
            "--max-turns",
            "10",
            "--tools",
            "Read,Bash,Glob,Grep",
            "--no-session-persistence",
          ],
          checks: [{ id: "unit", argv: ["node", "--test"], required: true }],
          redCheck: "unit",
          install: ["true"],
          timeoutMs: 1800000,
          maxRounds: 6,
          maxRetries: 1,
          minDiskMb: 1024,
          criteria: [
            {
              id: "AC-1",
              given: "two finite numeric arguments",
              when: feature + " is called",
              then:
                "return their " +
                (feature === "sum" ? "sum" : "product") +
                " with mathematically correct short decimal results; reject nonnumeric/nonfinite arguments using TypeError. Preserve all unrelated exports.",
            },
          ],
          criteriaApproved: true,
          baselineFailures: [],
        };
        await call("PATCH", `/api/factory/development/${m.id}/pilot`, profile);
        await call("PATCH", `/api/factory/delivery/${m.id}/pilot`, {
          ...config.delivery,
          allowedUserIds: [principal.userId],
        });
        const preflight = await call(
          "POST",
          `/api/factory/delivery/${m.id}/pilot/preflight`,
          {},
        );
        writeFileSync(
          join(out, "preflight-" + m.id + ".json"),
          JSON.stringify(preflight, null, 2),
        );
        if (!preflight.ready)
          throw Error(
            "Delivery preflight blocked: " + JSON.stringify(preflight),
          );
        const text =
          "/factory develop " +
          JSON.stringify({
            machineId: m.id,
            repositoryId: "pilot",
            baseline: m.baseline,
            requirement: `Implement exported ${feature}(a,b) in ${feature}.mjs for finite numbers, TypeError otherwise, with mathematically correct short decimal results. Add genuine behavioral node:test regression coverage in ${feature}.test.mjs with AC-1 in every test title before implementation. Do not edit unrelated source, tests, workflow, dependency definitions or gate commands. Preserve frozen tests. This dedicated remote trial will run additional contract checks in CI.`,
          });
        const input = { text, idempotencyKey: "stage3-" + m.id };
        const task = (
          await call("POST", `/api/bot-rooms/${room.id}/messages`, input)
        ).task;
        const repeated = (
          await call("POST", `/api/bot-rooms/${room.id}/messages`, input)
        ).task;
        if (repeated.id !== task.id) throw Error("Duplicate group task");
        tasks.push(task.id);
      }
    }
    let restarted = !!recovery,
      granted = new Set(),
      deadline = Date.now() + 3600000;
    while (Date.now() < deadline) {
      const board = await call("GET", "/api/factory/board");
      const current = tasks.map((id) => board.tasks.find((t) => t.id === id));
      const deliveries = [];
      for (const task of current) {
        let d = (await call("GET", `/api/factory/delivery/tasks/${task.id}`))
          .delivery;
        if (d) granted.add(task.id);
        if (task.development.stage === "READY" && !granted.has(task.id)) {
          const text =
            "/factory deliver " +
            JSON.stringify({ taskId: task.id, scope: "MERGED" });
          d = (
            await call("POST", `/api/bot-rooms/${task.roomId}/messages`, {
              text,
              idempotencyKey: "grant-" + task.id,
            })
          ).task;
          granted.add(task.id);
          d = (await call("GET", `/api/factory/delivery/tasks/${task.id}`))
            .delivery;
        }
        deliveries.push(d);
      }
      writeFileSync(
        progress,
        JSON.stringify(
          {
            at: new Date().toISOString(),
            tasks: current,
            deliveries,
            recovery,
          },
          null,
          2,
        ),
      );
      if (!restarted && existsSync(lostFile)) {
        const old = child;
        old.kill("SIGKILL");
        await new Promise((r) => old.once("exit", r));
        await start();
        recovery = {
          at: new Date().toISOString(),
          lost: JSON.parse(readFileSync(lostFile, "utf8")),
          oldPid: old.pid,
          newPid: child.pid,
          real: true,
        };
        writeFileSync(
          join(out, "recovery.json"),
          JSON.stringify(recovery, null, 2),
        );
        restarted = true;
        continue;
      }
      if (deliveries.every((d) => d?.stage === "MERGED")) break;
      if (
        current.some((t) =>
          ["WAITING_DECISION", "DEFERRED", "FAILED", "TIMED_OUT"].includes(
            t.development.stage,
          ),
        ) ||
        deliveries.some(
          (d) => d && ["WAITING_DECISION", "DEFERRED"].includes(d.stage),
        )
      )
        throw Error(
          "Trial requires investigation: " +
            JSON.stringify(
              current.map((t, i) => ({
                id: t.id,
                execution: t.status,
                stage: t.development.stage,
                error: t.error,
                delivery: deliveries[i],
              })),
            ),
        );
      await pause(1000);
    }
    const latest = JSON.parse(readFileSync(progress, "utf8"));
    const after = config.machines.map(source);
    const rows = latest.deliveries.map((d, i) => {
      const task = latest.tasks[i],
        pr = gh(`repos/${config.delivery.repository}/pulls/${d.pr.number}`);
      if (
        !pr.merged ||
        pr.merge_commit_sha !== d.mergeSha ||
        pr.head.sha !== d.candidate ||
        pr.base.ref !== config.delivery.target
      )
        throw Error("Independent merged mapping mismatch");
      return {
        real: true,
        identity: before[i].identity,
        machineId: config.machines[i].id,
        taskId: task.id,
        merged: d.stage === "MERGED",
        candidate: d.candidate,
        mergeSha: d.mergeSha,
        sourceUnchanged: JSON.stringify(before[i]) === JSON.stringify(after[i]),
        ciRepair: d.ciHistory.some((h) =>
          h.checks.some((c) => c.conclusion === "failure"),
        ),
        baseAdvanced: d.deliveryBase !== d.originalBase,
        delivery: d,
        task,
        pr,
      };
    });
    const allPrs = gh(
      `repos/${config.delivery.repository}/pulls?state=all&per_page=100`,
    );
    const prs = allPrs.filter((p) => p.head.ref.startsWith("factory/"));
    const refs = gh(
      `repos/${config.delivery.repository}/git/matching-refs/heads/factory/`,
    );
    const board = await call("GET", "/api/factory/board");
    const observations = config.machines.map((m, i) =>
      remote(
        m,
        `import json,pathlib,subprocess,os
task=${JSON.stringify(latest.tasks[i].id)}
root=pathlib.Path.home()/'.local/state/ppeng-factory/development'/task
controllers=[]
for path in root.glob('receipt-*.json'):
 r=json.loads(path.read_text())
 try:
  fields=pathlib.Path('/proc/'+str(r['pid'])+'/stat').read_text().rsplit(')',1)[1].split()
  if fields[0] not in ('Z','X') and fields[19]==r.get('processToken'):controllers.append(r['pid'])
 except (OSError,KeyError,IndexError):pass
clean={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(pathlib.Path.home())}
names=subprocess.check_output(['docker','ps','--format','{{.Names}}'],env=clean,text=True,timeout=10).splitlines()
containers=[n for n in names if n.startswith(task+'_')]
publisher=pathlib.Path.home()/'.local/state/ppeng-factory/publisher'/task
operations=[json.loads(p.read_text()) for p in publisher.glob('operation-*.json')]
print(json.dumps({'controllers':controllers,'containers':containers,'operations':operations}))`,
      ),
    );
    const queue = (await call("GET", "/api/factory/delivery/queue")).queue;
    const effects = observations.flatMap((o, i) =>
      o.operations
        .filter((op) => op.completed && !op.error)
        .map((op) => ({ taskId: latest.tasks[i].id, ...op })),
    );
    const fingerprints = effects.map((e) =>
      JSON.stringify([e.taskId, e.action, e.sha]),
    );
    const evidence = {
      at: new Date().toISOString(),
      tasks: rows,
      recovery: {
        ...recovery,
        branches: refs.length,
        remoteEffects: effects,
        duplicateEffects: new Set(fingerprints).size !== fingerprints.length,
        queueLength: queue.length,
        prs: prs.length,
        merges: prs.filter((p) => p.merged_at).length,
        occupied: board.machines.reduce((n, m) => n + m.occupied, 0),
        live: observations.reduce(
          (n, o) => n + o.controllers.length + o.containers.length,
          0,
        ),
        observations,
      },
      before,
      after,
      allPrs,
    };
    writeFileSync(
      join(out, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    verifyDeliveryPilot(evidence);
    console.log(
      JSON.stringify({
        passed: true,
        tasks: rows.map((x) => ({
          id: x.taskId,
          pr: x.delivery.pr.url,
          mergeSha: x.mergeSha,
        })),
      }),
    );
  } catch (e) {
    writeFileSync(
      join(out, "failure.json"),
      JSON.stringify(
        { at: new Date().toISOString(), error: String(e) },
        null,
        2,
      ),
    );
    throw e;
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  }
}
