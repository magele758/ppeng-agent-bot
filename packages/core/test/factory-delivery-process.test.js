import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStateStore } from "../dist/storage.js";
import { FactoryDelivery } from "../dist/factory/delivery.js";
import { sanitizeSpawnEnv } from "../dist/sandbox/env-sanitizer.js";

const principal = { tenantId: "team", userId: "owner" };
const sha = "a".repeat(40),
  base = "b".repeat(40);
const policy = {
  enabled: true,
  allowedUserIds: ["owner"],
  repository: "example/trial",
  repositoryNodeId: "R_process_trial",
  target: "main",
  credentialRef: "synthetic",
  operations: ["push", "pr"],
  requiredChecks: [{ workflowId: 42, job: "test", appId: 15368 }],
  mergeMethod: "squash",
  maxRetries: 1,
  deadlineMs: 60000,
  downstream: { confirmed: true, deploys: false },
};
const machine = {
  id: "u0",
  allowedUserIds: ["owner"],
  repositories: [{ id: "core", path: "/synthetic" }],
};
function task(id) {
  const developmentPolicy = {
    revision: "synthetic-development",
    criteria: [{ id: "AC-1" }],
    checks: [{ id: "unit", required: true }],
  };
  const result = {
    generation: 1,
    stage: "READY",
    round: 0,
    sha,
    policyRevision: developmentPolicy.revision,
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
      path: "/synthetic-work",
      sourcePath: "/synthetic",
      independentGit: true,
      sourceBefore: base,
      sourceAfter: base,
    },
    dependencies: { exitCode: 0, isolated: true },
    checks: [
      { id: "unit", sha, passed: true, exitCode: 0, output: "ok 1 - behavior" },
    ],
    review: {
      sha,
      covered: true,
      verdict: "CLEAN",
      issues: [],
      policyRevision: developmentPolicy.revision,
      files: ["sum.mjs"],
      segments: [
        {
          sha,
          files: ["sum.mjs"],
          verdict: "CLEAN",
          policyRevision: developmentPolicy.revision,
        },
      ],
    },
  };
  return {
    id,
    principal,
    machine,
    machineId: "u0",
    repositoryId: "core",
    identity: "synthetic-host",
    status: "succeeded",
    development: {
      stage: "READY",
      baseline: base,
      generation: 1,
      policy: developmentPolicy,
    },
    result: { development: result },
  };
}
function host(ids) {
  return {
    settings: () => ({ machines: [machine] }),
    list: () => ids.map(task),
    get: (_p, id) => {
      assert.ok(ids.includes(id));
      return task(id);
    },
    updateDevelopment: () => {
      throw Error("Unexpected development execution");
    },
    development: { current: () => ({ evidenceCurrent: true }) },
  };
}

