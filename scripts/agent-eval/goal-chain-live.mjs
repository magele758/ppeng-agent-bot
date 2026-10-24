import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const code=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [settingsRoot,botId,outputDir]=process.argv.slice(2);
if(!settingsRoot||!botId||!outputDir)throw Error('Usage: node scripts/agent-eval/goal-chain-live.mjs <settings-root> <configured-bot-id> <new-output-directory>');
const main=resolve(settingsRoot);
const core=await import(code+'/packages/core/dist/exports/public.js');
const {configuredModel}=await import(code+'/scripts/agent-eval/configured-model.mjs');
const {tickBotGoals}=await import(code+'/packages/core/dist/bots/goals/scheduler.js');
const {tickBotWork}=await import(code+'/packages/core/dist/bots/bot-work.js');
const {BotGoalService}=await import(code+'/packages/core/dist/bots/goals/service.js');
const config=await configuredModel(main,botId,code);
const model=core.createModelAdapterFromEnv({...config.env,RAW_AGENT_MODEL_PROVIDER:config.model.provider,RAW_AGENT_OPENAI_HTTP_KIND:config.model.httpKind,RAW_AGENT_USE_JSON_MODE:'0'});
const dir=resolve(outputDir);mkdirSync(dir);
const rt=new core.RawAgentRuntime({repoRoot:dir,stateDir:dir+'/state',modelAdapter:model});
console.log(JSON.stringify({dir,model:config.selection}));
const events=[];
async function scenario(name,text) {
 const bot=rt.createBot({name});const sid=rt.openBot(bot.id).sessionId;
 const service=new BotGoalService(rt.store,Date.now,sid);
 rt.sendUserMessage(sid,text);
 const run=rt.runHumanSession(sid).catch(e=>events.push({name,error:String(e)}));
 for(let i=0;i<160;i++) {
  await tickBotWork(rt.botWorkRuntimeHost());await tickBotGoals(rt.goalRuntimeHost());
  const goals=service.list(bot.id);
  if(i%5===0){console.log(JSON.stringify({name,i,goals:goals.map(g=>({status:g.status,attempts:g.attempts,progress:g.progress,next:g.nextStep}))}));save();}
  if(goals.length&&goals.every(g=>['completed','blocked','failed','pending_review','cancelled'].includes(g.status))&&!rt.isSessionRunning(sid))break;
  await new Promise(r=>setTimeout(r,1500));
 }
 if(rt.isSessionRunning(sid))throw Error(name+' exceeded the live acceptance deadline');
 await run;
 const goals=service.list(bot.id);events.push({name,goals});save();
 assert.equal(goals.length,1,name+' must stay one goal');
 assert.equal(goals[0].status,'completed',name+': '+JSON.stringify(goals));
 assert.equal(JSON.parse(readFileSync(dir+'/'+name+'.json','utf8')).value,37);
}
function save(){writeFileSync(dir+'/evidence.json',JSON.stringify({model:config.selection,events,sessions:rt.store.listSessions().map(s=>({session:s,messages:rt.getSessionMessages(s.id)}))},null,2));}
try {
 await scenario('direct','请创建 direct.json，内容为 {"value":37}，然后读取该文件核对数值。完成结果是文件真实存在且数值正确；不要修改其他文件。');
 await scenario('child','请交给一个独立子任务创建 child.json，内容为 {"value":37}，然后读取该文件核对数值。完成结果是由子任务实际写入文件且数值正确；不要修改其他文件。');
 const target=rt.createBot({name:'Recipient'});rt.openBot(target.id);
 await scenario('delegate','请委托给 Bot '+target.id+' 创建 delegate.json，内容为 {"value":37}，然后读取该文件核对数值。完成结果是由指定 Bot 实际写入文件且数值正确；不要修改其他文件。');
 console.log('PASS all default scenarios');
} catch(e) {console.log('FAIL',String(e));events.push({error:String(e)});process.exitCode=1;}
finally {save();for(const s of rt.store.listSessions())if(rt.isSessionRunning(s.id))rt.cancelSession(s.id);await rt.destroy();}
