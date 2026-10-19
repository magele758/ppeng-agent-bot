import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "../dist/storage.js";
import { createBot } from "../dist/bots/index.js";
import {
  botPrincipalKey,
  principalFromSession,
  resolveBotPrincipal,
} from "../dist/bots/bot-identity.js";
import { BotRoomService } from "../dist/rooms/index.js";
import { FactoryService } from "../dist/factory/service.js";
import { createFactoryTools } from "../dist/factory/tools.js";

const TOKEN = "daemon-token-should-not-leak";

function settingsKey(principal) {
  return "factory.settings:" + botPrincipalKey(principal);
}

function grant(store, userId, tenantId, role) {
  const memory = store.agentMemory();
  memory.upsertTenant({ id: tenantId, name: tenantId });
  memory.upsertUser({ id: userId, status: "active" });
  memory.addMembership({ userId, tenantId, role });
}

async function fixture(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "superbot-factory-"));
  const store = new SqliteStateStore(join(dir, "db"));
  const facade = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {},
  };
  const superBot = createBot(facade, {
    name: "Super Bot",
    title: "Team coordinator",
  });
  store.setDaemonControl("bot.superBotId", superBot.id);
  const worker = createBot(facade, { name: "Worker" });
  const login = opts.login !== false;
  const userId = opts.userId ?? "alice";
  const tenantId = opts.tenantId ?? "team";
  const role = opts.role ?? "owner";
  if (login) grant(store, userId, tenantId, role);
  const rooms = new BotRoomService({
    store,
    createChatSession() {
      throw new Error("No model should run");
    },
    runSession() {
      throw new Error("No model should run");
    },
    cancelSession() {},
  });
  const probes = [];
  const transport = {
    async probe(machine) {
      probes.push(machine.sshAlias);
      return { identity: "host-" + machine.sshAlias, hostname: machine.sshAlias };
    },
    async start() {
      throw new Error("start should not run");
    },
    async status() {
      throw new Error("status should not run");
    },
    async inspect() {
      throw new Error("inspect should not run");
    },
  };
  const service = new FactoryService({ store, rooms }, transport);
  const metadata = { approvalWake: {kind: "human", source: "lab-chat"}, botId: superBot.id, ...(login ? { userId, tenantId } : {}) };
  const session = store.createSession({
    title: "Super Bot chat",
    mode: "chat",
    agentId: superBot.id,
    metadata,
  });
  store.appendMessage(session.id, "user", [{type:"text",text:"Configure the factory"}]);
  t.after(async () => {
    await service.close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const principal = principalFromSession(store, session);
  return {
    store,
    rooms,
    service,
    session,
    superBot,
    worker,
    probes,
    principal,
    facade,
    dir,
  };
}

function tool(bundle, name) {
  const found = bundle.find((item) => item.name === name);
  assert.ok(found, name);
  return found;
}

function machine(workerId, extra = {}) {
  return {
    id: "ubuntu1",
    name: "Ubuntu 1",
    sshAlias: "ubuntu1",
    capacity: 2,
    botIds: [workerId],
    repositories: [{ id: "core", path: "/srv/app" }],
    ...extra,
  };
}

function seedOther(f, principal, botId) {
  const room = f.rooms.create(principal, {
    title: "Other",
    botIds: [botId],
    hostBotId: botId,
  });
  f.service.saveSettings(principal, {
    roomId: room.id,
    coordinatorBotId: botId,
    machines: [
      {
        id: "other",
        name: "Other",
        sshAlias: "otherhost",
        capacity: 1,
        botIds: [botId],
        allowedUserIds: [principal.userId],
        repositories: [{ id: "core", path: "/other/repo" }],
      },
    ],
  });
  return JSON.stringify(f.service.settings(principal));
}

test("saved factory settings belong only to the chatting principal [AC:superbot-factory-setup#AC-1]", async (t) => {
  const f = await fixture(t, { role: "owner" });
  const bob = { userId: "bob", tenantId: "team" };
  const bobBefore = seedOther(f, bob, f.worker.id);
  const installation = resolveBotPrincipal(f.store);
  const installationBefore = f.store.getDaemonControl(settingsKey(installation));
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    {
      machines: [machine(f.worker.id)],
      userId: "bob",
      tenantId: "team",
      owner: { userId: "bob", tenantId: "team" },
    },
  );
  assert.equal(result.ok, true, result.content);
  const saved = f.service.settings(f.principal);
  assert.equal(saved.owner.userId, "alice");
  assert.equal(saved.owner.tenantId, "team");
  assert.equal(saved.machines[0].sshAlias, "ubuntu1");
  assert.equal(saved.machines[0].capacity, 2);
  assert.deepEqual(saved.machines[0].botIds, [f.worker.id]);
  assert.equal(saved.coordinatorBotId, f.superBot.id);
  assert.equal(JSON.stringify(f.service.settings(bob)), bobBefore);
  assert.equal(f.store.getDaemonControl(settingsKey(installation)), installationBefore);
  assert.equal(f.store.getDaemonControl(settingsKey(bob)).machines[0].sshAlias, "otherhost");
});

