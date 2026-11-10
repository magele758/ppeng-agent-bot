import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadWorkspaceSkills} from '../dist/skills/builtin-skills.js';
import {RawAgentRuntime,BotCoachingService} from '../dist/index.js';
import {writeSkillSettings} from '../dist/skills/skill-settings.js';
import {resolveSkillLoad,resolveSkillSearch} from '../dist/runtime/skill-load.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
async function fixture(){
 const skills=await loadWorkspaceSkills(root);const skill=skills.find(s=>s.name==='bot-coaching');assert.ok(skill,'Repository coaching skill must be discoverable');
 const dir=mkdtempSync(join(tmpdir(),'coaching-playbook-'));const runtime=new RawAgentRuntime({repoRoot:dir,stateDir:join(dir,'state'),extraSkills:[skill],modelAdapter:{name:'coaching-fixture',async runTurn(){return{stopReason:'end',assistantParts:[]};},async summarizeMessages(){return'';}}});
 const bot=runtime.createBot({name:'Coach'});writeSkillSettings(runtime.store,{routingMode:'hybrid',strictLoad:true,disclosureMode:'shortlist'});new BotCoachingService(runtime.store).save(bot.id,0,{requiredSkills:[skill.id]},[]);
 return{skill,bot,runtime,async close(){await runtime.destroy();rmSync(dir,{recursive:true,force:true});}};
}
async function prepare(f){const session=f.runtime.getSession(f.bot.canonicalSessionId);const agent=f.runtime.store.getAgent(f.bot.agentId);await f.runtime.promptBuilder.buildSystemPromptParts({agent,session,repoRoot:f.runtime.repoRoot},[{id:'m',sessionId:session.id,role:'user',parts:[{type:'text',text:'帮我检查一下'}],createdAt:new Date().toISOString()}]);return{promptBuilder:f.runtime.promptBuilder,emitTrace(){}};}
test('repository coaching workflow is discoverable and pinned for strict loading [AC:bot-coaching-playbook#AC-1]',async()=>{const f=await fixture();try{const host=await prepare(f);assert.ok(f.runtime.promptBuilder.getRouting(f.bot.canonicalSessionId).shortlistNames.includes(f.skill.name));const found=await resolveSkillSearch(host,'bot-coaching',f.bot.canonicalSessionId,20);assert.ok(JSON.parse(found.content).hits.some(h=>h.id===f.skill.id));const loaded=await resolveSkillLoad(host,f.skill.id,f.bot.canonicalSessionId);assert.equal(loaded.error,undefined);assert.equal(loaded.skillId,f.skill.id);assert.ok(loaded.content.includes(f.skill.content.trim()),'Loaded workflow must include its complete body');}finally{await f.close();}});
test('pinning the workflow does not override the Bot allowlist [AC:bot-coaching-playbook#AC-2]',async()=>{const f=await fixture();try{f.runtime.updateBot(f.bot.id,{allowedSkills:['Planning']},{skillCatalog:await f.runtime.listSkills()});const host=await prepare(f);assert.ok(!f.runtime.promptBuilder.getRouting(f.bot.canonicalSessionId).shortlistNames.includes(f.skill.name));const result=await resolveSkillLoad(host,f.skill.id,f.bot.canonicalSessionId);assert.ok(result.error);assert.equal(result.skillId,undefined);}finally{await f.close();}});
