/** A Room oracle must follow the explicit trigger, never a historical member reply. */
export function controlledOperation(messages,durableKind){
 if(durableKind==='result')return undefined;
 const latest=[...messages].reverse().find(message=>message.role==='user');
 const text=(latest?.parts??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 const trigger=text.match(/^Trigger: (.+)$/m);
 if(trigger){const content=JSON.parse(trigger[1]);return String(content.text??'').match(/http_op_\d+/)?.[0];}
 return text.match(/http_op_\d+/)?.[0];
}
