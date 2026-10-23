import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { BotGoalService } from '../dist/bots/goals/service.js';
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'bot-goals-')); const path=join(dir,'state.db');
 const store=new SqliteStateStore(path); let now=1000; const s=new BotGoalService(store,()=>now);
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 return {s,store,tick:()=>{now+=1000000;}};
}
const create=(s,title='Fix login',extra={})=>s.create({botId:'b',sessionId:'s',title,objective:title,...extra});
test('independent tasks survive progress queries and ambiguous controls [AC:bot-multi-goal-coordination#AC-1] [AC:bot-multi-goal-coordination#AC-2] [AC:bot-multi-goal-coordination#AC-4]',t=>{
 const {s}=fixture(t);const a=create(s),b=create(s,'Watch deploy');
 assert.equal(s.applyIntent('b',{kind:'query'}).goals.length,2);
 assert.equal(s.applyIntent('b',{kind:'cancel'}).clarification,true);
 assert.equal(s.get('b',a.id).status,'queued');assert.equal(s.get('b',b.id).status,'queued');
});
test('old constraints and missing evidence cannot complete a goal [AC:bot-multi-goal-coordination#AC-3] [AC:bot-multi-goal-coordination#AC-7]',t=>{
 const {s}=fixture(t);const a=create(s);const e=s.claim('b',a.id,{strategy:'direct'});
 s.amend('b',a.id,'Keep styling');s.report('b',e.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['tests passed']});
 assert.notEqual(s.get('b',a.id).status,'completed');const e2=s.claim('b',a.id,{strategy:'direct'});
 s.report('b',e2.id,{kind:'candidate_completed',summary:'done'});assert.equal(s.get('b',a.id).status,'blocked');
});
test('waiting survives chat and duplicate wake/result delivery [AC:bot-multi-goal-coordination#AC-8] [AC:bot-multi-goal-coordination#AC-10]',t=>{
 const {s}=fixture(t);const a=create(s);const e=s.claim('b',a.id,{strategy:'direct'});
 const result={kind:'waiting',summary:'Build running',wait:{source:'build',correlationId:'42'},eventId:'r1'};
 s.report('b',e.id,result);create(s,'Other work');s.report('b',e.id,result);
 assert.equal(s.get('b',a.id).status,'waiting');assert.equal(s.wake('b',{eventId:'w1',source:'build',correlationId:'42'}).length,1);
 assert.equal(s.wake('b',{eventId:'w1',source:'build',correlationId:'42'}).length,0);
});
test('restart resumes safe work but reconciles uncertain side effects [AC:bot-multi-goal-coordination#AC-9]',t=>{
 const {s,store,tick}=fixture(t);const a=create(s),b=create(s,'Deploy');s.claim('b',a.id,{strategy:'direct',safeToRetry:true});s.claim('b',b.id,{strategy:'subagent'});tick();
 const recovered=new BotGoalService(store,()=>2000000);recovered.recover('b');assert.equal(recovered.get('b',a.id).status,'queued');assert.equal(recovered.get('b',b.id).status,'blocked');
});
test('conflicting resources queue until execution releases them [AC:bot-multi-goal-coordination#AC-11]',t=>{
 const {s}=fixture(t);const a=create(s,'A',{resources:['deploy:prod']}),b=create(s,'B',{resources:['deploy:prod']});const e=s.claim('b',a.id,{strategy:'direct'});
 assert.equal(s.claim('b',b.id,{strategy:'direct'}),undefined);assert.match(s.get('b',b.id).blockedReason,/resource/);
 s.report('b',e.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['checked']});assert.ok(s.claim('b',b.id,{strategy:'direct'}));
});
test('cancel keeps active work visible and ignores late results [AC:bot-multi-goal-coordination#AC-12]',t=>{
 const {s}=fixture(t);const a=create(s),b=create(s,'Other');const e=s.claim('b',a.id,{strategy:'direct'});s.control('b',a.id,'cancel');
 assert.equal(s.get('b',a.id).draining,true);s.report('b',e.id,{kind:'progress',summary:'late'});assert.equal(s.get('b',a.id).status,'cancelled');assert.equal(s.get('b',b.id).status,'queued');
});
test('budget and no-progress limits accumulate across executors [AC:bot-multi-goal-coordination#AC-13]',t=>{
 const {s}=fixture(t);s.updateSettings({defaultBudgetUsd:1,maxNoProgress:2});const a=create(s);let e=s.claim('b',a.id,{strategy:'direct'});
 s.report('b',e.id,{kind:'progress',summary:'step',costUsd:1});assert.equal(s.get('b',a.id).status,'blocked');assert.match(s.get('b',a.id).blockedReason,/budget/);
 const b=create(s,'Stuck');for(let i=0;i<2;i++){e=s.claim('b',b.id,{strategy:'subagent'});s.report('b',e.id,{kind:'progress',summary:'same'});}assert.equal(s.get('b',b.id).status,'queued');
 e=s.claim('b',b.id,{strategy:'direct'});s.report('b',e.id,{kind:'progress',summary:'same'});assert.equal(s.get('b',b.id).status,'blocked');
});
test('scoped goals and preferences never expose another chat',t=>{
 const {store}=fixture(t);const a=new BotGoalService(store,Date.now,'a'),b=new BotGoalService(store,Date.now,'b');
 const g=a.create({botId:'bot',sessionId:'a',title:'Private',objective:'Private'});
 assert.equal(b.list('bot').length,0);assert.equal(b.get('bot',g.id),undefined);
 assert.throws(()=>b.control('bot',g.id,'cancel'),/not found/);
 a.updateSettings({maxConcurrent:1});assert.equal(b.readSettings().maxConcurrent,4);
 assert.throws(()=>a.updateSettings({unknown:1}),/Unknown/);
});
test('result arriving before wait registration is retained [AC:bot-multi-goal-coordination#AC-8]',t=>{
 const {s}=fixture(t);const g=create(s);const e=s.claim('b',g.id,{strategy:'direct'});
 s.wake('b',{eventId:'early',source:'build',correlationId:'early-build'});
 s.report('b',e.id,{kind:'waiting',summary:'waiting',wait:{source:'build',correlationId:'early-build'}});
 assert.equal(s.get('b',g.id).status,'queued');
});
test('expired and fenced attempts cannot complete or renew ownership',t=>{
 const {s,tick}=fixture(t);const g=create(s);const e=s.claim('b',g.id,{strategy:'direct',owner:'worker'});
 assert.throws(()=>s.report('b',e.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['ok'],owner:'wrong',fence:e.fence}),/fence/);
 tick();assert.throws(()=>s.updateExecution('b',e.id,{leaseUntil:99999999}),/lease/);
 s.report('b',e.id,{kind:'candidate_completed',summary:'done',verified:true,evidence:['ok'],owner:'worker',fence:e.fence});
 assert.equal(s.get('b',g.id).status,'blocked');assert.match(s.get('b',g.id).blockedReason,/lease/);
});
test('unverified progress cannot reset the stall limit with new summaries',t=>{
 const {s}=fixture(t);s.updateSettings({maxNoProgress:2});const g=create(s);
 for(const summary of ['I am looking','I am still looking']){const e=s.claim('b',g.id,{strategy:'direct'});s.report('b',e.id,{kind:'progress',summary,advanced:false});}
 assert.equal(s.get('b',g.id).status,'blocked');assert.match(s.get('b',g.id).blockedReason,/progress/);
});
test('external waiting and constraint-draining work keeps its resource reservation [AC:bot-multi-goal-coordination#AC-11]',t=>{
 const {s}=fixture(t);const a=create(s,'Deployment',{resources:['prod']}),b=create(s,'Other deployment',{resources:['prod']});const e=s.claim('b',a.id,{strategy:'swarm'});s.report('b',e.id,{kind:'waiting',summary:'deployment in progress',wait:{source:'swarm',correlationId:'run'}});assert.equal(s.claim('b',b.id,{strategy:'direct'}),undefined);s.amend('b',a.id,'Use staging instead');assert.equal(s.claim('b',b.id,{strategy:'direct'}),undefined);s.finishAmendDrain('b',a.id,{summary:'Old deployment stopped',evidence:['stopped'],costUsd:0});assert.ok(s.claim('b',b.id,{strategy:'direct'}));
});