test("login off writes the installation factory row only [AC:superbot-factory-setup#AC-1]", async (t) => {
  const f = await fixture(t, { login: false });
  const bob = { userId: "bob", tenantId: "team" };
  const bobBefore = seedOther(f, bob, f.worker.id);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute(
    {
      session: {
        ...f.session,
        metadata: { ...f.session.metadata, userId: "bob", tenantId: "team" },
      },
    },
    { machines: [machine(f.worker.id)], userId: "bob", owner: bob },
  );
  assert.equal(result.ok, true, result.content);
  const installation = resolveBotPrincipal(f.store);
  const saved = f.service.settings(installation);
  assert.equal(saved.owner.userId, installation.userId);
  assert.equal(saved.owner.tenantId, undefined);
  assert.equal(saved.machines[0].sshAlias, "ubuntu1");
  assert.equal(JSON.stringify(f.service.settings(bob)), bobBefore);
  assert.equal(f.store.getDaemonControl(settingsKey(bob)).machines[0].sshAlias, "otherhost");
});

test("preparing a factory with no room creates one that contains Super Bot [AC:superbot-factory-setup#AC-2]", async (t) => {
  const f = await fixture(t, { role: "admin" });
  assert.equal(f.rooms.list(f.principal).length, 0);
  let creates = 0;
  const original = f.rooms.create.bind(f.rooms);
  f.rooms.create = (principal, input) => {
    creates += 1;
    return original(principal, input);
  };
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute({ session: f.session }, { machines: [machine(f.worker.id)] });
  assert.equal(result.ok, true, result.content);
  assert.equal(creates, 1);
  const rooms = f.rooms.list(f.principal);
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0].botIds.includes(f.superBot.id));
  const saved = f.service.settings(f.principal);
  assert.equal(saved.roomId, rooms[0].id);
  assert.equal(saved.coordinatorBotId, f.superBot.id);
});

test("omitted coordinator is Super Bot and Super Bot is a room member [AC:superbot-factory-setup#AC-4]", async (t) => {
  const f = await fixture(t);
  const room = f.rooms.create(f.principal, {
    title: "Workers",
    botIds: [f.worker.id],
    hostBotId: f.worker.id,
  });
  assert.equal(room.botIds.includes(f.superBot.id), false);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    { roomId: room.id, machines: [machine(f.worker.id)] },
  );
  assert.equal(result.ok, true, result.content);
  const saved = f.service.settings(f.principal);
  assert.equal(saved.coordinatorBotId, f.superBot.id);
  assert.equal(saved.roomId, room.id);
  assert.ok(f.rooms.get(f.principal, room.id).botIds.includes(f.superBot.id));
});

test("omitted dispatch list is the chatting user and that user can probe [AC:superbot-factory-setup#AC-5]", async (t) => {
  const f = await fixture(t);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute({ session: f.session }, { machines: [machine(f.worker.id)] });
  assert.equal(result.ok, true, result.content);
  const saved = f.service.settings(f.principal);
  assert.deepEqual(saved.machines[0].allowedUserIds, [f.principal.userId]);
  const probe = await f.service.probe(f.principal, "ubuntu1");
  assert.equal(probe.online, true);
  assert.deepEqual(f.probes, ["ubuntu1"]);
});

test("a new factory save leaves patrol off [AC:superbot-factory-setup#AC-6]", async (t) => {
  const f = await fixture(t);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    { machines: [machine(f.worker.id)], patrol: { enabled: true, timezone: "UTC" } },
  );
  assert.equal(result.ok, true, result.content);
  const saved = f.service.settings(f.principal);
  assert.equal(saved.patrol.enabled, false);
  assert.equal(saved.patrol.timezone, "Asia/Shanghai");
});

