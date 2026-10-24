import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBotSuite } from '../agent-eval/bot-quality.mjs';
import { buildReliabilitySuite } from '../agent-eval/bot-reliability.mjs';
import { runPairedTasks } from '../agent-eval/paired-runner.mjs';
import { DEFAULT_POLICY, compareQuality } from '../agent-eval/quality.mjs';
import { readFileSync } from 'node:fs';

test('expanded tasks preserve original cases and strict policy without duplicate prompts [AC:bot-completion-reliability#AC-5] [AC:bot-quality-reliability#AC-3] [AC:bot-quality-reliability#AC-4]',()=>{
 const suite=buildReliabilitySuite();assert.ok(suite.length>=30);assert.deepEqual(suite.slice(0,16),buildBotSuite());
 assert.equal(new Set(suite.map(t=>t.turns.join('\n'))).size,suite.length);
 const cfg=JSON.parse(readFileSync('scripts/agent-eval/experiments/bot-reliability.json'));
 assert.deepEqual(cfg.policy,DEFAULT_POLICY);assert.equal(cfg.trials,3);
 assert.ok(suite.length*cfg.trials*2*cfg.limits.maxModelCalls<=cfg.limits.maxTotalCalls);
});
test('paired lanes are bounded, alternate order and retain every repetition [AC:bot-quality-reliability#AC-3]',async()=>{
 let active=0,peak=0;const seen=[];
 const suite=Array.from({length:7},(_,i)=>({id:String(i)}));
 await runPairedTasks(suite,{trials:3,concurrency:3},async(task,trial,label)=>{
  active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));seen.push([task.id,trial,label]);active--;
 });
 assert.equal(peak,3);assert.equal(seen.length,42);
 for(let trial=0;trial<3;trial++)for(let i=0;i<7;i++)assert.deepEqual(seen.filter(r=>r[0]===String(i)&&r[1]===trial).map(r=>r[2]),(trial+i)%2?['candidate','baseline']:['baseline','candidate']);
 await assert.rejects(()=>runPairedTasks(suite,{trials:3,concurrency:50},async()=>{}));
});
test('old missing usage remains unknown and cannot authorize release [AC:bot-quality-reliability#AC-4]',()=>{
 const suite=buildReliabilitySuite();const rows=suite.flatMap(t=>Array.from({length:3},(_,trial)=>['baseline','candidate'].map(variant=>({caseId:t.id,trial,variant,pass:true,tokens:variant==='baseline'?null:100,durationMs:100})))).flat();
 const report=compareQuality(suite,rows,{trials:3});assert.equal(report.promotionEligible,false);assert.equal(report.metrics.tokens.available,false);assert.ok(report.uncertain.includes('missing tokens telemetry'));assert.deepEqual(report.policy,DEFAULT_POLICY);
});

test('request purposes retain attribution without erasing unknown usage [AC:bot-quality-reliability#AC-4]',async()=>{
 const {wireRequestPurpose,readWireUsage}=await import('../agent-eval/bot-quality.mjs');
 for(const [system,purpose] of [['Return JSON {intents:[...]}','intent'],['Evaluate the goal','completion'],['Structured compaction for a continuing bot chat.','summary'],['You are a Bot','turn']])assert.equal(wireRequestPurpose({messages:[{role:'system',content:system}]}),purpose);
 assert.equal(readWireUsage('{}'),null);
});

test('historical version query checks goal state as well as the correct answer [AC:bot-completion-reliability#AC-9]',async()=>{
 const {gradeTask}=await import('../agent-eval/quality.mjs');const task=buildReliabilitySuite().find(t=>t.id==='compact-revision');
 const record={output:'v2.8.4',state:{},status:'idle',invariantsOk:true,toolCalls:[],botEvidence:{compacted:true,goalStatus:'queued'}};
 assert.equal(gradeTask(task,record).pass,false);assert.equal(gradeTask(task,{...record,botEvidence:{compacted:true,goalStatus:'none'}}).pass,true);
});
