/** Accept only a fresh terminal output from this run; idle after abort is not completion. */
export function isFreshCompletedOutput(session,sourceSeq,outputSeq){
 const outcome=session?.metadata?.outcome;
 return ['idle','completed'].includes(session?.status)&&(outcome?.kind==='completed'||(outcome?.kind==='idle'&&outcome?.reason==='end'))&&!outcome.failureStage&&Number.isSafeInteger(sourceSeq)&&Number.isSafeInteger(outputSeq)&&outputSeq>sourceSeq;
}
/** Source identity, not a quoted operation name, makes a user message eligible. */
export function pendingHumanInputs(messages,{isResult,receipt}){
 const seen=new Set(),rows=[];
 for(const message of messages){if(message.role!=='user'||isResult(message))continue;for(const part of message.parts){if(part.type!=='text')continue;for(const match of part.text.matchAll(/http_op_\d+/g)){if(seen.has(match[0]))continue;const source=receipt(match[0],message);if(!source)continue;seen.add(match[0]);rows.push({operation:match[0],sourceSeq:source.sourceSeq,messageId:message.id});}}}
 return rows;
}
/** SDK archival can replace content with a preview; invocation identity and typed success remain stable. */
export function hasControlledSoftwareResult(messages,operation,sessionId){
 const id='controlled_'+operation+':'+sessionId;
 return messages.some(message=>message.parts.some(part=>part.type==='tool_result'&&part.name==='http_benchmark_software'&&part.toolCallId===id&&part.ok===true));
}
/** Retire only a decision actually emitted after a seen successful result; a raw call count is not completion. */
export function pendingControlledOperations(operations,{completed,explicitDecision,messages=[],sessionId}){
 // Compaction can summarize an earlier cron prompt while retaining its tool result.
 // Only a previously started decision plus a currently observed successful result
 // authorizes confirmation; database effects alone never manufacture completion.
 const observed=[];
 for(const message of messages)for(const part of message.parts??[]){
  if(part.type!=='tool_result'||part.name!=='http_benchmark_software'||part.ok!==true)continue;
  const operation=part.toolCallId?.match(/^controlled_(http_op_\d+):/)?.[1];
  if(operation&&part.toolCallId===`controlled_${operation}:${sessionId}`&&explicitDecision(operation)?.finished===0)observed.push(operation);
 }
 return [...new Set([...operations,...observed])].filter(operation=>!completed(operation)&&explicitDecision(operation)?.finished!==1);
}

/** Reports are bounded excerpts; completion requires the original task's observed durable output. */
export function hasDispatchCompletion(operation,task,evidence){
 return task?.status==='completed'&&typeof task.result==='string'&&task.result.length>0
  &&evidence?.operation===operation&&evidence.sessionId===task.sessionId
  &&Number.isSafeInteger(task.sourceSeq)&&task.sourceSeq>0&&evidence.sourceSeq===task.sourceSeq
  &&Number.isSafeInteger(evidence.outputSeq)&&evidence.outputSeq>task.sourceSeq&&evidence.outcome==='completed';
}
