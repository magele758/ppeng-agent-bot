import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawAgentRuntime } from "../dist/runtime.js";
import { resolveSkillLoad } from "../dist/runtime/skill-load.js";
import { SkillProposalStore } from "../dist/skill-proposals/store.js";
import { BotFunctionalGroupService } from "../dist/bots/functional-groups.js";
import {
  principalFromSession,
  setBotDefinitionOwner,
} from "../dist/bots/bot-identity.js";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "daydream-runtime-"));
  let answer;
  const adapter = {
    name: "daydream-test",
    runTurn: async () => ({ stopReason: "end", assistantParts: [] }),
    completeText: async (input) => answer(input),
  };
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, "state"),
    modelAdapter: adapter,
  });
  runtime.emitTrace = () => {};
  t.after(async () => {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const bots = Object.fromEntries(
    ["a", "b", "c", "super", "outside"].map((name) => [
      name,
      runtime.createBot({ name }),
    ]),
  );
  const host = runtime.daydream;
  for (const bot of Object.values(bots))
    host.local.patchSettings(bot.id, { dailyAt: "23:59", timezone: "UTC" });
  const superActor = host.actor(bots.super.id, true);
  host.knowledge.savePolicy(superActor, {
    superBotId: bots.super.id,
    allowedRecipientBotIds: [bots.b.id],
    publishPolicy: "autoWithinScope",
  });
  const message = runtime.store.appendMessage(
    bots.a.canonicalSessionId,
    "user",
    [
      {
        type: "text",
        text: "以后部署必须检查健康状态，以下步骤已经成功验证，值得共享。",
      },
    ],
  );
  answer = async () =>
    JSON.stringify({
      candidates: [
        {
          kind: "memory",
          category: "fact",
          content: "部署发布必须检查健康状态。",
          evidenceIds: [message.id],
          shareable: true,
          reason: "明确的项目约定",
        },
        {
          kind: "skill",
          name: "deploy-health",
          description: "Verify deployment health",
          content:
            "# Deploy health\n\nRun a health check after deployment. Confirm success before proceeding.",
          evidenceIds: [message.id],
          shareable: true,
          reason: "用户确认已成功验证",
        },
      ],
    });
  return {
    runtime,
    host,
    bots,
    message,
    setAnswer: (fn) => {
      answer = fn;
    },
    date: message.createdAt.slice(0, 10),
    superActor,
  };
}
async function publish(x) {
  const batch = x.host.knowledge.startBatch(x.superActor);
  return x.host.knowledge
    .listSubmissions(x.superActor)
    .filter((s) => s.status === "pending")
    .map((s) =>
      x.host.knowledge.decide(x.superActor, batch.id, s.id, {
        action: "publish",
        reason: "Verified source evidence",
      }),
    );
}
test("real runtime daily memory and skill reach authorized bot and revoke immediately [AC:bot-daydream-integration#AC-1] [AC:bot-daydream-integration#AC-2] [AC:bot-daydream-integration#AC-3]", async (t) => {
  const x = setup(t);
  x.host.local.patchSettings(x.bots.a.id, { skillPolicy: "autoPrivate" });
  const run = await x.host.local.run(x.bots.a.id, {
    date: x.date,
    manual: true,
  });
  assert.equal(run.status, "completed", run.error);
  assert.equal(run.outputs.length, 2, JSON.stringify(run));
  assert.equal(x.host.knowledge.listSubmissions(x.superActor).length, 2);
  await publish(x);
  const sid = x.bots.b.canonicalSessionId,
    cid = x.bots.c.canonicalSessionId;
  const skills = await x.runtime.promptBuilder.skillsForSession(sid);
  const shared = skills.find((s) => s.id.startsWith("knowledge:"));
  assert.ok(shared, JSON.stringify(skills));
  assert.ok(
    !(await x.runtime.promptBuilder.skillsForSession(cid)).some(
      (s) => s.id === shared.id,
    ),
  );
  assert.match(
    (await resolveSkillLoad(x.runtime, shared.id, sid)).content,
    /health check/,
  );
  const session = x.runtime.store.getSession(sid);
  assert.match(
    x.runtime.promptBuilder.buildMemoryAppendix({ session }, { query: "部署" }),
    /健康状态/,
  );
  assert.doesNotMatch(
    x.runtime.promptBuilder.buildMemoryAppendix(
      { session: x.runtime.store.getSession(cid) },
      { query: "部署" },
    ),
    /健康状态/,
  );
  x.runtime.store.setDaemonControl("memory_settings", {
    compilerEnabled: false,
  });
  assert.doesNotMatch(
    x.runtime.promptBuilder.buildMemoryAppendix({ session }, { query: "部署" }),
    /健康状态/,
  );
  x.runtime.store.setDaemonControl("memory_settings", {
    compilerEnabled: true,
  });
  const foreign = x.bots.outside;
  setBotDefinitionOwner(x.runtime.store, foreign.id, {
    userId: "different-user",
  });
  assert.equal(
    x.host.knowledge.listArtifacts(x.host.actor(foreign.id)).length,
    0,
  );
  for (const artifact of x.host.knowledge.listArtifacts(x.superActor))
    x.host.knowledge.revoke(x.superActor, artifact.id, artifact.version);
  assert.ok((await resolveSkillLoad(x.runtime, shared.id, sid)).error);
  assert.doesNotMatch(
    x.runtime.promptBuilder.buildMemoryAppendix({ session }, { query: "部署" }),
    /健康状态/,
  );
});
test("external proposal approval is reconciled and source revoke blocks knowledge load [AC:bot-daydream-integration#AC-1]", async (t) => {
  const x = setup(t);
  const run = await x.host.local.run(x.bots.a.id, {
    date: x.date,
    manual: true,
  });
  const skill = run.outputs.find((o) => o.candidate.kind === "skill");
  assert.equal(skill.status, "pending");
  const proposals = new SkillProposalStore(x.runtime.stateDir);
  proposals.approve(skill.artifactId);
  await x.runtime.reloadWorkspaceSkills();
  x.setAnswer(async () =>
    JSON.stringify({ decisions: [], feedbackDecisions: [] }),
  );
  await x.host.tick();
  assert.equal(
    x.host.local
      .getRun(x.bots.a.id, run.id)
      .outputs.find((o) => o.candidate.kind === "skill").status,
    "saved",
  );
  await publish(x);
  const published = x.host.knowledge
    .listArtifacts(x.superActor)
    .find((a) => a.kind === "skill");
  assert.ok(published);
  assert.equal(x.host.sharedSkills(x.bots.b.canonicalSessionId).length, 1);
  proposals.revoke(skill.artifactId);
  assert.equal(x.host.sharedSkills(x.bots.b.canonicalSessionId).length, 0);
  assert.throws(
    () => x.host.knowledge.getArtifact(x.host.actor(x.bots.b.id), published.id),
    /denied/,
  );
});
test("functional group changes revoke previous collaboration scope [AC:bot-daydream-integration#AC-1]", async (t) => {
  const x = setup(t);
  x.host.local.patchSettings(x.bots.a.id, { skillPolicy: "autoPrivate" });
  await x.host.local.run(x.bots.a.id, { date: x.date, manual: true });
  await publish(x);
  const groups = new BotFunctionalGroupService(x.runtime.store);
  const principal = principalFromSession(
    x.runtime.store,
    x.runtime.store.getSession(x.bots.b.canonicalSessionId),
  );
  const group = groups.create(principal, "Separated");
  groups.move(principal, x.bots.b.id, group.id);
  assert.equal(
    x.host.knowledge.listArtifacts(x.host.actor(x.bots.b.id)).length,
    0,
  );
  assert.throws(
    () =>
      x.host.knowledge.savePolicy(x.superActor, {
        superBotId: x.bots.super.id,
        allowedRecipientBotIds: [x.bots.b.id],
        publishPolicy: "autoWithinScope",
      }),
    /denied/,
  );
});
test("daily new evidence becomes feedback and next Super batch produces curated revision [AC:bot-daydream-integration#AC-3]", async (t) => {
  const x = setup(t);
  await x.host.local.run(x.bots.a.id, { date: x.date, manual: true });
  await publish(x);
  const original = x.host.knowledge
    .listArtifacts(x.superActor)
    .find((a) => a.kind === "memory");
  const m = x.runtime.store.appendMessage(x.bots.b.canonicalSessionId, "user", [
    {
      type: "text",
      text: "实际验证成功，部署的健康检查需要重试三次，这个新条件值得共享。",
    },
  ]);
  x.setAnswer(async () =>
    JSON.stringify({
      candidates: [
        {
          kind: "memory",
          content: "部署的健康检查必须重试三次再确认结果。",
          evidenceIds: [m.id],
          shareable: true,
          reason: "实际成功验证的新条件",
          derivedFrom: [{ id: original.id, version: 1, kind: "memory" }],
        },
      ],
    }),
  );
  const run = await x.host.local.run(x.bots.b.id, {
    date: m.createdAt.slice(0, 10),
    manual: true,
  });
  assert.equal(run.status, "completed", run.error);
  const feedback = x.host.knowledge.listFeedback(x.superActor);
  assert.equal(feedback.length, 1, JSON.stringify(run));
  x.setAnswer(async () =>
    JSON.stringify({
      decisions: [],
      feedbackDecisions: [
        {
          id: feedback[0].id,
          action: "revise",
          reason: "Verified extension",
          expectedVersion: 1,
          content: "部署发布检查健康状态，重试三次再确认结果。",
          summary: "部署健康检查重试规则",
        },
      ],
    }),
  );
  await x.host.govern(x.bots.super.id);
  const resolved = x.host.knowledge.listFeedback(x.superActor)[0];
  assert.equal(resolved.status, "resolved");
  assert.notEqual(resolved.resolvedArtifact.id, original.id);
  assert.match(
    x.host.sharedMemory(
      x.bots.b.canonicalSessionId,
      "请问部署检查流程有哪些要求",
    ),
    /重试三次/,
  );
});
test("source correction suppresses stale shared facts [AC:bot-daydream-integration#AC-2]", async (t) => {
  const x = setup(t);
  await x.host.local.run(x.bots.a.id, { date: x.date, manual: true });
  await publish(x);
  const artifact = x.host.knowledge
    .listArtifacts(x.superActor)
    .find((a) => a.kind === "memory");
  assert.match(
    x.host.sharedMemory(
      x.bots.b.canonicalSessionId,
      "我们部署之前需要做什么检查",
    ),
    /健康状态/,
  );
  x.runtime.store.db
    .prepare("UPDATE agent_memory SET value=? WHERE id=?")
    .run("原部署规则已经废弃，请采用新的验证要求。", artifact.contentRef.id);
  assert.equal(
    x.host.sharedMemory(x.bots.b.canonicalSessionId, "部署检查要求"),
    "",
  );
});
test("governance throttles pending decisions and close aborts manual analysis [AC:bot-daydream-integration#AC-3]", async (t) => {
  const x = setup(t);
  await x.host.local.run(x.bots.a.id, { date: x.date, manual: true });
  let calls = 0;
  x.setAnswer(async () => {
    calls++;
    return JSON.stringify({ decisions: [], feedbackDecisions: [] });
  });
  await x.host.tick();
  await x.host.tick();
  assert.equal(calls, 1);
  x.runtime.store.appendMessage(x.bots.b.canonicalSessionId, "user", [
    { type: "text", text: "以后请记住项目约定" },
  ]);
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  x.setAnswer(() => {
    entered();
    return new Promise(() => {});
  });
  const pending = x.host.local.run(x.bots.b.id, { date: x.date, manual: true });
  await started;
  await x.host.close();
  const result = await pending;
  assert.equal(result.outputs.length, 0);
  assert.notEqual(result.status, "completed");
  await assert.rejects(
    x.host.local.run(x.bots.b.id, { date: x.date, manual: true }),
    /closed/,
  );
});
test("a missing conversation does not fail the scheduled review [AC:bot-daydream-missing-session#AC-1] [AC:bot-daydream-missing-session#AC-2]", async (t) => {
  const x = setup(t);
  const now = new Date().toISOString();
  x.runtime.store.createBot({
    id: "gone-bot",
    name: "Gone Bot",
    title: "",
    description: "",
    agentId: "gone-bot",
    canonicalSessionId: "session-does-not-exist",
    hidden: true,
    faceShape: null,
    faceColor: null,
    faceStyle: null,
    faceExpression: null,
    avatar: null,
    createdAt: now,
    updatedAt: now,
  });
  const settings = x.host.local.getSettings(x.bots.a.id);
  x.runtime.store.setDaemonControl("bot_daydream:" + x.bots.a.id, {
    ...settings,
    enabled: true,
    dailyAt: "00:00",
    timezone: "UTC",
    effectiveFrom: "2026-10-01T00:00:00.000Z",
  });
  await x.host.tick();
  await x.host.tick();
  const reviewed = x.host.local.listRuns(x.bots.a.id);
  assert.ok(reviewed.length > 0);
  assert.equal(
    x.runtime.store.db.prepare("SELECT id FROM bot_daydream_runs WHERE bot_id=?").all("gone-bot").length,
    0,
  );
  assert.equal(x.runtime.store.getDaemonControl("daydream.lastError:gone-bot"), undefined);
  assert.equal(x.runtime.store.getDaemonControl("daydream.lastError:" + x.bots.a.id), undefined);
});