test("an explicit patrol request turns patrol on [AC:superbot-factory-setup#AC-7]", async (t) => {
  const f = await fixture(t);
  const tools = createFactoryTools(f.store, f.rooms, f.service);
  const save = tool(tools, "factory_settings_save");
  const patrol = tool(tools, "factory_patrol_set");
  assert.equal((await save.execute({ session: f.session }, { machines: [machine(f.worker.id)] })).ok, true);
  assert.equal(f.service.settings(f.principal).patrol.enabled, false);
  const turnedOn = await patrol.execute({ session: f.session }, { enabled: true });
  assert.equal(turnedOn.ok, true, turnedOn.content);
  assert.equal(f.service.settings(f.principal).patrol.enabled, true);
  const again = await save.execute(
    { session: f.session },
    { machines: [machine(f.worker.id, { capacity: 5 })], patrol: { enabled: false } },
  );
  assert.equal(again.ok, true, again.content);
  const visible = f.service.settings(f.principal);
  assert.equal(visible.patrol.enabled, true);
  assert.equal(visible.machines[0].capacity, 5);
});

test("a non-owner non-admin cannot change factory settings [AC:superbot-factory-setup#AC-9]", async (t) => {
  const owner = await fixture(t, { userId: "alice", role: "owner" });
  grant(owner.store, "mallory", "team", "member");
  const before = seedOther(owner, owner.principal, owner.worker.id);
  const mallory = owner.store.createSession({
    title: "Mallory",
    mode: "chat",
    agentId: owner.superBot.id,
    metadata: { botId: owner.superBot.id, userId: "mallory", tenantId: "team" },
  });
  const tools = createFactoryTools(owner.store, owner.rooms, owner.service);
  const save = tool(tools, "factory_settings_save");
  const patrol = tool(tools, "factory_patrol_set");
  const roomCount = owner.rooms.list(owner.principal).length;
  const denied = await save.execute(
    { session: mallory },
    { machines: [machine(owner.worker.id, { sshAlias: "stolen", id: "stolen" })] },
  );
  assert.equal(denied.ok, false);
  assert.match(denied.content, /没有权限/);
  assert.equal(JSON.stringify(owner.service.settings(owner.principal)), before);
  assert.equal(owner.rooms.list(owner.principal).length, roomCount);
  assert.equal(owner.store.getDaemonControl(settingsKey(principalFromSession(owner.store, mallory))), undefined);
  const patrolDenied = await patrol.execute({ session: mallory }, { enabled: true });
  assert.equal(patrolDenied.ok, false);
  assert.match(patrolDenied.content, /没有权限/);
  assert.equal(owner.service.settings(owner.principal).patrol.enabled, false);
  assert.equal(owner.service.settings(owner.principal).machines[0].sshAlias, "otherhost");
});

test("factory write tools stay on the registered list for the coordinator", async (t) => {
  const f = await fixture(t);
  const names = createFactoryTools(f.store, f.rooms, f.service).map((item) => item.name);
  for (const name of ["factory_settings_save", "factory_patrol_set", "factory_list_repos", "factory_dispatch", "factory_status"]) {
    assert.ok(names.includes(name), name);
  }
});

test("one discovered checkout is stored when the user asks to fill the repository", async (t) => {
  const f = await fixture(t);
  const seen = [];
  const save = tool(createFactoryTools(f.store, f.rooms, f.service, {
    listGitCheckouts: async (alias) => {
      seen.push(alias);
      return ["/only/repo"];
    },
  }), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    { machines: [{ id: "ubuntu1", name: "Ubuntu 1", sshAlias: "ubuntu1", capacity: 2, botIds: [f.worker.id], fillRepository: true }] },
  );
  assert.equal(result.ok, true, result.content);
  assert.deepEqual(seen, ["ubuntu1"]);
  assert.deepEqual(f.service.settings(f.principal).machines[0].repositories, [{ id: "repo", path: "/only/repo" }]);
});

test("several discovered checkouts are not written into factory settings", async (t) => {
  const f = await fixture(t);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service, {
    listGitCheckouts: async () => ["/a", "/b"],
  }), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    { machines: [{ sshAlias: "ubuntu1", capacity: 2, botIds: [f.worker.id], fillRepository: true }] },
  );
  assert.equal(result.ok, false);
  assert.equal(f.store.getDaemonControl(settingsKey(f.principal)), undefined);
  assert.equal(f.rooms.list(f.principal).length, 0);
  assert.match(result.content, /\/a/);
  assert.match(result.content, /\/b/);
});

