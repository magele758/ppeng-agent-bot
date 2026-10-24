/** Capture before calling, so a cancelled trial still has its verification input. */
export function observeTextCompletion(completeText, records, checkpoint) {
 return async input=>{
  const started=Date.now();
  const record={input:{system:input.system,user:input.user,jsonMode:input.jsonMode},startedAt:new Date(started).toISOString()};
  records.push(record);checkpoint();
  try {const raw=await completeText(input);record.raw=raw;return raw;}
  catch(error){record.error=String(error?.message??error);throw error;}
  finally{record.durationMs=Date.now()-started;checkpoint();}
 };
}

/** Serialize the complete trial once; raw judge payloads follow the same redaction. */
export function serializeEvidence(value, secret) {
 return JSON.stringify(value,null,2).replaceAll(secret?JSON.stringify(secret).slice(1,-1):'\0','[REDACTED]');
}
