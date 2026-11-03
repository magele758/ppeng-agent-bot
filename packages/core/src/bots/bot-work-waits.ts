import type {SqliteStateStore} from '../storage.js';
import type {SessionRecord} from '../types.js';
import type {WaitOwner} from '../waits/types.js';

type ResumeHost = {store:SqliteStateStore;runSession(id:string):Promise<unknown>;isSessionRunning?(id:string):boolean};

/** One processing task message for this chat. Revision is that task attempt. */
export function botWorkWaitOwner(store:SqliteStateStore,session:SessionRecord):WaitOwner|undefined {
 const taskId=session.metadata.botWorkTaskId;
 if(typeof taskId!=='string'||!taskId)return undefined;
 let rows:{id:string}[];
 try{rows=store.db.prepare("SELECT id FROM bot_work_messages WHERE session_id=? AND task_id=? AND kind='task' AND status='processing'").all(session.id,taskId) as {id:string}[];}
 catch{return undefined;}
 if(rows.length!==1)return undefined;
 const task=store.db.prepare('SELECT attempt FROM bot_work_tasks WHERE id=?').get(taskId) as {attempt?:unknown}|undefined;
 if(!task||typeof task.attempt!=='number')return undefined;
 const noted=session.metadata.botWorkTaskAttempt;
 if(typeof noted==='number'&&noted!==task.attempt)return undefined;
 const botId=session.metadata.botId;
 return {kind:'bot_work',id:taskId,revision:task.attempt,sessionId:session.id,scopeSessionId:session.id,...(typeof botId==='string'?{botId}:{})};
}

/** Missing or unfinished wait is not a completed task. */
export function botWorkDurableWaitHolding(store:SqliteStateStore,session:SessionRecord):boolean {
 const flag=session.metadata.botWorkDurableWait;
 if(typeof flag!=='string'||!flag)return false;
 try{
  const row=store.db.prepare('SELECT payload FROM agent_waits WHERE id=?').get(flag) as {payload?:string}|undefined;
  if(!row?.payload)return true;
  const status=JSON.parse(String(row.payload))?.status;
  return status!=='consumed'&&status!=='expired'&&status!=='cancelled';
 }catch{return true;}
}

export async function resumeParkedBotWork(host:ResumeHost):Promise<void> {
 const {DurableWaitStore}=await import('../waits/store.js');
 let rows:{id:string}[];
 try{rows=host.store.db.prepare("SELECT id FROM sessions WHERE json_type(metadata_json,'$.botWorkDurableWait')='text'").all() as {id:string}[];}
 catch{return;}
 for(const row of rows){
  const session=host.store.getSession(row.id);
  const waitId=session?.metadata.botWorkDurableWait;
  if(!session||host.isSessionRunning?.(session.id)||typeof waitId!=='string'||!waitId)continue;
  if(session.status==='running'&&host.store.isSessionWriterLive(session.id))continue;
  const waits=new DurableWaitStore(host.store);
  let wait;
  try{wait=waits.check(waitId);}catch{continue;}
  if(wait.status!=='ready')continue;
  if(wait.owner.kind!=='bot_work'||wait.owner.sessionId!==session.id)continue;
  const taskId=session.metadata.botWorkTaskId;
  if(typeof taskId!=='string'||taskId!==wait.owner.id)continue;
  const task=host.store.db.prepare('SELECT attempt,status FROM bot_work_tasks WHERE id=?').get(taskId) as {attempt?:unknown;status?:unknown}|undefined;
  if(!task||task.status!=='running'||task.attempt!==wait.owner.revision)continue;
  const processing=host.store.db.prepare("SELECT 1 FROM bot_work_messages WHERE session_id=? AND task_id=? AND kind='task' AND status='processing' LIMIT 1").get(session.id,taskId);
  if(!processing)continue;
  const resumed=waits.consume(waitId,current=>{
   host.store.appendMessage(session.id,'user',[{type:'text',text:'[wait resumed] '+JSON.stringify({source:current.spec.source,ref:current.spec.ref,observation:current.observation})}]);
   const fresh=host.store.getSession(session.id);if(!fresh)return;
   const metadata={...fresh.metadata};
   delete metadata.botWorkDurableWait;
   delete metadata.agentWaitId;
   host.store.updateSession(session.id,{status:'idle',metadata});
  });
  if(resumed)await host.runSession(session.id);
 }
}
