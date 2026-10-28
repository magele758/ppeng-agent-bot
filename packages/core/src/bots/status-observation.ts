import type {SessionMessage} from '../types.js';
export const statusObservationTool=/^(?:bash|bg_check|read_file|grep_files|list_files|glob_files|http_request|fetch_url|prom_query|loki_query|k8s_get|work_evidence|codex_exec|claude_code|cursor_agent|bot_team_status|bot_request_status)$/;
function sourceTimestamp(raw:string,depth=0):string|undefined {
 if(depth>2||raw.length>1048576)return undefined;
 try{
  const value=JSON.parse(raw) as Record<string,unknown>;if(!value||typeof value!=='object')return undefined;
  const direct=[value.observedAt,value.sampledAt,value.checkedAt].filter((x):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x))).sort((a,b)=>Date.parse(a)-Date.parse(b))[0];if(direct)return direct;
  for(const key of ['stdout','text','content'])if(typeof value[key]==='string'){const nested=sourceTimestamp(value[key] as string,depth+1);if(nested)return nested;}
 }catch{/* A plain command observation has the host tool-result timestamp. */}
 return undefined;
}
/** Payload timestamps can make evidence older, never newer than the host observation. */
export function statusObservation(message:Pick<SessionMessage,'createdAt'|'parts'>):{at:string;tool:string;freshSnapshot?:boolean}|undefined {
 const observations=message.parts.flatMap(part=>{
  if(part.type!=='tool_result'||part.ok!==true||!statusObservationTool.test(part.name)||part.content.length>1048576)return [];
  if(part.name==='bot_team_status'||part.name==='bot_request_status'){
   try{
    const value=JSON.parse(part.content),rows=part.name==='bot_team_status'?value:[value.snapshot];
    if(!Array.isArray(rows)||!rows.length||rows.some(row=>!row||row.stale!==false||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))))return [];
    if(part.name==='bot_request_status'&&(!['fresh','replied'].includes(value.status)||value.stale===true))return [];
    const at=rows.map(row=>new Date(Date.parse(row.observedAt)).toISOString()).sort()[0]!;
    return [{at,tool:part.name,freshSnapshot:true}];
   }catch{return [];}
  }
  let source=sourceTimestamp(part.content);
  if(part.name==='bg_check')try{const job=JSON.parse(part.content);if(typeof job.updatedAt==='string'&&Number.isFinite(Date.parse(job.updatedAt)))source=job.updatedAt;}catch{/* Non-JSON output retains its host timestamp. */}
  const at=source&&Date.parse(source)<Date.parse(message.createdAt)?new Date(Date.parse(source)).toISOString():message.createdAt;
  return [{at,tool:part.name}];
 });
 return observations.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
}
