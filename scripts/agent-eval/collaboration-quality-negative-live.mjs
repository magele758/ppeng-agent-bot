/** Explicit negative live control: mutate only a completed isolated trial, then restore and retest. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const code=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [settingsRoot,botId,output]=process.argv.slice(2);
if(!output)throw Error('Usage: node scripts/agent-eval/collaboration-quality-negative-live.mjs <settings-root> <configured-bot-id> <completed-trial-directory>');
const dir=resolve(output);
const {configuredModel}=await import(code+'/scripts/agent-eval/configured-model.mjs');
const {RawAgentRuntime,createModelAdapterFromEnv,sanitizeSpawnEnv}=await import(code+'/packages/core/dist/exports/public.js');
const {runQualityCheck}=await import(code+'/packages/core/dist/runtime/quality-gates.js');
const cfg=await configuredModel(settingsRoot,botId,code);
const adapter=createModelAdapterFromEnv({...cfg.env,RAW_AGENT_MODEL_PROVIDER:cfg.model.provider,RAW_AGENT_OPENAI_HTTP_KIND:cfg.model.httpKind,RAW_AGENT_USE_JSON_MODE:'0'});
const rt=new RawAgentRuntime({repoRoot:dir,stateDir:dir+'/state',modelAdapter:adapter});
const previous=JSON.parse(readFileSync(dir+'/evidence.json'));
const parent=rt.store.getSession(previous.sessions.find(s=>s.session.mode==='teammate').session.id);
const original=readFileSync(dir+'/totals.mjs','utf8');
const testOriginal=readFileSync(dir+'/acceptance.test.mjs','utf8');
const evidence={model:cfg.selection.name,startedAt:new Date().toISOString(),scope:'One intentional artifact mutation in the isolated live-model sample; fixture unchanged; restore in finally.'};
const timer=setTimeout(()=>{for(const s of rt.store.listSessions())if(rt.isSessionRunning(s.id))rt.cancelSession(s.id);},300000);
try{
 writeFileSync(dir+'/totals.mjs','export function summarize() { return []; }\n');
 const gate=await runQualityCheck({store:rt.store,runSession:id=>rt.runSession(id)},{stage:'test',title:'Negative delivery trial',criteria:['Group accounts and sum integer cents; reject unsafe and fractional values. Run node --test acceptance.test.mjs.'],implementation:parent,context:'Artifact totals.mjs and unchanged acceptance.test.mjs. Verify actual behavior, not previous reports.'});
 const parts=rt.store.foldMessages(gate.sessionId).flatMap(m=>m.parts);
 const executions=parts.filter(p=>p.type==='tool_result'&&p.name==='work_evidence');
 assert.equal(gate.passed,false,'A broken artifact must not pass');
 assert.ok(executions.some(p=>{try{return JSON.parse(p.content).verify?.exit_code>0;}catch{return false;}}),'Real nonzero test exit must be observed');
 evidence.gate=gate;evidence.executions=executions;evidence.outcome='pass';
 console.log('PASS: independent live tester executed tests and the quality gate rejected the broken artifact');
}catch(e){evidence.outcome='fail';evidence.error=String(e);process.exitCode=1;console.error(String(e));}
finally{
 clearTimeout(timer);writeFileSync(dir+'/totals.mjs',original);
 assert.equal(readFileSync(dir+'/acceptance.test.mjs','utf8'),testOriginal);
 const checked=spawnSync(process.execPath,['--test','acceptance.test.mjs'],{cwd:dir,env:sanitizeSpawnEnv(process.env),timeout:30000,encoding:'utf8'});
 evidence.restoredTestExitCode=checked.status;evidence.finishedAt=new Date().toISOString();
 writeFileSync(dir+'/evidence-negative.json',JSON.stringify(evidence,null,2));
 if(checked.status!==0)process.exitCode=1;
 for(const s of rt.store.listSessions())if(rt.isSessionRunning(s.id))rt.cancelSession(s.id);
 await rt.destroy();
}
