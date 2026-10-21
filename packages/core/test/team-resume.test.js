import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { TeamDagExecutor } from '../dist/teams/executor.js';
import { defaultTeamsDagSettings } from '../dist/teams/settings.js';
import { planTeamObjective } from '../dist/teams/planner.js';

function fakeDeps(store, dir) {
  return {
    store,
    settings: () => defaultTeamsDagSettings(),
    stateDir: dir,
    sourceRoot: dir,
    listSessions: () => [],
    getSession: () => undefined,
    createTeammateSession: (input) => ({
      id: `sess-${input.name}`,
      agentId: 'worker',
      status: 'idle'
    }),
    createTask: (input) => ({ id: `task-${input.title.slice(0, 8)}`, workspaceId: undefined }),
    bindWorkspaceForTask: async () => undefined,
    createMail: () => {},
    runSession: async () => {},
    enqueueSchedulerWake: () => {},
    sessionTeammateFinished: () => false
  };
}

test('resume 把 running 节点重置为 pending', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-resume-'));
  try {
    const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
    const store = sqlite.teams();
    const executor = new TeamDagExecutor(fakeDeps(store, dir));
    const created = await executor.createPlan({
      objective: '写一份摘要',
      tasks: [
        { id: 'a', title: 'A', dependsOn: [], role: 'worker' },
        { id: 'b', title: 'B', dependsOn: ['a'], role: 'worker' }
      ]
    });
    assert.ok(created.plan);
    const dirty = created.plan;
    dirty.tasks[0].status = 'running';
    dirty.tasks[0].sessionId = 'dead-session';
    store.upsert(dirty);
    const resumed = executor.resume(dirty.id);
    assert.ok(resumed);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.tasks[0].status, 'pending');
    assert.equal(resumed.tasks[0].sessionId, undefined);
    assert.equal(resumed.tasks[1].status, 'pending');
    sqlite.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPlan respects settings.enabled=false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-off-'));
  try {
    const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
    const store = sqlite.teams();
    const executor = new TeamDagExecutor({
      ...fakeDeps(store, dir),
      settings: () => ({ ...defaultTeamsDagSettings(), enabled: false })
    });
    const created = await executor.createPlan({ objective: '写摘要' });
    assert.equal(created.plan, undefined);
    assert.match(created.error || '', /关闭/);
    sqlite.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start running then reject completed; decideGate fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-start-'));
  try {
    const sqlite = new SqliteStateStore(join(dir, 'runtime.sqlite'));
    const store = sqlite.teams();
    const executor = new TeamDagExecutor(fakeDeps(store, dir));
    const created = await executor.createPlan({
      objective: '写一份摘要',
      tasks: [
        { id: 'a', title: 'A', dependsOn: [], role: 'worker' },
        { id: 'b', title: 'B', dependsOn: ['a'], role: 'worker' }
      ]
    });
    assert.equal(created.plan?.status, 'drafting');
    const started = executor.start(created.plan.id);
    assert.equal(started?.status, 'running');
    store.updateStatus(created.plan.id, 'completed');
    assert.equal(executor.start(created.plan.id), null);

    const again = await executor.createPlan({
      objective: '评审',
      tasks: [{ id: 'a', title: 'A', dependsOn: [], role: 'worker' }]
    });
    const decided = executor.decideGate(again.plan.id, 'review', false);
    const review = decided?.gates.find((g) => g.name === 'review');
    assert.equal(review?.status, 'failed');
    sqlite.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Planner LLM 失败则启发式拆步', async () => {
  const heuristic = await planTeamObjective({
    objective: '调研并实现登录页',
    useLlm: true,
    completeText: async () => {
      throw new Error('upstream down');
    }
  });
  assert.equal(heuristic.source, 'heuristic');
  assert.ok(heuristic.tasks.length >= 2);
  assert.ok(heuristic.edges.length >= 1);

  const llm = await planTeamObjective({
    objective: '调研并实现登录页',
    completeText: async () =>
      JSON.stringify({
        tasks: [
          { id: 'collect', title: '收集', dependsOn: [], role: 'worker' },
          { id: 'write', title: '撰写', dependsOn: ['collect'], role: 'worker' }
        ]
      })
  });
  assert.equal(llm.source, 'llm');
  assert.deepEqual(
    llm.tasks.map((t) => t.id),
    ['collect', 'write']
  );
});

test('starting a plan dispatches ready work with inherited workspace and wakes only its worker', async t => {
 const dir=mkdtempSync(join(tmpdir(),'team-dispatch-'));const sqlite=new SqliteStateStore(join(dir,'state.db'));
 t.after(()=>{sqlite.db.close();rmSync(dir,{recursive:true,force:true});});
 const store=sqlite.teams(),sessions=[],wakes=[];
 const binding={kind:'project',projectId:'existing-project'};
 const executor=new TeamDagExecutor({...fakeDeps(store,dir),
  getSession:id=>id==='parent'?{id,metadata:{workspaceBinding:binding}}:sessions.find(s=>s.id===id),
  createTeammateSession:input=>{const session={...input,id:'worker-session',agentId:'worker',status:'running'};sessions.push(session);return session;},
  enqueueSchedulerWake:(...args)=>wakes.push(args),
  bindWorkspaceForTask:async()=>{assert.fail('host-bound work must not create an isolated fallback');}
 });
 const {plan}=await executor.createPlan({objective:'Write report',sessionId:'parent',tasks:[{id:'a',title:'A',role:'worker',dependsOn:[]},{id:'b',title:'B',role:'worker',dependsOn:['a']}]});
 executor.start(plan.id);await executor.tick();
 assert.equal(sessions.length,1);assert.deepEqual(sessions[0].metadata.workspaceBinding,binding);
 assert.match(sessions[0].prompt,/Inherit the host workspace binding/);
 assert.deepEqual(wakes,[['worker-session','teams.dag.task']]);
 const saved=store.get(plan.id);assert.equal(saved.tasks[0].status,'running');assert.equal(saved.tasks[1].status,'pending');
});