// The child imports its own FactoryDelivery module and opens its own SQLite connection.
// No module-global Set, Promise or transport implementation is shared with its peers.
if (process.argv.includes("--delivery-process-child")) {
  const store = new SqliteStateStore(process.argv.at(-1));
  const waiting = new Map();
  let sequence = 0;
  const delivery = new FactoryDelivery(
    store,
    host(["factory_first", "factory_second"]),
    {
      delivery: (_machine, request) =>
        new Promise((resolve) => {
          const id = ++sequence;
          waiting.set(id, resolve);
          process.send({ kind: "remote", id, request });
        }),
    },
  );
  process.on("message", async (message) => {
    if (message.kind === "reply") {
      waiting.get(message.id)?.(message.value);
      waiting.delete(message.id);
    }
    if (message.kind === "advance") {
      try {
        await delivery.advance(principal, message.taskId);
        process.send({ kind: "done" });
      } catch (error) {
        process.send({ kind: "failed", error: String(error) });
      }
    }
    if (message.kind === "close") {
      store.db.close();
      process.disconnect();
    }
  });
  process.send({ kind: "ready" });
} else {
  async function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), "factory-delivery-process-"));
    const dbPath = join(directory, "db");
    const store = new SqliteStateStore(dbPath);
    const api = new FactoryDelivery(
      store,
      host(["factory_first", "factory_second"]),
      {},
    );
    api.save(principal, "u0", "core", policy);
    for (const id of ["factory_first", "factory_second"])
      api.grant(principal, id, { scope: "PR" });
    const children = new Set(),
      calls = [],
      facts = new Map();
    let holdPush, onPush;
    const pushed = new Promise((resolve) => {
      onPush = resolve;
    });
    const state = (id) => {
      if (!facts.has(id))
        facts.set(id, {
          repositoryNodeId: policy.repositoryNodeId,
          baseSha: base,
          headSha: null,
          pr: null,
          checks: [],
          canPush: true,
          downstreamSafe: true,
        });
      return facts.get(id);
    };
    async function child() {
      const processChild = fork(
        fileURLToPath(import.meta.url),
        ["--delivery-process-child", dbPath],
        {
          execArgv: [],
          env: sanitizeSpawnEnv({ stripCredentials: true }),
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.add(processChild);
      let stderr = "",
        ready,
        complete;
      const initialized = new Promise((resolve) => {
        ready = resolve;
      });
      processChild.stderr.on("data", (value) => {
        stderr += value;
      });
      processChild.on("message", (message) => {
        if (message.kind === "ready") ready();
        if (message.kind === "done") complete?.resolve();
        if (message.kind === "failed") complete?.reject(Error(message.error));
        if (message.kind !== "remote") return;
        const { request, id } = message;
        calls.push({ pid: processChild.pid, ...request });
        const f = state(request.taskId);
        const reply = (value) => {
          if (processChild.connected)
            processChild.send({ kind: "reply", id, value });
        };
        if (request.action === "snapshot") reply(structuredClone(f));
        else if (request.action === "artifact")
          reply({
            ...task(request.taskId).result.development.artifact,
            valid: true,
            identity: "synthetic-host",
            privacy: { sha, findings: [] },
            sensitive: [],
          });
        else if (request.action === "push") {
          holdPush = () => {
            f.headSha = sha;
            reply({});
          };
          onPush();
        } else if (request.action === "pr") {
          f.pr = {
            number: facts.size,
            head: sha,
            branch: request.branch,
            base: "main",
            marker: request.taskId,
            state: "open",
          };
          reply({});
        } else
          complete?.reject(
            Error("Unexpected remote operation: " + request.action),
          );
      });
      processChild.on("exit", (code, signal) => {
        children.delete(processChild);
        if (code && !signal) complete?.reject(Error(stderr || "Child failed"));
      });
      await initialized;
      return {
        process: processChild,
        run(taskId = "factory_first") {
          return new Promise((resolve, reject) => {
            complete = { resolve, reject };
            processChild.send({ kind: "advance", taskId });
          });
        },
        kill: () =>
          new Promise((resolve) => {
            processChild.once("exit", resolve);
            processChild.kill("SIGKILL");
          }),
      };
    }
    t.after(async () => {
      await Promise.all(
        [...children].map(
          (processChild) =>
            new Promise((resolve) => {
              processChild.once("exit", resolve);
              processChild.kill("SIGKILL");
            }),
        ),
      );
      store.db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return {
      api,
      store,
      calls,
      state,
      child,
      pushed,
      releasePush: () => holdPush(),
    };
  }

  test(
    "independent coordinator processes cannot write the same task concurrently [AC:multi-machine-controlled-delivery#AC-11]",
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        owner = await f.child(),
        competitor = await f.child();
      const running = owner.run();
      await f.pushed;
      const before = f.calls.length;
      await competitor.run();
      assert.equal(
        f.calls.length,
        before,
        "live process claim must reject even the second snapshot",
      );
      assert.equal(
        f.store.db
          .prepare(
            "SELECT pid FROM factory_delivery_controller WHERE task_id=?",
          )
          .get("factory_first").pid,
        owner.process.pid,
      );
      f.releasePush();
      await running;
      assert.equal(f.calls.filter((c) => c.action === "push").length, 1);
      assert.equal(f.api.current(principal, "factory_first").stage, "PR_READY");
      assert.equal(f.api.queue().length, 0);
    },
  );

  test(
    "dead coordinator with an unknown pending push keeps same-target peers fenced [AC:multi-machine-controlled-delivery#AC-9] [AC:multi-machine-controlled-delivery#AC-27]",
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        owner = await f.child(),
        competitor = await f.child();
      void owner.run();
      await f.pushed;
      await competitor.run("factory_second");
      assert.equal(
        f.calls.filter((c) => c.taskId === "factory_second").length,
        0,
      );
      await owner.kill();
      const recovery = await f.child();
      await recovery.run();
      const current = f.api.current(principal, "factory_first");
      assert.equal(current.stage, "VERIFYING");
      assert.equal(current.pending.action, "push");
      await competitor.run("factory_second");
      assert.equal(
        f.calls.filter((c) => c.action === "push").length,
        1,
        "neither same task recovery nor target peer can replay an unverified write",
      );
      assert.equal(
        f.calls.filter((c) => c.taskId === "factory_second").length,
        0,
      );
      assert.equal(f.api.queue()[0].taskId, "factory_first");
    },
  );

  test(
    "a new process adopts a lost successful push after coordinator death without replay [AC:multi-machine-controlled-delivery#AC-16] [AC:multi-machine-controlled-delivery#AC-27]",
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        owner = await f.child();
      void owner.run();
      await f.pushed;
      // The synthetic remote accepted the push, but its process never receives a response.
      f.state("factory_first").headSha = sha;
      await owner.kill();
      const recovery = await f.child();
      await recovery.run();
      assert.equal(f.calls.filter((c) => c.action === "push").length, 1);
      assert.equal(f.calls.filter((c) => c.action === "pr").length, 1);
      const current = f.api.current(principal, "factory_first");
      assert.equal(current.stage, "PR_READY");
      assert.equal(current.pushedSha, sha);
      assert.equal(current.pending, undefined);
      assert.equal(f.api.queue().length, 0);
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM factory_delivery_controller")
          .get().n,
        0,
      );
    },
  );
}
