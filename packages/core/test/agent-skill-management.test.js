import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManagementService } from "../dist/skill-proposals/management.js";
import {
  SkillProposalStore,
  SkillCaptureService,
} from "../dist/skill-proposals/index.js";
import { loadStateDirSkills } from "../dist/skills/builtin-skills.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "manage-skill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proposals = new SkillProposalStore(dir);
  let authorized = false;
  const deps = {
    stateDir: dir,
    listSkills: () => loadStateDirSkills(dir),
    getBotId: (s) => s.split(":")[0],
    validateSharing: (o, r) => {
      if (r.some((x) => !["a", "b"].includes(x))) throw Error("Unknown Bot");
    },
    reloadSkills: async () => {},
    authorize: async () => authorized,
  };
  const captures = new SkillCaptureService({
    ...deps,
    settingsStore: { getDaemonControl: () => ({ enabled: true }) },
    getEvidence: () => "verified",
    complete: async () =>
      JSON.stringify({ description: "check", body: "# Updated" }),
  });
  const managementDeps = { ...deps, captures };
  const service = new SkillManagementService(managementDeps);
  function seed(owner = "a") {
    const p = proposals.create({
      name: "test-check",
      description: "check",
      body: "# Original",
      ownerBotId: owner,
      sharedBotIds: [],
      sessionId: "a:1",
    });
    proposals.approve(p.id);
    return p;
  }
  return {
    dir,
    proposals,
    service,
    deps: managementDeps,
    restart: () => new SkillManagementService({ ...deps, captures }),
    seed,
    authorize: () => {
      authorized = true;
    },
  };
}
test("catalog hides private skills and marks readonly [AC:agent-skill-management#AC-1]", async (t) => {
  const x = fixture(t);
  x.seed();
  assert.equal((await x.service.catalog("b:1")).length, 0);
  const rows = await x.service.catalog("a:1");
  assert.equal(rows[0].canManage, true);
});
test("autonomous capture confirms once and persists private [AC:agent-skill-management#AC-2]", async (t) => {
  const x = fixture(t);
  const op = await x.service.request("a:1", "agent", {
    action: "create",
    name: "new-check",
    description: "check",
    reason: "Success",
    summary: "Record checks",
  });
  assert.equal(op.status, "pending");
  assert.equal((await x.service.catalog("a:1")).length, 0);
  const done = await x.service.confirm("a:1", op.id);
  assert.equal(done.status, "saved", done.error);
  assert.equal((await x.service.catalog("b:1")).length, 0);
  assert.equal((await x.service.confirm("a:1", op.id)).id, op.id);
});
test("explicit command executes without approval [AC:agent-skill-management#AC-3]", async (t) => {
  const x = fixture(t);
  x.seed();
  x.authorize();
  const skill = (await x.service.catalog("a:1"))[0];
  const op = await x.service.request("a:1", "agent", {
    action: "share",
    skillId: skill.id,
    botIds: ["b"],
  });
  assert.equal(op.status, "saved", op.error);
  assert.equal(op.authorization, "user");
});
test("autonomous sharing waits and rejection leaves state [AC:agent-skill-management#AC-4]", async (t) => {
  const x = fixture(t);
  x.seed();
  const skill = (await x.service.catalog("a:1"))[0];
  const op = await x.service.request("a:1", "agent", {
    action: "share",
    skillId: skill.id,
    botIds: ["b"],
  });
  assert.equal(op.status, "pending");
  x.service.reject("a:1", op.id);
  assert.equal((await x.service.catalog("b:1")).length, 0);
});
test("share update unshare delete use original and remove file [AC:agent-skill-management#AC-5]", async (t) => {
  const x = fixture(t);
  x.seed();
  x.authorize();
  const skill = (await x.service.catalog("a:1"))[0];
  await x.service.request("a:1", "agent", {
    action: "share",
    skillId: skill.id,
    botIds: ["b"],
  });
  assert.equal((await x.service.catalog("b:1"))[0].id, skill.id);
  const up = await x.service.request("a:1", "agent", {
    action: "update",
    skillId: skill.id,
    description: "check",
    reason: "Success",
    summary: "Update checks",
  });
  assert.equal(up.status, "saved", up.error);
  assert.match((await x.service.catalog("b:1"))[0].content, /Updated/);
  await x.service.request("a:1", "agent", {
    action: "unshare",
    skillId: skill.id,
    botIds: ["b"],
  });
  assert.equal((await x.service.catalog("b:1")).length, 0);
  const p = x.proposals
    .list({ status: "approved" })
    .find((p) => x.proposals.isInstalled(p));
  await x.service.request("a:1", "agent", {
    action: "delete",
    skillId: skill.id,
  });
  assert.equal(existsSync(join(x.dir, p.installedPath)), false);
});
test("cannot manage foreign or legacy origin [AC:agent-skill-management#AC-6]", async (t) => {
  const x = fixture(t);
  const p = x.seed();
  x.proposals.setSharing(p.id, "a", ["b"], () => {});
  x.authorize();
  const skill = (await x.service.catalog("b:1"))[0];
  await assert.rejects(
    x.service.request("b:1", "agent", { action: "delete", skillId: skill.id }),
    /own|read.only/i,
  );
});
test("stale confirmation and bad recipients preserve original [AC:agent-skill-management#AC-7]", async (t) => {
  const x = fixture(t);
  const p = x.seed();
  const skill = (await x.service.catalog("a:1"))[0];
  const op = await x.service.request("a:1", "agent", {
    action: "delete",
    skillId: skill.id,
  });
  x.proposals.setSharing(p.id, "a", ["b"], () => {});
  const done = await x.service.confirm("a:1", op.id);
  assert.equal(done.status, "failed");
  assert.equal((await x.service.catalog("b:1")).length, 1);
  await assert.rejects(
    x.service.request("a:1", "agent", {
      action: "share",
      skillId: skill.id,
      botIds: ["missing"],
    }),
  );
});
test("audit survives service reload [AC:agent-skill-management#AC-8]", async (t) => {
  const x = fixture(t);
  x.seed();
  x.authorize();
  const skill = (await x.service.catalog("a:1"))[0];
  const op = await x.service.request("a:1", "agent", {
    action: "delete",
    skillId: skill.id,
  });
  const row = x.restart().list("a:1")[0];
  assert.equal(row.id, op.id);
  assert.equal(row.ownerBotId, "a");
  assert.ok(row.updatedAt);
  assert.equal(row.authorization, "user");
  assert.equal(row.status, "saved");
});

