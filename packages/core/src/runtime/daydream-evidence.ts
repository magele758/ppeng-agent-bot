import type { SqliteStateStore } from '../storage.js';
import { botDefinitionOwner, principalFromSession, sameBotPrincipal } from '../bots/bot-identity.js';
import { daydreamLocalDate } from '../daydream/settings.js';
import { redactToolContent } from '../sandbox/result-redaction.js';
import type { SessionMessage } from '../types.js';
import type { DaydreamEvidence } from '../daydream/types.js';
export function botDaydreamPrincipal(store:SqliteStateStore,botId:string){
 const bot=store.getBot(botId);if(!bot)throw Error('Bot not found');
 const session=store.getSession(bot.canonicalSessionId);if(!session)throw Error('Bot session not found');
 return botDefinitionOwner(store,botId)??principalFromSession(store,session);
}
function toolOutcome(message:SessionMessage):DaydreamEvidence['outcome'] {
 const results=message.parts.filter(p=>p.type==='tool_result');
 if(!results.length)return undefined;
 return results.every(p=>p.ok)?'success':'failure';
}
export function readBotDaydreamEvidence(store:SqliteStateStore,botId:string,date:string,timezone:string):DaydreamEvidence[]{
 const owner=botDaydreamPrincipal(store,botId);const bot=store.getBot(botId)!;
 return store.listSessions().filter(s=>(s.metadata?.botId===botId||s.id===bot.canonicalSessionId)&&sameBotPrincipal(owner,principalFromSession(store,s)))
 .flatMap(session=>store.listMessages(session.id).filter(m=>!m.hidden&&daydreamLocalDate(Date.parse(m.createdAt),timezone)===date).map(m=>({sessionId:session.id,messageId:m.id,seq:m.seq,role:m.role,outcome:toolOutcome(m),createdAt:m.createdAt,content:redactToolContent(m.parts.map(p=>p.type==='text'?p.text:JSON.stringify(p)).join('\n'))})))
 .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.messageId.localeCompare(b.messageId));
}
