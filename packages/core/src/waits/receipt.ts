import type {SqliteStateStore} from '../storage.js';
/** A registered wait is not a safe continuation checkpoint until its tool wave is closed. */
export function hasWaitReceipt(store:SqliteStateStore,sessionId:string,waitId:string):boolean {
 const calls=new Map<string,string>();let matched=false;
 for(const message of store.foldMessages(sessionId))for(const part of message.parts){
  if(part.type==='tool_call')calls.set(part.toolCallId,part.name);
  if(part.type==='tool_result'){
   const paired=calls.get(part.toolCallId)===part.name;calls.delete(part.toolCallId);
   if(paired&&part.name==='wait_for'&&part.ok){try{if(JSON.parse(part.content).waitId===waitId)matched=true;}catch{/* Malformed results cannot authorize recovery. */}}
  }
 }
 return matched&&calls.size===0;
}