test("Bot selection filters real search and load, persists across sessions [AC:bot-detail-skill-management#AC-3]", async (t) => {
  const { RawAgentRuntime } = await import("../dist/runtime.js");
  const { resolveSkillLoad, resolveSkillSearch } =
    await import("../dist/runtime/skill-load.js");
  const { botSkillSelectionKey } =
    await import("../dist/skills/bot-selection.js");
  const dir = mkdtempSync(join(tmpdir(), "skill-selection-"));
  const rt = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, "state"),
    modelAdapter: {
      name: "test",
      runTurn: async () => ({ assistantParts: [], stopReason: "end" }),
      summarizeMessages: async () => "",
    },
  });
  t.after(async () => {
    await rt.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = rt.createBot({ name: "A" });
  const store = new SkillProposalStore(rt.stateDir);
  const p = store.create({
    name: "selected-check",
    description: "check",
    body: "# Body",
    sessionId: a.canonicalSessionId,
    ownerBotId: a.id,
  });
  store.approve(p.id);
  await rt.reloadWorkspaceSkills();
  const h = { promptBuilder: rt.promptBuilder, emitTrace() {} };
  const skill = (await rt.skillManagement.catalog(a.canonicalSessionId)).find(
    (s) => s.name === "selected-check",
  );
  rt.store.setDaemonControl(botSkillSelectionKey(a.id), {
    mode: "selected",
    ids: [],
  });
  assert.ok((await resolveSkillLoad(h, skill.id, a.canonicalSessionId)).error);
  assert.equal(
    JSON.parse(
      (await resolveSkillSearch(h, "selected-check", a.canonicalSessionId))
        .content,
    ).hits.length,
    0,
  );
  rt.store.setDaemonControl(botSkillSelectionKey(a.id), {
    mode: "selected",
    ids: [skill.id],
  });
  assert.match(
    (await resolveSkillLoad(h, skill.id, a.canonicalSessionId)).content,
    /Body/,
  );
  const { readBotSkillSelection } =
    await import("../dist/skills/bot-selection.js");
  assert.deepEqual(readBotSkillSelection(rt.store, a.id).ids, [skill.id]);
});
test("runtime tool verifies human request, executes explicit command and proposes autonomous change [AC:agent-skill-management#AC-3] [AC:agent-skill-management#AC-4]", async (t) => {
  const { RawAgentRuntime } = await import("../dist/runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "skill-auth-"));
  let authorize = false;
  let checked = "";
  const rt = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, "state"),
    modelAdapter: {
      name: "test",
      runTurn: async () => ({ assistantParts: [], stopReason: "end" }),
      summarizeMessages: async () => "",
      completeText: async (input) => {
        checked = input.user;
        return JSON.stringify({ authorized: authorize });
      },
    },
  });
  t.after(async () => {
    await rt.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = rt.createBot({ name: "A" }),
    b = rt.createBot({ name: "B" });
  const store = new SkillProposalStore(rt.stateDir);
  const p = store.create({
    name: "auth-check",
    description: "check",
    body: "# Body",
    sessionId: a.canonicalSessionId,
    ownerBotId: a.id,
  });
  store.approve(p.id);
  await rt.reloadWorkspaceSkills();
  const skill = (await rt.skillManagement.catalog(a.canonicalSessionId)).find(
    (s) => s.name === "auth-check",
  );
  const tool = rt.tools.find((t) => t.name === "skill_manage");
  const ctx = {
    session: rt.store.getSession(a.canonicalSessionId),
    agent: { id: a.agentId },
  };
  const pending = JSON.parse(
    (
      await tool.execute(ctx, {
        action: "share",
        skillId: skill.id,
        botIds: [b.id],
      })
    ).content,
  );
  assert.equal(pending.status, "pending");
  assert.equal(
    (await rt.skillManagement.catalog(b.canonicalSessionId)).some(
      (s) => s.id === skill.id,
    ),
    false,
  );
  rt.skillManagement.reject(a.canonicalSessionId, pending.id);
  rt.store.appendMessage(a.canonicalSessionId, "user", [
    { type: "text", text: "Share auth-check with B" },
  ]);
  authorize = true;
  const done = JSON.parse(
    (
      await tool.execute(ctx, {
        action: "share",
        skillId: skill.id,
        botIds: [b.id],
      })
    ).content,
  );
  assert.equal(done.status, "saved", done.error);
  assert.match(checked, /Share auth-check with B/);
});
test("restart settles an interrupted skill operation from the files already on disk", async (t) => {
  const x = fixture(t);
  const proposal = x.seed();
  const captureId = "sc_" + "c".repeat(32);
  mkdirSync(join(x.dir, "skill-captures"), { recursive: true });
  writeFileSync(join(x.dir, "skill-captures", `${captureId}.json`), JSON.stringify({
    id: captureId, sessionId: "a:1", name: "test-check", status: "saved", kind: "new",
    description: "check", reason: "done", summary: "done", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  const dir = join(x.dir, "skill-operations");
  mkdirSync(dir, { recursive: true });
  const write = (suffix, input, extra = {}) => {
    const id = "sm_" + suffix.padStart(32, "0");
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, sessionId: "a:1", agentId: "agent", ownerBotId: "a", input, name: "test-check",
      affectedBotIds: ["a"], revision: "rev", status: "processing", authorization: "user",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra
    }));
    return id;
  };
  const savedCapture = write("1", { action: "create", name: "test-check", description: "check", reason: "done", summary: "done" }, { captureId });
  const missedCreate = write("2", { action: "create", name: "test-check", description: "check", reason: "done", summary: "done" });
  x.proposals.setSharing(proposal.id, "a", ["b"], () => {});
  const shareDone = write("3", { action: "share", skillId: "x", botIds: ["b"] });
  const shareMissed = write("4", { action: "share", skillId: "x", botIds: ["missing-bot"] });
  const unshareDone = write("5", { action: "unshare", skillId: "x", botIds: ["missing-bot"] });
  const unshareMissed = write("6", { action: "unshare", skillId: "x", botIds: ["b"] });
  const sharingDone = write("7", { action: "set_sharing", skillId: "x", botIds: ["b"] });
  const sharingMissed = write("8", { action: "set_sharing", skillId: "x", botIds: [] });
  const deleteMissed = write("9", { action: "delete", skillId: "x" });
  const settled = Object.fromEntries(x.restart().list("a:1").map((row) => [row.id, row]));
  assert.equal(settled[savedCapture].status, "saved");
  assert.equal(settled[savedCapture].error, undefined);
  assert.equal(settled[missedCreate].status, "failed");
  assert.match(settled[missedCreate].error, /interrupted/);
  assert.equal(settled[shareDone].status, "saved");
  assert.equal(settled[shareMissed].status, "failed");
  assert.equal(settled[unshareDone].status, "saved");
  assert.equal(settled[unshareMissed].status, "failed");
  assert.equal(settled[sharingDone].status, "saved");
  assert.equal(settled[sharingMissed].status, "failed");
  assert.equal(settled[deleteMissed].status, "failed");
  x.proposals.revoke(proposal.id);
  const deleteDone = write("a", { action: "delete", skillId: "x" });
  const afterRevoke = x.restart().list("a:1").find((row) => row.id === deleteDone);
  assert.equal(afterRevoke.status, "saved");
});

