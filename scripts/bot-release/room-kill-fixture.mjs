import { SqliteStateStore } from '../../packages/core/dist/storage.js';
import { createBot } from '../../packages/core/dist/bots/index.js';
import { createChatSession } from '../../packages/core/dist/runtime/session-facade.js';
import { resolveBotPrincipal } from '../../packages/core/dist/bots/bot-identity.js';
import { BotRoomService } from '../../packages/core/dist/rooms/index.js';
import { readExecutableFingerprint } from './executable-fingerprint.mjs';
const executableHash=readExecutableFingerprint().hash;

// Intentionally killed by the parent after committed receive and an unconfirmed effect.
const store=new SqliteStateStore(process.argv[2]);
const facade={store,runImageRetention:async()=>{},wakeAllAutonomousSessions(){},wakeAgentSessions(){}};
const bot=createBot(facade,{name:'KillWorker'}),peer=createBot(facade,{name:'KillPeer'}),principal=resolveBotPrincipal(store);
let markStarted;
const started=new Promise(resolve=>markStarted=resolve);
const rooms=new BotRoomService({store,createChatSession:input=>createChatSession(facade,input),cancelSession(){},runSession(id){
  store.updateSession(id,{status:'running'});
  store.setDaemonControl('room.kill.sideEffects',(store.getDaemonControl('room.kill.sideEffects')??0)+1);
  markStarted(id);return new Promise(()=>{});
}});
const room=rooms.create(principal,{title:'Kill recovery',botIds:[bot.id,peer.id],hostBotId:bot.id});
rooms.send(principal,room.id,{text:'first effect'});
void rooms.tick();
const runningSessionId=await started;
const queued=rooms.send(principal,room.id,{text:'accepted while busy',idempotencyKey:'queued'});
process.stdout.write(JSON.stringify({roomId:room.id,runningSessionId,queuedMessageId:queued.message.id,executableHash})+'\n');
setInterval(()=>{},1000);
