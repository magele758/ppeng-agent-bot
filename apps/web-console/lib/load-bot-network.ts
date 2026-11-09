import {api} from './api';
import type {Observation} from './network-observations';
import type {Task,RoomTurn} from './bot-activity-flow';

interface Room {id:string; title:string}
async function read<T>(path:string,signal:AbortSignal):Promise<T>{
  return await api('/api/'+path,{signal}) as T;
}
function pickAt(task:Task){return task.updatedAt??task.createdAt??'';}
function pickReport(task:Task){return task.failureReason??task.delivery?.report??task.result;}
function taskToObservation(task:Task){
  return {
    id:task.id,from:task.requesterBotId,to:task.targetBotId,title:task.input,state:task.status,
    at:pickAt(task),session:task.delivery?.sessionId,
    report:pickReport(task),cost:task.delivery?.costUsd??undefined
  };
}
async function delegates(signal:AbortSignal){
  const data=await read<{tasks:Task[];collaborations:{members:Task[]}[]}>('bot-work/tasks?limit=100',signal);
  return [...data.tasks,...data.collaborations.flatMap(c=>c.members)].map(taskToObservation);
}
async function participants(room:Room,signal:AbortSignal):Promise<Observation[]>{
  const data=await read<{turns:RoomTurn[]}>('bot-rooms/'+encodeURIComponent(room.id)+'/turns',signal);
  return data.turns.flatMap(turn=>(turn.members??[]).map(member=>({
    id:turn.id+'/'+member.botId,from:room.id,to:member.botId,title:room.title,
    state:member.status,session:member.sessionId,at:turn.updatedAt??''
  })));
}
async function rooms(signal:AbortSignal){
  const {rooms}=await read<{rooms:Room[]}>('bot-rooms',signal);
  const reads=await Promise.allSettled(rooms.map(room=>participants(room,signal)));
  return {rooms,records:reads.flatMap(r=>r.status==='fulfilled'?r.value:[]),partial:reads.some(r=>r.status==='rejected')};
}
export async function loadBotNetwork(signal:AbortSignal){
  const [work,groups]=await Promise.allSettled([delegates(signal),rooms(signal)]);
  const group=groups.status==='fulfilled'?groups.value:{rooms:[],records:[],partial:true};
  const tasks=work.status==='fulfilled'?work.value:[];
  return {rooms:group.rooms,records:[...tasks,...group.records],partial:group.partial||work.status==='rejected'};
}
