import { SqliteStateStore } from '../../packages/core/dist/storage.js';
import { createBot } from '../../packages/core/dist/bots/index.js';
import { resolveBotPrincipal } from '../../packages/core/dist/bots/bot-identity.js';
import { dispatchBotTask,tickBotWork } from '../../packages/core/dist/bots/bot-work.js';
import { readExecutableFingerprint } from './executable-fingerprint.mjs';
const executableHash=readExecutableFingerprint().hash;

const store=new SqliteStateStore(process.argv[2]);
const facade={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};
const sender=createBot(facade,{name:'KillCoordinator'}),target=createBot(facade,{name:'KillTaskWorker'}),principal=resolveBotPrincipal(store);
let markStarted;const started=new Promise(resolve=>markStarted=resolve);
const host={store,log:{info(){},warn(){},error(){}},runSession(id){
  store.updateSession(id,{status:'running'});
  store.appendMessage(id,'assistant',[{type:'tool_call',toolCallId:'unconfirmed-write',name:'write_file',input:{path:'effect',content:'unconfirmed'}}]);
  store.setDaemonControl('bot.kill.sideEffects',(store.getDaemonControl('bot.kill.sideEffects')??0)+1);
  markStarted(id);return new Promise(()=>{});
}};
const running=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:target.id,input:'UNCONFIRMED_EFFECT_TRIGGER',idempotencyKey:'first'});
await tickBotWork(host);const sessionId=await started;
const queued=dispatchBotTask(host,{principal,requesterBotId:sender.id,targetBotId:target.id,input:'SAFE_NEW_QUEUED_TASK',idempotencyKey:'second'});
process.stdout.write(JSON.stringify({runningTaskId:running.id,queuedTaskId:queued.id,sessionId,executableHash})+'\n');
setInterval(()=>{},1000);
