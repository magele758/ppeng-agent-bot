import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RawAgentRuntime} from '../dist/runtime.js';
test('routine SOP loads the current file and still honors the saved allowlist [AC:bot-linked-watchers#AC-3]',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'routine-live-sop-')),repo=join(dir,'repo'),skill=join(repo,'skills','delivery-sop');mkdirSync(skill,{recursive:true});
 const write=body=>writeFileSync(join(skill,'SKILL.md'),`---\nname: delivery-sop\ndescription: Current delivery workflow\n---\n${body}`);
 write('CURRENT FIRST VERSION');
 const runtime=new RawAgentRuntime({repoRoot:repo,stateDir:join(dir,'state'),modelAdapter:{name:'idle',runTurn:async()=>({stopReason:'end',assistantParts:[]})}});runtime.emitTrace=()=>{};t.after(async()=>{await runtime.destroy();rmSync(dir,{recursive:true,force:true});});
 const bot=runtime.createBot({name:'SOP watcher'}),sid=bot.canonicalSessionId;
 runtime.store.updateSession(sid,{metadata:{...runtime.store.getSession(sid).metadata,skillScope:'full',allowedSkills:['delivery-sop']}});
 const first=await runtime.loadRoutineSkill('delivery-sop',sid);assert.match(first.content,/CURRENT FIRST VERSION/);
 write('CURRENT SECOND VERSION');const second=await runtime.loadRoutineSkill('delivery-sop',sid);assert.match(second.content,/CURRENT SECOND VERSION/);
 runtime.store.updateSession(sid,{metadata:{...runtime.store.getSession(sid).metadata,allowedSkills:['some-other-skill']}});
 const denied=await runtime.loadRoutineSkill('delivery-sop',sid);assert.equal(denied.content,undefined);assert.match(denied.error,/not enabled|not found/i);
});