test('targeted intent receipts apply controls once and retain amended constraints', t => {
 const {s}=fixture(t);const goal=create(s);
 const amendment={kind:'amend_goal',goalId:goal.id,text:'Keep existing data',sourceMessageId:'amend-1'};
 assert.deepEqual(s.applyIntent('b',amendment).goal.constraints,['Keep existing data']);
 assert.equal(s.applyIntent('b',amendment).duplicate,true);
 assert.equal(s.get('b',goal.id).revision,2);
 for(const [kind,status] of [['pause','paused'],['resume','queued'],['cancel','cancelled']]) {
  assert.equal(s.applyIntent('b',{kind,goalId:goal.id,sourceMessageId:kind}).goal.status,status);
  assert.equal(s.applyIntent('b',{kind,goalId:goal.id,sourceMessageId:kind}).duplicate,true);
 }
 assert.deepEqual(s.get('b',goal.id).constraints,['Keep existing data']);
});

test('explicit failure is terminal and retains the attempted path [AC:unified-bot-goal-lifecycle#AC-2]',t=>{
 const {s}=fixture(t);const goal=create(s);const execution=s.claim('b',goal.id,{strategy:'direct'});
 s.report('b',execution.id,{kind:'failed',summary:'Provider rejected the artifact',evidence:['attempted upload; response 422']});
 const saved=s.get('b',goal.id);assert.equal(saved.status,'failed');assert.match(saved.blockedReason,/rejected/);assert.deepEqual(saved.evidence,['attempted upload; response 422']);assert.equal(s.list('b').length,1);
 assert.throws(()=>s.control('b',goal.id,'resume'),/terminal/);
});
