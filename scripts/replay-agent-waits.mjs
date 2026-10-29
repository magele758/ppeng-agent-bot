/** Replay real scheduling cadence with explicitly synthetic observations; no network/model calls. */
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SqliteStateStore} from '../packages/core/dist/storage.js';
import {DurableWaitStore,registerWaitSource} from '../packages/core/dist/waits/index.js';
const defaultFixture=new URL('../packages/core/test/fixtures/durable-wait-cadence.json',import.meta.url);
export function replayWaitCadence(path=defaultFixture){
 const fixture=JSON.parse(readFileSync(path,'utf8'));
 const scenarios=[];
 for(const mode of ['unavailable','unchanged']){
  const dir=mkdtempSync(join(tmpdir(),'wait-replay-'));
  let store=new SqliteStateStore(join(dir,'db')),now=1,completeRef;
  const attach=()=>registerWaitSource(store,'replay',{fields:['status'],observe:(_,ref)=>ref===completeRef?{availability:'available',facts:{status:'completed'}}:mode==='unavailable'?{availability:'unavailable',reason:'No external observation in historical log'}:{availability:'available',facts:{status:'running'}}});
  try{
   attach();let waits=new DurableWaitStore(store,()=>now);
   const session=store.createSession({title:'Replay owner',mode:'chat',agentId:'general',metadata:{userId:'replay'}});
   const refs=[...new Set(fixture.occurrences.map(row=>row[0]))],ids=new Map();
   for(const ref of refs)ids.set(ref,waits.register({kind:'routine',id:String(ref),revision:1,sessionId:session.id,scopeSessionId:session.id},{source:'replay',ref:String(ref),condition:{op:'eq',field:'status',value:'completed'}}).id);
   let resumes=0,checks=0;
   for(const [ref,offset] of fixture.occurrences){
    now=offset+1;waits.check(ids.get(ref));waits.consume(ids.get(ref),()=>resumes++);checks++;
    if(checks===Math.floor(fixture.occurrences.length/2)){store.db.close();store=new SqliteStateStore(join(dir,'db'));attach();waits=new DurableWaitStore(store,()=>now);}
   }
   const before=resumes;completeRef=String(refs[0]);let others=0;
   for(const [ref,id] of ids){waits.check(id);waits.consume(id,()=>{resumes++;if(String(ref)!==completeRef)others++;});}
   let duplicates=0;for(const id of ids.values()){waits.check(id);waits.consume(id,()=>duplicates++);}
   scenarios.push({mode,checks,restarted:true,resumesBeforeInjectedCompletion:before,resumesAfterInjectedCompletion:resumes-before,otherOwnersResumed:others,duplicateResumes:duplicates});
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
 }
 return {provenance:fixture.provenance,occurrences:fixture.occurrences.length,routines:new Set(fixture.occurrences.map(row=>row[0])).size,historicalExternalObservations:0,observationPolicy:'All observations in this replay are synthetic; timestamps and grouping are historical. Resume callbacks measure scheduling, not billed model tokens.',scenarios};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(replayWaitCadence(process.argv[2]??defaultFixture),null,2));
