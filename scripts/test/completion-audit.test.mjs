import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTextCompletion, serializeEvidence } from '../agent-eval/completion-audit.mjs';

test('judge audit retains exact input, invalid output and errors without changing outcomes [AC:bot-completion-reliability#AC-1]',async()=>{
 const records=[];const input={system:'Evaluate the goal',user:'{"goal":"save"}',jsonMode:true,signal:new AbortController().signal};
 const observed=observeTextCompletion(async()=>'{malformed',records,()=>{});
 assert.equal(await observed(input),'{malformed');assert.equal(records[0].raw,'{malformed');assert.deepEqual(records[0].input,{system:input.system,user:input.user,jsonMode:true});
 const error=new Error('upstream stopped');const failing=observeTextCompletion(async()=>{throw error;},records,()=>{});
 await assert.rejects(()=>failing(input),error);assert.equal(records[1].error,'upstream stopped');assert.ok(records.every(r=>r.durationMs>=0));
});

test('raw judge evidence redacts keys including JSON escapes [AC:bot-completion-reliability#AC-1]',()=>{
 const secret='fixture-"key\nsecret';const serialized=serializeEvidence({input:{user:secret},raw:secret,error:'Error '+secret},secret);
 assert.deepEqual(JSON.parse(serialized),{input:{user:'[REDACTED]'},raw:'[REDACTED]',error:'Error [REDACTED]'});
});
