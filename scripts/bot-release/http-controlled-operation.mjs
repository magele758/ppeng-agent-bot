/** A Room oracle must follow the explicit trigger, never a historical member reply. */
export function controlledOperation(messages,durableKind){
 if(durableKind==='result')return undefined;
 const latest=[...messages].reverse().find(message=>message.role==='user');
 const text=(latest?.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 const trigger=text.match(/^Trigger: (.+)$/m);
 if(trigger){const content=JSON.parse(trigger[1]);return String(content.text??'').match(/http_op_\d+/)?.[0];}
 return text.match(/http_op_\d+/)?.[0];
}
function controlledToolDone(messages,operation,sessionId){
 const id='controlled_'+operation+':'+sessionId,key=operation+':'+sessionId;
 return messages.some(message=>(message.parts??[]).some(part=>part.type==='tool_result'&&part.ok===true&&(part.toolCallId===id||String(part.content??'').includes(key))));
}
/** Cron prompts in transcript order. A shared main session can hold more than one. */
export function cronOperations(messages){
 const ops=[];
 for(const message of messages){
  if(message.role!=='user')continue;
  const text=(message.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
  const match=text.match(/^\[cron:(http_op_\d+)\]/m);
  if(match&&!ops.includes(match[1]))ops.push(match[1]);
 }
 return ops;
}
/** Latest cron prompt that has not yet produced its controlled tool result. */
export function unansweredCronOperation(messages,sessionId){
 let found;
 for(const message of messages){
  if(message.role!=='user')continue;
  const text=(message.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
  const match=text.match(/^\[cron:(http_op_\d+)\]/m);
  if(!match||controlledToolDone(messages,match[1],sessionId))continue;
  found=match[1];
 }
 return found;
}
/**
 * A bot routine now shares the main session. Once the previous operation's tool
 * result is already in history, the next idle run belongs to the unanswered cron
 * prompt rather than repeating that finished operation.
 */
export function preferUnansweredCron(messages,sessionId,operation){
 const cron=unansweredCronOperation(messages,sessionId);
 if(!cron)return operation;
 if(!operation||controlledToolDone(messages,operation,sessionId))return cron;
 return operation;
}
