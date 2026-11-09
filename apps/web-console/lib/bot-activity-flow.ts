export interface FlowStep {
  id:string; bot:string; raw:string; state:string; parent?:string; session?:string;
  report?:string; cost?:number; tokens?:number; label?:string;
}
export interface Flow {
  id:string; kind:'task'|'room'|'routine'|'chat'; title:string; at:string; steps:FlowStep[];
  cost?:number; calls?:number; seconds?:number;
}
export interface Task {
  id:string; input:string; status:string; requesterBotId:string; targetBotId:string; parentTaskId?:string;
  createdAt?:string; updatedAt?:string; result?:string; failureReason?:string;
  delivery?:{sessionId?:string;report?:string;costUsd?:number|null};
}
export interface RoomTurn {
  id:string; status:string; updatedAt?:string; botIds?:string[]; costUsd?:number; costStatus?:string; toolCalls?:number;
  members?:{botId:string;sessionId?:string;status:string}[];
}
export interface RoomMessage {turnId?:string;sender?:{id?:string};text?:string}
export interface Routine {
  id:string;status:string;mainSessionId?:string;sessionId?:string;error?:string;result?:string;
  startedAt?:string;finishedAt?:string;updatedAt?:string; job?:{name:string;metadata?:{sourceDelivery?:{taskId:string;attempt:number}}};
}
function reportedState(raw:string, report='') {
  if(raw==='completed' && /(?:^|[\n。])\s*(?:\*\*)?(?:阻塞[。：“：]|受阻[。：“：]|blocked\b)/im.test(report)) return 'reportedBlocked';
  return raw;
}
export function routineStep(run:Routine,bot:string):FlowStep {
  return {id:run.id,bot,state:reportedState(run.status,run.result),raw:run.status,
    report:run.error??run.result,session:run.sessionId??run.mainSessionId};
}
export function taskSteps(tasks:Task[]):FlowStep[] {
  const ids=new Set(tasks.map(task=>task.id));
  return tasks.map(task=>({id:task.id,bot:task.targetBotId,raw:task.status,state:task.status,
    parent:ids.has(task.parentTaskId!)?task.parentTaskId:undefined,session:task.delivery?.sessionId,
    label:task.input,report:task.failureReason??task.delivery?.report??task.result,cost:task.delivery?.costUsd??undefined}));
}
export function roomSteps(turn:RoomTurn,messages:RoomMessage[]):FlowStep[] {
  const members=turn.members??(turn.botIds??[]).map(botId=>({botId,status:turn.status,sessionId:undefined}));
  return members.map(member=>({id:turn.id+'/'+member.botId,bot:member.botId,session:member.sessionId,
    state:member.status,raw:member.status,report:messages.find(m=>m.turnId===turn.id && m.sender?.id===member.botId)?.text}));
}

interface Part {type:string;text?:string;name?:string;toolCallId?:string;ok?:boolean;content?:string}
export interface ChatRecord {id:string;seq:number;role:string;parts:Part[];createdAt:string;key?:string}
function childSession(part:Part):string|undefined {
  if(!['spawn_subagent','spawn_teammate','delegate_task'].includes(part.name??''))return;
  try {
    const id=JSON.parse(part.content??'{}').childSessionId;
    return typeof id==='string' && /^session_[a-zA-Z0-9_-]+$/.test(id)?id:undefined;
  } catch {return;}
}
/** Only pair calls recorded after a visible user boundary; earlier partial history is omitted. */
export function chatFlows(messages:ChatRecord[],bot:string,session:string):Flow[] {
  const flows:Flow[]=[];
  let active:Flow|undefined;
  let calls=new Map<string,FlowStep>();
  for(const m of [...messages].sort((a,b)=>a.seq-b.seq)){
    if(m.role==='user'){
      const title=m.parts.find(p=>p.type==='text')?.text?.trim();
      active=title?{id:m.id,title:title.slice(0,140),kind:'chat',at:m.createdAt,steps:[]}:undefined;
      if(active)flows.push(active);
      calls=new Map();
      continue;
    }
    if(!active)continue;
    for(const p of m.parts){
      if(!p.toolCallId)continue;
      if(m.role==='assistant' && p.type==='tool_call'){
        const step={id:p.toolCallId,bot,session,raw:'requested',state:'requested',label:p.name};
        calls.set(step.id,step);active.steps.push(step);
      }
      if(m.role==='tool' && p.type==='tool_result'){
        const step=calls.get(p.toolCallId);if(!step)continue;
        step.raw=step.state=p.ok===true?'done':'failed';
        step.report=p.content?.slice(0,600);step.session=childSession(p)??session;
      }
    }
    active.at=m.createdAt;
  }
  return flows.filter(f=>f.steps.length>0);
}

export interface SessionNode {
  id:string;agentId:string;title:string;parentSessionId?:string;status:string;updatedAt:string;
  metadata?:{usageCostUsd?:number;usageTotals?:{totalTokens?:number}};
}
/** Native session parent pointers also cover historical tool reports without a child ID. */
export function sessionFlow(root:SessionNode,descendants:SessionNode[],bot:string):Flow[] {
  if(!descendants.length)return [];
  const rows=[root,...descendants];
  const steps=rows.map(s=>({id:s.id,session:s.id,parent:s.id===root.id?undefined:s.parentSessionId,bot:s.id===root.id?bot:s.agentId,
    label:s.title,raw:s.status,state:s.status,cost:s.metadata?.usageCostUsd,tokens:s.metadata?.usageTotals?.totalTokens}));
  return [{id:'team/'+root.id,title:root.title,kind:'chat',at:rows.map(s=>s.updatedAt).sort().at(-1)!,steps}];
}
