import test from 'node:test';
import assert from 'node:assert/strict';
import { planQuality } from '../agent-eval/sample-plan.mjs';
import { buildReliabilitySuite, buildCoreSuite } from '../agent-eval/bot-reliability.mjs';

test('tied intervals use tasks not repeats [AC:bot-quality-sample-plan#AC-1]',()=>{
 const suite=buildReliabilitySuite();
 const a=planQuality(suite,{trials:3}),b=planQuality(suite,{trials:20});
 assert.deepEqual(a.categories,b.categories);
 assert.equal(a.categories.permissions.requiredTiedTasks,162);
 assert.equal(a.tiedPromotionEstablished,false);
 assert.equal(a.minimumWorkerRuns,suite.length*6);
});
test('renamed copies are not extra evidence [AC:bot-quality-sample-plan#AC-2]',()=>{
 const c=buildReliabilitySuite()[0];
 const p=planQuality([c,{...c,id:'renamed-copy'}],{trials:3});
 assert.equal(p.duplicateGroups.length,1);
 assert.equal(p.categories[c.category].distinctTasks,1);
 assert.equal(p.independenceCertified,false);
});
test('expanded cases keep original contracts and add distinct operations [AC:bot-quality-sample-plan#AC-3]',()=>{
 const suite=buildReliabilitySuite();
 assert.equal(suite.length,40);
 for(const id of ['join-unmatched','csv-quoted','pagination-cycle','denied-read-no-write','untrusted-record-command','missing-vs-null','conflicting-evidence','stable-dedup']) assert.ok(suite.find(c=>c.id===id));
 assert.equal(suite.find(c=>c.id==='compact-revision').expected.botEvidence.goalStatus,'none');
 assert.equal(planQuality(suite,{trials:3}).duplicateGroups.length,0);
});

test('core subset preserves policy and cannot certify release [AC:bot-quality-sample-plan#AC-1]',async()=>{
 const {readFileSync}=await import('node:fs');
 const core=JSON.parse(readFileSync(new URL('../agent-eval/experiments/bot-core.json',import.meta.url)));
 const full=JSON.parse(readFileSync(new URL('../agent-eval/experiments/bot-reliability.json',import.meta.url)));
 assert.deepEqual(core.policy,full.policy);
 assert.equal(buildCoreSuite().length,16);
 assert.equal(planQuality(buildCoreSuite(),core).tiedPromotionEstablished,false);
 assert.equal(buildCoreSuite().length*core.trials*2*core.limits.maxModelCalls<=core.limits.maxTotalCalls,true);
});
