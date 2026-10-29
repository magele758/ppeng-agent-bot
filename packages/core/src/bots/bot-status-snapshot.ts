import type {SqliteStateStore} from '../storage.js';
import {BotGoalService} from './goals/service.js';
import {principalFromSession,sameBotPrincipal,type BotPrincipal} from './bot-identity.js';
import {botWorkStatus,type BotWorkHost,type BotTask} from './bot-work.js';
import type {SessionRecord,MessagePart} from '../types.js';
import {statusObservation} from './status-observation.js';
export interface BotStatusOptions {botIds?:string[];activeOnly?:boolean;changedSince?:string;maxAgeMs?:number}
interface AuthorizedStatus {bot:{id:string;name:string};control:{paused?:boolean;disabled?:boolean};sessionId:string|null;status:string;pending:number;taskCounts:Record<string,number>;tasks:BotTask[]}
const clip=(value:unknown,size=240)=>String(value??'').slice(0,size);
export interface BotStatusSnapshot {botId:string;name:string;sessionId:string|null;sessionStatus:string;workStage:string;externalWorkerStatus:string;observedAt:string|null;reportedAt:string;evidenceRef:Record<string,unknown>|null;stale:boolean;updatedAt:string;blocker:string|null;nextAction:string|null;pending:number;taskCounts:Record<string,number>;goals:{id:string;title:string;status:string;progress:string}[];externalWorkers:{id:string;status:string;startedAt:string;updatedAt:string}[]}
function ownedSessions(store:SqliteStateStore,root:SessionRecord):SessionRecord[]{
 const all=store.listSessions(),owned=[root],seen=new Set([root.id]),principal=principalFromSession(store,root);
 for(let depth=0;depth<32;depth++){
  const next=all.filter(s=>!seen.has(s.id)&&!!s.parentSessionId&&seen.has(s.parentSessionId)&&s.metadata.botId===root.metadata.botId&&sameBotPrincipal(principalFromSession(store,s),principal));
  if(!next.length)break;for(const session of next){seen.add(session.id);owned.push(session);}
 }
 return owned;
}
function latestToolObservation(store:SqliteStateStore,sessions:SessionRecord[]):{at:string;ref:Record<string,unknown>}|undefined {
 let latest:{at:string;ref:Record<string,unknown>}|undefined;
 const query=store.db.prepare("SELECT id,created_at,parts_json FROM session_messages WHERE session_id=? AND role='tool' ORDER BY seq DESC LIMIT 40");
 const bounded=sessions.length?[sessions[0]!,...sessions.slice(1).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,24)]:[];
 for(const session of bounded)for(const row of query.all(session.id)){
  const observed=statusObservation({parts:JSON.parse(String(row.parts_json)) as MessagePart[],createdAt:String(row.created_at)});
  if(observed&&(!latest||observed.at>latest.at))latest={at:observed.at,ref:{kind:'session_message',sessionId:session.id,messageId:String(row.id)}};
 }
 return latest;
}
function snapshot(store:SqliteStateStore,row:AuthorizedStatus,now:number,maxAgeMs:number):BotStatusSnapshot {
 const root=row.sessionId?store.getSession(row.sessionId):undefined,owned=root?ownedSessions(store,root):[],ids=new Set(owned.map(s=>s.id));
 const goals=root?new BotGoalService(store,Date.now,root.id).list(row.bot.id).filter(g=>!['completed','cancelled','failed'].includes(g.status)):[];
 const allJobs=store.listBackgroundJobs().filter(job=>ids.has(job.sessionId)),activeJobs=allJobs.filter(job=>job.status==='running');
 const jobs=[...activeJobs,...allJobs.filter(job=>job.status!=='running')].slice(0,16);
 let observation=latestToolObservation(store,owned);
 for(const job of jobs)if(!observation||job.updatedAt>observation.at)observation={at:job.updatedAt,ref:{kind:'background_job',jobId:job.id,sessionId:job.sessionId,startedAt:job.createdAt}};
 const at=observation&&Date.parse(observation.at)<=now+1000?observation.at:null;
 const updatedAt=[root?.updatedAt??'',...goals.map(g=>g.updatedAt),...jobs.map(j=>j.updatedAt),observation?.at??''].sort().at(-1)||new Date(0).toISOString();
 return {botId:row.bot.id,name:row.bot.name,sessionId:row.sessionId,sessionStatus:row.status,workStage:goals[0]?.status??(row.tasks.length?'delegated':activeJobs.length?'external_execution':'idle'),externalWorkerStatus:activeJobs.length?'running':jobs.length?jobs[0]!.status:'unknown',observedAt:at,reportedAt:new Date(now).toISOString(),evidenceRef:at?observation!.ref:null,stale:!at||now-Date.parse(at)>maxAgeMs,updatedAt,blocker:clip(goals.find(g=>g.blockedReason)?.blockedReason??(row.status==='waiting_approval'?'waiting_approval':row.control.paused?'paused':row.control.disabled?'disabled':''))||null,nextAction:clip(goals[0]?.nextStep??(activeJobs.length?'Observe the existing external execution; do not relaunch it.':''))||null,pending:row.pending,taskCounts:row.taskCounts,goals:goals.slice(0,8).map(g=>({id:g.id,title:clip(g.title,100),status:g.status,progress:clip(g.progress)})),externalWorkers:jobs.slice(0,8).map(j=>({id:j.id,status:j.status,startedAt:j.createdAt,updatedAt:j.updatedAt}))};
}
export function botStatusSnapshots(host:BotWorkHost,principal:BotPrincipal,options:BotStatusOptions={},now=Date.now()):BotStatusSnapshot[]{
 if(options.botIds!==undefined&&(!Array.isArray(options.botIds)||options.botIds.length>64||options.botIds.some(id=>typeof id!=='string')))throw new Error('botIds must contain at most 64 Bot IDs');
 const since=options.changedSince===undefined?undefined:Date.parse(options.changedSince);if(since!==undefined&&!Number.isFinite(since))throw new Error('Invalid changedSince');
 const maxAge=options.maxAgeMs??300000;if(!Number.isFinite(maxAge)||maxAge<0||maxAge>86400000)throw new Error('maxAgeMs must be 0–86400000');
 return (botWorkStatus(host,principal) as AuthorizedStatus[]).filter(row=>!options.botIds||options.botIds.includes(row.bot.id)).map(row=>snapshot(host.store,row,now,maxAge)).filter(row=>(options.activeOnly===false||row.workStage!=='idle'||row.pending>0)&&(since===undefined||Date.parse(row.updatedAt)>since)).slice(0,64);
}
export function compactTask(task:BotTask):Record<string,unknown>{return {id:task.id,requesterBotId:task.requesterBotId,targetBotId:task.targetBotId,status:task.status,attempt:task.attempt,input:clip(task.input),result:clip(task.result,600),failureReason:clip(task.failureReason),hasFullResult:!!task.result&&task.result.length>600,updatedAt:task.updatedAt};}

export function compactTaskPage(page:{tasks:BotTask[];activeTasks:BotTask[];historyTasks:BotTask[];hasMore:boolean;nextCursor:string|null;counts:Record<string,number>}):Record<string,unknown>{
 const {tasks:_all,activeTasks,historyTasks,...rest}=page,active=activeTasks.slice(0,25);
 const selected=[...new Map([...active,...historyTasks].map(task=>[task.id,task])).values()];
 return {...rest,tasks:selected.map(compactTask),activeTaskIds:active.map(task=>task.id),historyTaskIds:historyTasks.map(task=>task.id),omittedActiveTasks:Math.max(0,activeTasks.length-active.length)};
}
