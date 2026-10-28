import type {SqliteStateStore} from '../storage.js';
import {botPrincipalKey,principalFromSession} from '../bots/bot-identity.js';
import {getBotTask} from '../bots/bot-work.js';
import type {Observation,WaitSource} from './types.js';
const registries=new WeakMap<SqliteStateStore,Map<string,WaitSource>>();
const denied=():Observation=>({availability:'unauthorized',reason:'Resource is not authorized for this execution'});
const unavailable=():Observation=>({availability:'unavailable',reason:'Resource is unavailable'});
function builtins():Map<string,WaitSource>{return new Map([
 ['session',{fields:['status','version'],observe({store,owner,scope},ref){
  const target=store.getSession(ref);if(!target)return unavailable();
  if(ref===owner.sessionId||botPrincipalKey(principalFromSession(store,target))!==botPrincipalKey(principalFromSession(store,scope))||target.metadata.botId!==scope.metadata.botId)return denied();
  const seen=new Set<string>();let ancestor=target.parentSessionId;
  while(ancestor&&ancestor!==scope.id&&!seen.has(ancestor)){seen.add(ancestor);ancestor=store.getSession(ancestor)?.parentSessionId;}
  if(ancestor!==scope.id)return denied();
  const outcome=target.metadata.outcome as {kind?:string;reason?:string}|undefined;
  const status=target.status==='idle'&&(outcome?.kind==='completed'||outcome?.kind==='idle'&&outcome.reason==='end')?'completed':outcome?.kind==='aborted'?'cancelled':target.status;
  return {availability:'available',facts:{status,version:target.updatedAt}};
 }}],
 ['bot_task',{fields:['status','attempt','version'],observe({store,scope},ref){
  const task=getBotTask(store,principalFromSession(store,scope),ref);
  if(!task||task.requesterBotId!==scope.metadata.botId)return denied();
  return {availability:'available',facts:{status:task.status,attempt:task.attempt,version:task.updatedAt}};
 }}],
 ['routine_run',{fields:['status','attempt','version'],observe({store,scope,owner},ref){
  if(owner.kind==='routine'&&owner.id===ref)return denied();
  const row=store.db.prepare('SELECT payload FROM bot_routine_runs WHERE id=?').get(ref);
  if(!row)return unavailable();const run=JSON.parse(String(row.payload));
  if(run.mainSessionId!==scope.id)return denied();
  return {availability:'available',facts:{status:run.status,attempt:run.attempt,version:run.updatedAt}};
 }}]
]);}
export function waitSources(store:SqliteStateStore):Map<string,WaitSource>{let registry=registries.get(store);if(!registry){registry=builtins();registries.set(store,registry);}return registry;}
/** Registration is a trusted host capability, never a tool exposed to model input. */
export function registerWaitSource(store:SqliteStateStore,name:string,source:WaitSource):()=>void {
 if(!/^[a-z][a-z0-9_]{0,63}$/.test(name)||waitSources(store).has(name)||!source.fields.length)throw new Error('Invalid or duplicate wait source');
 waitSources(store).set(name,source);return ()=>{if(waitSources(store).get(name)===source)waitSources(store).delete(name);};
}
