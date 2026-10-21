import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { SwarmExecutor } from '../dist/swarm/executor.js';
import { TeamDagExecutor } from '../dist/teams/executor.js';
import { defaultTeamsDagSettings } from '../dist/teams/settings.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'goal-cancel-executor-'));const store=new SqliteStateStore(join(dir,'db'));t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};}
test('Swarm cancellation during dispatch prevents queued launch and next task [AC:bot-multi-goal-coordination#AC-12]',async t=>{
 const {store}=fixture(t);const swarm=store.swarm();const sessions=[],started=[];const now=new Date().toISOString();swarm.createRun({id:'run',goal:'work',status:'pending',strategy:'pipeline',budget:{maxTeammates:4,maxTurnsPerAgent:5,maxDurationMs:60000},qualityGate:[],createdAt:now,updatedAt:now});
 const executor=new SwarmExecutor({store:swarm,listSessions:()=>sessions,getSession:id=>sessions.find(s=>s.id===id),createTeammateSession:input=>{const s={id:`s${sessions.length}`,status:'idle',metadata:input.metadata};sessions.push(s);swarm.updateRunStatus('run','cancelled');return s;},runSession:async id=>{started.push(id);},enqueueSchedulerWake:()=>{},sessionTeammateFinished:()=>false});
 executor.startRun('run',[{title:'one'},{title:'two'}]);await executor.tick();await Promise.resolve();assert.equal(swarm.getRun('run').status,'cancelled');assert.equal(sessions.length,1);assert.deepEqual(started,[]);
});
test('Team cancellation at async dispatch boundary cannot be overwritten or launch next task [AC:bot-multi-goal-coordination#AC-12]',async t=>{
 const {store,dir}=fixture(t);const plans=store.teams();const executor=new TeamDagExecutor({store:plans,settings:()=>({...defaultTeamsDagSettings(),enabled:true,maxConcurrent:4}),stateDir:dir,sourceRoot:dir,listSessions:()=>[],getSession:()=>undefined});
 const created=await executor.createPlan({objective:'work',tasks:[{id:'a',title:'A',dependsOn:[],role:'worker'},{id:'b',title:'B',dependsOn:[],role:'worker'}]});executor.start(created.plan.id);let dispatches=0;
 executor.dispatch=async()=>{dispatches++;plans.updateStatus(created.plan.id,'cancelled');};
 await executor.tick();assert.equal(plans.get(created.plan.id).status,'cancelled');assert.equal(dispatches,1);
});
