import type {SqliteStateStore} from '../storage.js';
import type {SessionRecord,ToolContract} from '../types.js';
import {goalScope} from '../bots/goals/runtime-host.js';
import {RoutineRunStore} from '../cron/routine-runtime.js';
import {DurableWaitStore} from './store.js';
import {waitSources} from './sources.js';
import {waitConditionSchema} from './conditions.js';
import type {WaitOwner,WaitSpec} from './types.js';
export function activeWaitOwner(store:SqliteStateStore,session:SessionRecord):WaitOwner|undefined {
 const runs=new RoutineRunStore(store).pending().filter(r=>r.sessionId===session.id&&r.status==='running');
 if(runs.length===1){const run=runs[0]!;return {kind:'routine',id:run.id,revision:run.attempt,sessionId:session.id,scopeSessionId:run.mainSessionId};}
 if(runs.length||session.metadata.botWorkTaskId||session.metadata.botGoalWorker)return undefined;
 const scope=goalScope(store,session);const id=session.metadata.botGoalId,executionId=session.metadata.botGoalExecutionId;
 if(!scope||typeof id!=='string'||typeof executionId!=='string')return undefined;
 const goal=scope.service.get(scope.botId,id),execution=scope.service.executions(scope.botId,id).find(e=>e.id===executionId);
 if(!goal||!execution||goal.status!=='running'||goal.activeExecutionId!==execution.id||execution.status!=='running'||execution.sessionId!==session.id||execution.goalRevision!==goal.revision||execution.leaseUntil<=Date.now())return undefined;
 return {kind:'goal',id,revision:goal.revision,executionId,botId:scope.botId,sessionId:session.id,scopeSessionId:scope.sessionId};
}
export function createWaitForTool(store:SqliteStateStore):ToolContract {
 return {name:'wait_for',get description(){return 'Suspend the current Goal or Routine until an observable condition matches. Use instead of cron/sleep/repeated history queries when waiting for an existing execution. Sources: session (owned descendant), bot_task (requested by this Bot), routine_run (owned occurrence), or host-registered adapters. All expose status/version; bot_task and routine_run also expose attempt. Conditions support eq/ne/in/gte/lte/changed/all/any. Unknown is never completion. Registration closes this tool turn; the runtime resumes with new evidence. Only one wait per active execution. Use alone in a tool round. Registered fields: '+JSON.stringify(Object.fromEntries([...waitSources(store)].map(([name,adapter])=>[name,adapter.fields])));},approvalMode:'never',sideEffectLevel:'none',inputSchema:{type:'object',properties:{source:{type:'string'},ref:{type:'string'},condition:waitConditionSchema,summary:{type:'string'},deadline:{type:'number',description:'Optional absolute Unix milliseconds'},maxChecks:{type:'integer',minimum:1}},required:['source','ref','condition','summary'],additionalProperties:false},async execute(ctx,args){
  try{return store.transaction(()=>{
   const loop=store.getDaemonControl<{kernelVariant?:string;engineEnabled?:boolean}>('loop_settings');
   if(loop?.engineEnabled!==false&&loop?.kernelVariant==='ppeng')throw new Error('Durable waits require the agent-loop kernel; select it in Lab loop settings');
   const session=store.getSession(ctx.session.id);if(!session)throw new Error('Session unavailable');
   const owner=activeWaitOwner(store,session);if(!owner)throw new Error('No active owned Goal or Routine execution');
   if(typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>4000)throw new Error('A concise continuation checkpoint is required');
   const {source,ref,condition,deadline,maxChecks}=args;
   const wait=new DurableWaitStore(store).register(owner,{source,ref,condition,deadline,maxChecks} as WaitSpec);
   const checkpoint={kind:'waiting',summary:args.summary,wait:{source:'durable_wait',correlationId:wait.id}};
   store.updateSession(session.id,{metadata:{...session.metadata,agentWaitId:wait.id,...(owner.kind==='goal'?{botGoalCheckpoint:checkpoint}:{})}});
   if(owner.kind==='routine')new RoutineRunStore(store).update(owner.id,{waitId:wait.id,waitCheckpoint:args.summary});
   return {ok:true,content:JSON.stringify({status:'waiting',waitId:wait.id,checkpoint:args.summary})};
  });}catch(error){return {ok:false,content:error instanceof Error?error.message:String(error)};}
 }};
}
