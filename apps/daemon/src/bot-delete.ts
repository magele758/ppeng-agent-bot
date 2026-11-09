import { BotFunctionalGroupService, RoutineRunStore, ValidationError, type RawAgentRuntime } from '@ppeng/agent-core';

type Session = ReturnType<RawAgentRuntime['store']['listSessions']>[number];
type Room = ReturnType<RawAgentRuntime['rooms']['list']>[number];
type Run = ReturnType<RoutineRunStore['pending']>[number];

function assertStopped(runtime:RawAgentRuntime, sessions:Session[], pending:Run[]):void {
  const ids=new Set(sessions.map(s=>s.id));
  const runningSession=sessions.some(s=>s.status==='running');
  const runningRoutine=pending.some(r=>['running','unknown'].includes(r.status));
  const background=runtime.store.listBackgroundJobs().some(j=>ids.has(j.sessionId) && j.status==='running');
  if([runningSession,runningRoutine,background].includes(true)) throw new ValidationError('Bot has running or unresolved work. Stop its tasks before deleting.');
}

function preserveSessions(runtime:RawAgentRuntime,sessions:Session[]):void {
  for(const session of sessions) {
    runtime.mergeSessionMetadata(session.id,{autonomous:false});
    for(const approval of runtime.store.listApprovals({status:'pending'}).filter(a=>a.sessionId===session.id)) runtime.store.updateApproval(approval.id,'rejected');
    if(session.status==='waiting_approval') runtime.store.updateSession(session.id,{status:'failed'});
  }
}

function detachRooms(runtime:RawAgentRuntime,id:string,rooms:Room[]):void {
  for(const room of rooms) {
    room.botIds=room.botIds.filter(member=>member!==id);
    if(room.hostBotId===id) room.hostBotId=room.botIds[0] ?? '';
    if(room.botIds.length<2) room.status='paused';
    runtime.store.db.prepare('UPDATE bot_rooms SET data=? WHERE id=?').run(JSON.stringify(room),room.id);
  }
}
function affectedRooms(runtime:RawAgentRuntime,id:string):Room[] {
  const rooms=runtime.store.db.prepare('SELECT data FROM bot_rooms').all().map(row=>JSON.parse(String(row.data)) as Room).filter(room=>room.botIds.includes(id));
  for(const room of rooms) {
    const active=runtime.store.db.prepare("SELECT 1 FROM bot_room_turns WHERE room_id=? AND status IN ('queued','running','waiting_approval') LIMIT 1").get(room.id);
    if(active) throw new ValidationError('Bot belongs to a running group chat. Stop the group task before deleting.');
  }
  return rooms;
}

function removeDefinition(runtime:RawAgentRuntime,id:string,sessions:Session[],pending:Run[],runs:RoutineRunStore,rooms:Room[]):void {
  runtime.store.transaction(() => {
    for(const run of pending) runs.update(run.id,{status:'cancelled',notificationSent:true,finishedAt:new Date().toISOString()});
    preserveSessions(runtime,sessions);
    detachRooms(runtime,id,rooms);
    runtime.store.db.prepare('DELETE FROM bot_functional_members WHERE bot_id=?').run(id);
    runtime.store.updateBot(id,{hidden:true});
    runtime.store.db.prepare('DELETE FROM bots WHERE id=?').run(id);
  });
}

export function prepareBotDeletion(runtime:RawAgentRuntime,id:string) {
  const bot=runtime.getBot(id);
  const sessions=runtime.store.listSessions().filter(s=>s.metadata.botId===id || s.id===bot.canonicalSessionId);
  const ids=new Set(sessions.map(s=>s.id));
  const runs=new RoutineRunStore(runtime.store);
  const pending=runs.pending().filter(r=>r.job.metadata.botId===id || ids.has(r.mainSessionId));
  assertStopped(runtime,sessions,pending);
  affectedRooms(runtime,id);
  new BotFunctionalGroupService(runtime.store);
  const jobs=runtime.listCronJobs().filter(j=>j.metadata.botId===id || ids.has(j.sessionId));
  return () => {
    for(const job of jobs) runtime.deleteCronJob(job.id);
    // Another member of the same room may already have been removed in this batch.
    removeDefinition(runtime,id,sessions,pending,runs,affectedRooms(runtime,id));
  };
}

export function deleteBotPreservingHistory(runtime:RawAgentRuntime,id:string):void {
  runtime.store.transaction(() => prepareBotDeletion(runtime,id)());
}