test("failed revoke restores installed file [AC:agent-skill-management#AC-7]", async (t) => {
  const x = fixture(t);
  const p = x.seed();
  const path = join(x.dir, x.proposals.get(p.id).installedPath);
  x.proposals.write = () => {
    throw Error("disk full");
  };
  assert.throws(() => x.proposals.revoke(p.id), /disk full/);
  assert.equal(existsSync(path), true);
});

test("tool list uses compact summaries without instruction bodies [AC:agent-skill-management#AC-1]", async (t) => {
  const x = fixture(t);
  x.seed();
  const { createSkillManageTool } =
    await import("../dist/skill-proposals/management.js");
  const tool = createSkillManageTool(x.service);
  const result = await tool.execute(
    { session: { id: "a:1" }, agent: { id: "a" } },
    { action: "list", query: "test-check", limit: 1 },
  );
  const data = JSON.parse(result.content);
  assert.equal(data.skills.length, 1);
  assert.equal(data.total, 1);
  assert.equal(data.skills[0].content, undefined);
  assert.equal(data.skills[0].promptFragment, undefined);
});

test('explicit follow-up resolves an existing suggestion by its skill name [AC:agent-skill-management#AC-3]', async t=>{const x=fixture(t);x.seed();let key='first';x.deps.requestKey=()=>key;const skill=(await x.service.catalog('a:1'))[0];const input={action:'share',skillId:skill.id,botIds:['b']};const pending=await x.service.request('a:1','agent',input);key='second';x.deps.authorize=async(s,input)=>input.name==='test-check';const done=await x.service.request('a:1','agent',input);assert.equal(done.id,pending.id);assert.equal(done.status,'saved');});