test("factory_list_repos calls listGitCheckouts for the saved alias and does not spawn", async (t) => {
  const deps = {listGitCheckouts: async (alias, ...extra) => {
    assert.equal(extra.length,0);
    assert.equal(typeof alias,'string');
    assert.equal(alias.includes(TOKEN),false);
    return ['/only/'+alias,'/also/'+alias];
  }};
  const previous = process.env.RAW_AGENT_AUTH_TOKEN;
  process.env.RAW_AGENT_AUTH_TOKEN = TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.RAW_AGENT_AUTH_TOKEN;
    else process.env.RAW_AGENT_AUTH_TOKEN = previous;
  });
  const spawned = [];
  const original = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args) => {
    spawned.push(args[0]);
    return original.apply(childProcess, args);
  });
  const f = await fixture(t);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service, deps), "factory_settings_save");
  assert.equal((await save.execute({ session: f.session }, { machines: [machine(f.worker.id)] })).ok, true);
  const list = tool(createFactoryTools(f.store, f.rooms, f.service, deps), "factory_list_repos");
  const result = await list.execute({ session: f.session }, { machineId: "ubuntu1", sshAlias: "elsewhere" });
  assert.equal(result.ok, false, result.content);
  const listed = await list.execute({ session: f.session }, { machineId: "ubuntu1" });
  assert.equal(listed.ok, true, listed.content);
  assert.deepEqual(JSON.parse(listed.content).paths, ["/only/ubuntu1", "/also/ubuntu1"]);
  assert.equal(listed.content.includes(TOKEN), false);
  assert.equal(spawned.length, 0);
  assert.equal(JSON.stringify(f.service.settings(f.principal)).includes(TOKEN), false);
});

test("specified coordinator and dispatch list are stored as given", async (t) => {
  const f = await fixture(t);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute(
    { session: f.session },
    {
      coordinatorBotId: f.worker.id,
      machines: [machine(f.worker.id, { allowedUserIds: ["alice", "carol"] })],
    },
  );
  assert.equal(result.ok, true, result.content);
  const saved = f.service.settings(f.principal);
  assert.equal(saved.coordinatorBotId, f.worker.id);
  assert.deepEqual(saved.machines[0].allowedUserIds, ["alice", "carol"]);
  assert.ok(f.rooms.get(f.principal, saved.roomId).botIds.includes(f.worker.id));
});

test("plan mode does not write factory settings", async (t) => {
  const f = await fixture(t);
  f.store.updateSession(f.session.id, {
    metadata: { ...f.session.metadata, permissionMode: "plan" },
  });
  const session = f.store.getSession(f.session.id);
  const save = tool(createFactoryTools(f.store, f.rooms, f.service), "factory_settings_save");
  const result = await save.execute({ session }, { machines: [machine(f.worker.id)] });
  assert.equal(result.ok, false);
  assert.match(result.content, /plan mode/);
  assert.equal(f.store.getDaemonControl(settingsKey(f.principal)), undefined);
  assert.equal(f.rooms.list(f.principal).length, 0);
});


test("factory setup rejects delegated and unattended writes even under the owner's identity", async (t) => {
  const f = await fixture(t);
  const tools = createFactoryTools(f.store, f.rooms, f.service);
  for (const source of ['bot-message', 'delegation', 'routine', 'scheduler']) {
    f.store.updateSession(f.session.id,{metadata:{...f.session.metadata,approvalWake:{kind:'unattended',source}}});
    for (const [name,args] of [['factory_settings_save',{machines:[machine(f.worker.id)]}],['factory_patrol_set',{enabled:true}]]) {
      assert.equal((await tool(tools,name).execute({session:f.session},args)).ok,false,source+name);
    }
    assert.equal(f.store.getDaemonControl(settingsKey(f.principal)),undefined);
  }
  f.store.updateSession(f.session.id,{mode:'subagent',metadata:f.session.metadata});
  assert.equal((await tool(tools,'factory_settings_save').execute({session:f.session},{machines:[]})).ok,false);
  assert.equal((await tool(tools,'factory_patrol_set').execute({session:f.session},{enabled:true})).ok,false);
  assert.equal(f.rooms.list(f.principal).length,0);
});

