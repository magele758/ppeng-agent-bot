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
export function pendingControlledOperations(operations,{completed,explicitDecision}){
 return [...new Set(operations)].filter(operation=>!completed(operation)&&explicitDecision(operation)?.finished!==1);
}
