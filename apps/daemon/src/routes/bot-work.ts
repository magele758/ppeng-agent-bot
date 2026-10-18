import { botTaskPage, botWorkControl, setBotWorkControl, retryBotTask, botWorkSettings, updateBotWorkSettings, botWorkStatus, cancelBotTask, dispatchBotTask, ensureSuperBot, getBotTask, listBotTasks, resolveBotPrincipal, principalFromSession, tickBotWork, ValidationError, type RawAgentRuntime, type BotWorkHost } from '@ppeng/agent-core';
import type { RouteSpec } from '../routing.js';
import { json } from '../http-utils.js';

/** Snapshot actual execution, including room sessions and background tool processes.
 * Persisted task queues and stale running rows never imply live execution. */
function liveBotWork(runtime: RawAgentRuntime, principal: ReturnType<typeof resolveBotPrincipal>, rows: unknown[]) {
 const pending = new Set(runtime.store.listApprovals({status:'pending'}).map(item => item.sessionId));
 const counts = new Map<string, number>();
 const sessions = new Map(runtime.store.listSessions().map(session => [session.id, session]));
 const ownedBot = (id: string, seen = new Set<string>()): string | undefined => {
  if (seen.has(id)) return undefined;
  seen.add(id);
  const session = sessions.get(id);
  if (!session) return undefined;
  const owner = principalFromSession(runtime.store, session);
  if (owner.userId !== principal.userId || (owner.tenantId ?? '') !== (principal.tenantId ?? '')) return undefined;
  if (typeof session.metadata?.botId === 'string') return session.metadata.botId;
  return session.parentSessionId ? ownedBot(session.parentSessionId, seen) : undefined;
 };
 for (const session of sessions.values()) {
  const botId = ownedBot(session.id);
  if (botId && session.status === 'running' && !pending.has(session.id) && runtime.isSessionRunning(session.id)) {
   counts.set(botId, (counts.get(botId) ?? 0) + 1);
  }
 }
 for (const job of runtime.store.listBackgroundJobs()) {
  const botId = ownedBot(job.sessionId);
  if (botId && job.status === 'running' && runtime.isBackgroundJobRunning(job.id)) counts.set(botId, (counts.get(botId) ?? 0) + 1);
 }
 return rows.map(value => {
  const row = value as {bot:{id:string}; control:{paused?:boolean;disabled?:boolean}};
  return {...row, activeWorkCount: row.control.paused || row.control.disabled ? 0 : counts.get(row.bot.id) ?? 0};
 });
}

export function botWorkRoutes(runtime:RawAgentRuntime):RouteSpec[] {
 const host:BotWorkHost={store:runtime.store,runSession:id=>runtime.runSession(id),cancelSession:id=>runtime.cancelSession(id),isSessionRunning:id=>runtime.isSessionRunning(id),hasUnconfirmedEffects:(id,since)=>runtime.hasUnconfirmedEffects(id,since),log:{debug(){},info(){},warn(){},error(){}}};
 return [
 {method:'GET',pattern:'/api/bot-work/bots/:id/control',handler:({auth,requireParam,response})=>{const principal=resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined);const visible=botWorkStatus(host,principal) as {bot:{id:string}}[];if(!visible.some(item=>item.bot.id===requireParam('id')))throw new ValidationError('Bot not found');json(response,200,{control:botWorkControl(runtime.store,principal,requireParam('id'))});}},
 {method:'POST',pattern:'/api/bot-work/bots/:id/control',handler:async({auth,requireParam,readBody,response})=>{const principal=resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined);const control=setBotWorkControl(host,principal,requireParam('id'),await readBody() as {paused:boolean;disabled:boolean});json(response,200,{control});}},
 {method:'GET',pattern:'/api/bot-work/settings',handler:({response})=>{json(response,200,{settings:botWorkSettings(runtime.store)});}},
 {method:'POST',pattern:'/api/bot-work/settings',handler:async({readBody,response})=>{const body=await readBody() as {perBot:number;perPrincipal:number};json(response,200,{settings:updateBotWorkSettings(runtime.store,body)});}},
 {method:'GET',pattern:'/api/bot-work/default',handler:({auth,response})=>{const principal=resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined);const opened=ensureSuperBot(host,principal);json(response,200,{...opened,session:runtime.getSession(opened.sessionId)});}},
 {method:'GET',pattern:'/api/bot-work/status',handler:({auth,response})=>{const principal=resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined);response.setHeader('cache-control','no-store');json(response,200,{bots:liveBotWork(runtime,principal,botWorkStatus(host,principal))});}},
 {method:'GET',pattern:'/api/bot-work/tasks',handler:({auth,response,url})=>{json(response,200,botTaskPage(runtime.store,resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined),{cursor:url.searchParams.get('cursor')??undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined}));}},
 {method:'POST',pattern:'/api/bot-work/tasks',handler:async({auth,readBody,response})=>{const body=await readBody() as Record<string,unknown>;const principal=resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined);const superBot=ensureSuperBot(host,principal);const task=dispatchBotTask(host,{principal,requesterBotId:typeof body.requesterBotId==='string'?body.requesterBotId:superBot.bot.id,targetBotId:String(body.targetBotId??''),input:String(body.input??''),idempotencyKey:typeof body.idempotencyKey==='string'?body.idempotencyKey:undefined,deadline:typeof body.deadline==='string'?body.deadline:undefined});void tickBotWork(host);json(response,202,{task});}},
 {method:'GET',pattern:'/api/bot-work/tasks/:id',handler:({auth,requireParam,response})=>{const task=getBotTask(runtime.store,resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined),requireParam('id'));if(!task)throw new ValidationError('Task not found');json(response,200,{task});}},
 {method:'POST',pattern:'/api/bot-work/tasks/:id/retry',handler:async({auth,requireParam,readBody,response})=>{const body=await readBody() as {confirmUnknown?:boolean};const task=retryBotTask(host,resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined),requireParam('id'),body.confirmUnknown===true);void tickBotWork(host);json(response,202,{task});}},
 {method:'POST',pattern:'/api/bot-work/tasks/:id/cancel',handler:({auth,requireParam,response})=>{const task=cancelBotTask(host,resolveBotPrincipal(runtime.store,auth.user?{userId:auth.user.id,tenantId:auth.user.tenantId}:undefined),requireParam('id'));json(response,200,{task});}}
 ];
}