test('restart reconciles interrupted management against installed effects without replay', async t => {
 const {readFileSync,writeFileSync}=await import('node:fs');
 for(const action of ['create','share','unshare','set_sharing','delete']) {
  await t.test(action,async t=>{
   const x=fixture(t);x.authorize();
   let input={action:'create',name:'recovered-check',description:'check',reason:'Successful workflow',summary:'Save checks'};
   if(action!=='create'){
    const proposal=x.seed();
    if(action==='unshare')x.proposals.setSharing(proposal.id,'a',['b'],()=>{});
    input={action,skillId:(await x.service.catalog('a:1'))[0].id,botIds:['b']};
   }
   const done=await x.service.request('a:1','agent',input);assert.equal(done.status,'saved',done.error);
   const path=join(x.dir,'skill-operations',done.id+'.json');
   const row=JSON.parse(readFileSync(path,'utf8'));row.status='processing';writeFileSync(path,JSON.stringify(row));
   const before=await x.service.catalog('a:1');
   const recovered=x.restart();assert.equal(recovered.list('a:1')[0].status,'saved');
   assert.deepEqual(await recovered.catalog('a:1'),before);
  });
 }
 await t.test('unapplied operation remains failed',async t=>{
  const x=fixture(t);x.seed();
  const op=await x.service.request('a:1','agent',{action:'delete',skillId:(await x.service.catalog('a:1'))[0].id});
  const path=join(x.dir,'skill-operations',op.id+'.json');
  writeFileSync(path,JSON.stringify({...op,status:'processing'}));
  const recovered=x.restart();assert.equal(recovered.list('a:1')[0].status,'failed');
  assert.equal((await recovered.catalog('a:1')).length,1);
 });
});
