import {createHash} from 'node:crypto';
import type {BotWorkHost} from './bot-work.js';
import {enqueueBotMessage,botWorkStatus} from './bot-work.js';
import {principalFromSession,sameBotPrincipal,botPrincipalKey,type BotPrincipal} from './bot-identity.js';
import {botStatusSnapshots,type BotStatusSnapshot} from './bot-status-snapshot.js';
import {statusObservation} from './status-observation.js';
import {createId} from '../id.js';
import {stableJson} from '../cron/notification-decision.js';
import type {SessionRecord,MessagePart,ToolContract} from '../types.js';
interface StatusRequest {id:string;principal:BotPrincipal;requesterBotId:string;targetBotId:string;requestedAt:string;deadlineAt:string;idem:string;maxAgeMs:number;snapshot:BotStatusSnapshot;latestSnapshot?:BotStatusSnapshot;messageId?:string;reportedAt?:string;observedAt?:string;summary?:string;evidenceMessageIds?:string[];replyMessageId?:string;replyHash?:string}
interface RequestInput {targetBotId:string;idempotencyKey:string;deadlineMs?:number;maxAgeMs?:number}
interface ReportInput {requestId:string;summary:string;evidenceMessageIds?:string[]}
const requestKey=(id:string)=>`bot.status-request:${id}`;
function withinScope(host:BotWorkHost,session:SessionRecord,scopeId:string,principal:BotPrincipal,botId:string):boolean {
 const visited=new Set<string>();let cursor:SessionRecord|undefined=session;
 while(cursor&&!visited.has(cursor.id)&&visited.size<64){
  if(cursor.metadata.botId!==botId||!sameBotPrincipal(principalFromSession(host.store,cursor),principal))return false;
  if(cursor.id===scopeId)return true;
  visited.add(cursor.id);cursor=cursor.parentSessionId?host.store.getSession(cursor.parentSessionId):undefined;
 }
 return false;
}
export class BotStatusRequests {
 constructor(private host:BotWorkHost,private clock:()=>number=Date.now){}
 private context(sessionId:string):{session:SessionRecord;botId:string;principal:BotPrincipal}{
  const session=this.host.store.getSession(sessionId),botId=session?.metadata.botId;
  if(!session||typeof botId!=='string'||!this.host.store.getBot(botId))throw new Error('Status requests require a live Bot context');
  const principal=principalFromSession(this.host.store,session);
  const row=(botWorkStatus(this.host,principal) as {bot:{id:string};sessionId:string|null}[]).find(row=>row.bot.id===botId);
  if(!row?.sessionId||!withinScope(this.host,session,row.sessionId,principal,botId))throw new Error('Bot context is not authorized');
  return {session,botId,principal};
 }
 private authorized(sessionId:string,id:string):{record:StatusRequest;botId:string}{
  const ctx=this.context(sessionId),record=this.host.store.getDaemonControl<StatusRequest>(requestKey(id));
  if(!record||!sameBotPrincipal(ctx.principal,record.principal)||![record.requesterBotId,record.targetBotId].includes(ctx.botId))throw new Error('Status request is not authorized');
  return {record,botId:ctx.botId};
 }
 private save(record:StatusRequest):void {this.host.store.setDaemonControl(requestKey(record.id),record);}
 private dispatch(record:StatusRequest):void {
  if(Date.parse(record.deadlineAt)<=this.clock()||record.messageId)return;
  const receipt=enqueueBotMessage(this.host,{principal:record.principal,senderBotId:record.requesterBotId,targetBotId:record.targetBotId,idempotencyKey:`status-request:${record.id}`,message:`[status request ${record.id}] Inspect the current assigned work and existing external execution; do not repeat delivery actions. Reply with bot_status_report requestId=${record.id}, a concise summary and actual observation message IDs. Receipt alone is not fresh status. Deadline: ${record.deadlineAt}. Existing permissions and approvals apply.`});
  record.messageId=receipt.messageId;this.save(record);this.host.store.setDaemonControl(`bot.status-request-message:${receipt.messageId}`,record.id);
 }
 request(sessionId:string,input:RequestInput):Record<string,unknown>{
  const ctx=this.context(sessionId),now=this.clock(),deadlineMs=input.deadlineMs??60000;
  if(!input.idempotencyKey?.trim()||input.idempotencyKey.length>200||!Number.isSafeInteger(deadlineMs)||deadlineMs<1000||deadlineMs>3600000)throw new Error('A bounded idempotency key and deadline are required');
  if(input.targetBotId===ctx.botId)throw new Error('Cannot request status from yourself');
  const hash=createHash('sha256').update(stableJson([botPrincipalKey(ctx.principal),ctx.botId,input.idempotencyKey])).digest('hex'),index=`bot.status-request-key:${hash}`;
  const oldId=this.host.store.getDaemonControl<string>(index);
  if(oldId){const {record}=this.authorized(sessionId,oldId);if(record.targetBotId!==input.targetBotId||record.maxAgeMs!==(input.maxAgeMs??300000)||Date.parse(record.deadlineAt)-Date.parse(record.requestedAt)!==deadlineMs)throw new Error('Idempotency key already used for different request');this.dispatch(record);return this.read(sessionId,record.id);}
  const snapshot=botStatusSnapshots(this.host,ctx.principal,{botIds:[input.targetBotId],activeOnly:false,maxAgeMs:input.maxAgeMs},now)[0];if(!snapshot)throw new Error('Target Bot is not authorized');
  if(!snapshot.stale)return {requestId:null,status:'fresh',snapshot};
  const record:StatusRequest={id:createId('status_request'),principal:ctx.principal,requesterBotId:ctx.botId,targetBotId:input.targetBotId,requestedAt:new Date(now).toISOString(),deadlineAt:new Date(now+deadlineMs).toISOString(),idem:input.idempotencyKey,maxAgeMs:input.maxAgeMs??300000,snapshot};
  this.host.store.transaction(()=>{this.save(record);this.host.store.setDaemonControl(index,record.id);});this.dispatch(record);return this.read(sessionId,record.id);
 }
 read(sessionId:string,id:string):Record<string,unknown>{
  const {record}=this.authorized(sessionId,id),fresh=!!record.observedAt&&Date.parse(record.observedAt)>=Date.parse(record.requestedAt);
  const receipt=record.messageId?this.host.store.db.prepare('SELECT status FROM bot_work_messages WHERE id=?').get(record.messageId):undefined;
  const status=fresh?'replied':this.clock()>=Date.parse(record.deadlineAt)?'no_reply':record.observedAt?'stale':record.reportedAt||receipt?.status==='processed'?'waiting_observation':receipt?.status==='processing'?'received':'queued';
  const snapshot=record.latestSnapshot??record.snapshot;const stale=!record.observedAt||this.clock()-Date.parse(record.observedAt)>record.maxAgeMs;
  return {requestId:record.id,status,stale,snapshot:{...snapshot,stale:!snapshot.observedAt||this.clock()-Date.parse(snapshot.observedAt)>record.maxAgeMs,reportedAt:new Date(this.clock()).toISOString()},messageId:record.messageId??null,requestedAt:record.requestedAt,deadlineAt:record.deadlineAt,reportedAt:record.reportedAt??null,observedAt:record.observedAt??null,summary:record.summary??null,evidenceMessageIds:record.evidenceMessageIds??[],replyMessageId:record.replyMessageId??null,replyDelivery:record.replyMessageId?'accepted':fresh?'pending':'not_applicable',late:!!record.reportedAt&&Date.parse(record.reportedAt)>Date.parse(record.deadlineAt)};
 }
 private evidence(record:StatusRequest,ids:string[]):string|undefined {
  let at:string|undefined;
  for(const id of ids){
   const row=this.host.store.db.prepare("SELECT session_id,created_at,parts_json FROM session_messages WHERE id=? AND role='tool'").get(id);if(!row)throw new Error('Evidence must be an actual tool observation');
   const session=this.host.store.getSession(String(row.session_id));if(!session||session.metadata.botId!==record.targetBotId||!sameBotPrincipal(principalFromSession(this.host.store,session),record.principal))throw new Error('Evidence is not authorized for the target');
   if(!record.snapshot.sessionId||!withinScope(this.host,session,record.snapshot.sessionId,record.principal,record.targetBotId))throw new Error('Evidence is outside the target work scope');
   const observation=statusObservation({createdAt:String(row.created_at),parts:JSON.parse(String(row.parts_json)) as MessagePart[]});
   if(!observation||Date.parse(observation.at)>this.clock()+1000)throw new Error('Evidence has no valid successful observation');
   if(!at||observation.at>at)at=observation.at;
  }
  return at;
 }
 private deliverReply(record:StatusRequest):void {
  if(!record.observedAt||Date.parse(record.observedAt)<Date.parse(record.requestedAt)||record.replyMessageId)return;
  const reply=enqueueBotMessage(this.host,{principal:record.principal,senderBotId:record.targetBotId,targetBotId:record.requesterBotId,replyTo:record.messageId,idempotencyKey:`status-report:${record.id}`,message:`[status report ${record.id}] Observed: ${record.observedAt}. Reported: ${record.reportedAt}. ${record.summary}\nEvidence message IDs: ${JSON.stringify(record.evidenceMessageIds)}. This is a correlated status observation, not completion proof.`});record.replyMessageId=reply.messageId;this.save(record);
 }
 report(sessionId:string,input:ReportInput):Record<string,unknown>{
  const {record,botId}=this.authorized(sessionId,input.requestId);if(botId!==record.targetBotId)throw new Error('Only the target recipient can report');
  const ids=input.evidenceMessageIds??[];if(!Array.isArray(ids)||ids.length>16||ids.some(id=>typeof id!=='string'||id.length>200)||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>1000)throw new Error('A concise summary and at most 16 evidence IDs are required');
  const hash=createHash('sha256').update(stableJson(input)).digest('hex');
  if(record.replyHash){if(record.replyHash!==hash)throw new Error('Request already has a different verified reply');this.deliverReply(record);return this.read(sessionId,record.id);}
  record.observedAt=this.evidence(record,ids);record.reportedAt=new Date(this.clock()).toISOString();record.summary=input.summary;record.evidenceMessageIds=ids;
  if(record.observedAt&&Date.parse(record.observedAt)>=Date.parse(record.requestedAt))record.replyHash=hash;
  record.latestSnapshot=botStatusSnapshots(this.host,record.principal,{botIds:[record.targetBotId],activeOnly:false,maxAgeMs:record.maxAgeMs},this.clock())[0];
  this.save(record);this.deliverReply(record);return this.read(sessionId,record.id);
 }
}
/** Only a host-persisted request binding can expire an unclaimed Bot message. */
export function expireQueuedStatusRequest(host:BotWorkHost,messageId:string):boolean {
 const id=host.store.getDaemonControl<string>(`bot.status-request-message:${messageId}`);
 if(!id)return false;
 const record=host.store.getDaemonControl<StatusRequest>(requestKey(id));
 if(!record||record.messageId!==messageId||Date.parse(record.deadlineAt)>Date.now())return false;
 host.store.db.prepare("UPDATE bot_work_messages SET status='failed',updated_at=? WHERE id=? AND principal=? AND target_bot=? AND status='pending'").run(new Date().toISOString(),messageId,botPrincipalKey(record.principal),record.targetBotId);
 return true;
}
export function createBotStatusRequestTools(host:BotWorkHost):ToolContract<any>[]{
 const service=new BotStatusRequests(host);
 return [
  {name:'bot_request_status',description:'Read a compact authorized snapshot first. If stale, persist one correlated refresh request. Query requestId later to distinguish received, waiting_observation, stale and no_reply. Never equate delivery with fresh status.',inputSchema:{type:'object',properties:{requestId:{type:'string'},targetBotId:{type:'string'},idempotencyKey:{type:'string'},deadlineMs:{type:'integer',minimum:1000,maximum:3600000},maxAgeMs:{type:'number'}}},approvalMode:'never',sideEffectLevel:'none',async execute(ctx,args){try{return {ok:true,content:JSON.stringify(args.requestId?service.read(ctx.session.id,args.requestId):service.request(ctx.session.id,args))};}catch(e){return {ok:false,content:String(e)};}}},
  {name:'bot_status_report',description:'Reply to the exact status request with current observation message IDs and a short summary. Old evidence keeps its original timestamp. An empty evidence list acknowledges receipt only. Never rerun deliveries for a status request.',inputSchema:{type:'object',properties:{requestId:{type:'string'},summary:{type:'string'},evidenceMessageIds:{type:'array',items:{type:'string'}}},required:['requestId','summary']},approvalMode:'never',sideEffectLevel:'none',async execute(ctx,args){try{return {ok:true,content:JSON.stringify(service.report(ctx.session.id,args))};}catch(e){return {ok:false,content:String(e)};}}}
 ];
}