test("factory settings revalidate administrator authority after asynchronous discovery", async (t) => {
  const f=await fixture(t);
  const save=tool(createFactoryTools(f.store,f.rooms,f.service,{listGitCheckouts:async()=>{
    grant(f.store,f.principal.userId,f.principal.tenantId,'member'); return ['/srv/app'];
  }}),'factory_settings_save');
  assert.equal((await save.execute({session:f.session},{machines:[{sshAlias:'worker',fillRepository:true}]})).ok,false);
  assert.equal(f.store.getDaemonControl(settingsKey(f.principal)),undefined);
  assert.equal(f.rooms.list(f.principal).length,0);
});


test("incomplete discovery leaves settings and rooms untouched", async (t) => {
  const f=await fixture(t);
  const save=tool(createFactoryTools(f.store,f.rooms,f.service,{listGitCheckouts:async()=>{throw new Error('Repository discovery was incomplete');}}),'factory_settings_save');
  const result=await save.execute({session:f.session},{machines:[{sshAlias:'worker',fillRepository:true}]});
  assert.equal(result.ok,false);
  assert.match(result.content,/incomplete/);
  assert.equal(f.store.getDaemonControl(settingsKey(f.principal)),undefined);
  assert.equal(f.rooms.list(f.principal).length,0);
});

for (const end of ['cancel','handoff']) test(`factory discovery cannot save from a ${end}led execution [AC:superbot-factory-setup#AC-1] [AC:session-multiprocess-state-consistency#AC-2]`,async t=>{
 const f=await fixture(t),controller=new AbortController();
 let release,started;const gate=new Promise(r=>{release=r;});const entered=new Promise(r=>{started=r;});
 const save=tool(createFactoryTools(f.store,f.rooms,f.service,{listGitCheckouts:async()=>{started();await gate;return ['/srv/app'];}}),'factory_settings_save');
 f.store.claimWriter(f.session.id,'old');
 const pending=f.store.runWithWriter(f.session.id,'old',()=>save.execute({session:f.session,abortSignal:controller.signal},{machines:[{sshAlias:'worker',fillRepository:true}]}));
 await entered;
 if(end==='cancel')controller.abort();
 f.store.releaseWriter(f.session.id,'old');
 if(end==='handoff')f.store.claimWriter(f.session.id,'new');
 f.store.updateSession(f.session.id,{status:end==='cancel'?'failed':'running'});
 release();const result=await pending;
 assert.equal(result.ok,false,result.content);
 assert.equal(f.store.getDaemonControl(settingsKey(f.principal)),undefined);
 assert.equal(f.rooms.list(f.principal).length,0);
 if(end==='handoff')f.store.releaseWriter(f.session.id,'new');
});

test('failed factory save rolls back the newly created room',async t=>{
 const f=await fixture(t);
 f.service.saveSettings=()=>{throw new Error('save fault');};
 const save=tool(createFactoryTools(f.store,f.rooms,f.service),'factory_settings_save');
 const result=await save.execute({session:f.session},{machines:[machine(f.worker.id)]});
 assert.equal(result.ok,false);assert.match(result.content,/save fault/);
 assert.equal(f.rooms.list(f.principal).length,0);
 assert.equal(f.store.getDaemonControl(settingsKey(f.principal)),undefined);
});

test('revoked or aborted patrol execution cannot change saved settings [AC:superbot-factory-setup#AC-7] [AC:session-multiprocess-state-consistency#AC-2]',async t=>{
 const f=await fixture(t),tools=createFactoryTools(f.store,f.rooms,f.service);
 assert.equal((await tool(tools,'factory_settings_save').execute({session:f.session},{machines:[machine(f.worker.id)]})).ok,true);
 const patrol=tool(tools,'factory_patrol_set'),controller=new AbortController();
 controller.abort();
 assert.equal((await patrol.execute({session:f.session,abortSignal:controller.signal},{enabled:true})).ok,false);
 assert.equal(f.service.settings(f.principal).patrol.enabled,false);
 f.store.claimWriter(f.session.id,'old');
 const result=await f.store.runWithWriter(f.session.id,'old',async()=>{
  f.store.runWithoutWriterScope(()=>{f.store.releaseWriter(f.session.id,'old');f.store.claimWriter(f.session.id,'new');});
  return patrol.execute({session:f.session},{enabled:true});
 });
 assert.equal(result.ok,false);assert.equal(f.service.settings(f.principal).patrol.enabled,false);
 f.store.releaseWriter(f.session.id,'new');
});
