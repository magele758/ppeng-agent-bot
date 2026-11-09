import { api } from './api';
import { chatFlows, type ChatRecord, taskSteps, roomSteps, routineStep, type FlowStep, type Flow, type Task, type Routine, type RoomTurn, type RoomMessage } from './bot-activity-flow';
interface Collaboration { id:string;goal:string;members:Task[] }
interface Room { id:string;title:string;botIds:string[] }
interface Job { id:string;name:string;metadata?:{botId?:string};agentId:string }
async function get<T>(path:string,signal:AbortSignal):Promise<T> {return await api('/api/'+path,{signal}) as T;}
function taskFlows(data:{collaborations:Collaboration[];tasks:Task[]},bot:string):Flow[] {
  const grouped=new Set<string>();
  const rows:Flow[]=[];
  function add(id:string,title:string,members:Task[]){
    if(!members.some(t=>t.targetBotId===bot || t.requesterBotId===bot))return;
    const at=members.map(t=>t.updatedAt??t.createdAt??'').sort().at(-1)??'';
    rows.push({id,kind:'task',title,at,steps:taskSteps(members)});
  }
  for(const group of data.collaborations){group.members.forEach(t=>grouped.add(t.id));add(group.id,group.goal,group.members);}
  for(const task of data.tasks)if(!grouped.has(task.id))add(task.id,task.input,[task]);
  return rows;
}
async function fromRoom(room:Room,bot:string,signal:AbortSignal):Promise<Flow[]> {
  const base='bot-rooms/'+encodeURIComponent(room.id);
  const [turns,messages]=await Promise.all([get<{turns:RoomTurn[]}>(base+'/turns',signal),get<{messages:RoomMessage[]}>(base+'/messages?limit=50',signal)]);
  return turns.turns.map(turn=>({id:turn.id,kind:'room' as const,title:room.title,at:turn.updatedAt??'',
    steps:roomSteps(turn,messages.messages),cost:turn.costStatus==='estimated'?turn.costUsd:undefined,calls:turn.toolCalls}))
    .filter(flow=>flow.steps.some(step=>step.bot===bot));
}
function duration(run:Routine){
  if(!run.startedAt||!run.finishedAt)return undefined;
  return Math.max(0,Math.round((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000));
}
function routineSteps(run:Routine,bot:string,name:string):FlowStep[] {
  const step=routineStep(run,bot);
  const source=run.job?.metadata?.sourceDelivery;
  if(!source)return [step];
  return [{id:source.taskId,bot,raw:'completed',state:'done',label:source.taskId},{...step,parent:source.taskId,label:name}];
}
async function fromJob(job:Job,bot:string,signal:AbortSignal):Promise<Flow[]> {
  const data=await get<{runs:Routine[]}>('cron/jobs/'+encodeURIComponent(job.id)+'/runs',signal);
  return data.runs.map(run=>({id:run.id,kind:'routine',title:job.name,at:run.updatedAt??'',steps:routineSteps(run,bot,job.name),seconds:duration(run)}));
}
export async function loadBotFlows(bot:string,session:string,signal:AbortSignal) {
  const tasks=get<{collaborations:Collaboration[];tasks:Task[]}>('bot-work/tasks?limit=100',signal).then(d=>taskFlows(d,bot));
  const jobs=get<{jobs:Job[]}>('cron/jobs?botId='+encodeURIComponent(bot),signal).then(d=>Promise.all(d.jobs.map(j=>fromJob(j,bot,signal))).then(a=>a.flat()));
  const rooms=get<{rooms:Room[]}>('bot-rooms',signal).then(d=>Promise.all(d.rooms.filter(r=>r.botIds.includes(bot)).map(r=>fromRoom(r,bot,signal))).then(a=>a.flat()));
  const chats=get<{messages:ChatRecord[]}>('sessions/'+encodeURIComponent(session)+'/history?limit=100',signal).then(d=>chatFlows(d.messages,bot,session));
  const reads=await Promise.allSettled([tasks,jobs,rooms,chats]);
  const flows=reads.flatMap(r=>r.status==='fulfilled'?r.value:[]).sort((a,b)=>b.at.localeCompare(a.at));
  return {flows,partial:reads.some(r=>r.status==='rejected')};
}
