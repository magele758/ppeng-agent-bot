import {randomUUID} from 'node:crypto';
import type {SqliteStateStore} from '../storage.js';
import {botPrincipalKey,principalFromSession} from '../bots/bot-identity.js';
import {stableJson} from '../cron/notification-decision.js';
import {conditionMatches,validateCondition} from './conditions.js';
import {waitSources} from './sources.js';
import type {DurableWait,Observation,WaitOwner,WaitSpec} from './types.js';
export class DurableWaitStore {
 constructor(private store:SqliteStateStore,private clock:()=>number=Date.now){
  store.db.exec('CREATE TABLE IF NOT EXISTS agent_waits(id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_agent_wait_owner ON agent_waits(owner_key,status)');
 }
 get(id:string):DurableWait|undefined{const row=this.store.db.prepare('SELECT payload FROM agent_waits WHERE id=?').get(id);return row?JSON.parse(String(row.payload)):undefined;}
 private save(wait:DurableWait):DurableWait{wait.updatedAt=this.clock();this.store.db.prepare('UPDATE agent_waits SET status=?,payload=? WHERE id=?').run(wait.status,JSON.stringify(wait),wait.id);return wait;}
 register(owner:WaitOwner,spec:WaitSpec):DurableWait {
  const adapter=waitSources(this.store).get(spec.source);if(!adapter)throw new Error('Unknown wait source');
  if(typeof spec.ref!=='string'||!spec.ref.trim()||spec.ref.length>500||JSON.stringify(spec).length>12000)throw new Error('Invalid wait reference');
  validateCondition(spec.condition,adapter.fields);
  if(spec.deadline!==undefined&&(!Number.isFinite(spec.deadline)||spec.deadline<=this.clock()))throw new Error('Wait deadline must be in the future');
  if(spec.maxChecks!==undefined&&(!Number.isSafeInteger(spec.maxChecks)||spec.maxChecks<1||spec.maxChecks>1000000))throw new Error('Invalid wait check budget');
  return this.store.transaction(()=>{
   const key=stableJson(owner);const old=this.store.db.prepare("SELECT payload FROM agent_waits WHERE owner_key=? AND status IN ('waiting','ready','blocked')").get(key);
   if(old){const current=JSON.parse(String(old.payload)) as DurableWait;if(stableJson(current.spec)!==stableJson(spec))throw new Error('Execution already has a different active wait');return current;}
   const scope=this.store.getSession(owner.scopeSessionId);if(!scope)throw new Error('Wait owner unavailable');
   const now=this.clock();const wait:DurableWait={id:`wait_${randomUUID()}`,owner,principal:botPrincipalKey(principalFromSession(this.store,scope)),spec,status:'waiting',checks:0,createdAt:now,updatedAt:now};
   const observation=this.observe(wait);if(observation.availability==='unauthorized')throw new Error(observation.reason);
   wait.observation=observation;if(observation.availability==='available')wait.baseline=observation.facts;
   this.store.db.prepare('INSERT INTO agent_waits(id,owner_key,status,payload) VALUES(?,?,?,?)').run(wait.id,key,wait.status,JSON.stringify(wait));return wait;
  });
 }
 private observe(wait:DurableWait):Observation {
  const session=this.store.getSession(wait.owner.sessionId),scope=this.store.getSession(wait.owner.scopeSessionId);
  if(!session||!scope||[session,scope].some(s=>botPrincipalKey(principalFromSession(this.store,s))!==wait.principal))return {availability:'unauthorized',reason:'Wait owner authorization changed'};
  const source=waitSources(this.store).get(wait.spec.source);if(!source)return {availability:'unavailable',reason:'Wait source is not registered on this host'};
  try{
   const result=source.observe({store:this.store,session,scope,owner:wait.owner},wait.spec.ref);
   if(!result||!['available','unavailable','unauthorized'].includes(result.availability)||JSON.stringify(result).length>16000)throw new Error('Invalid observation');
   if(result.availability==='available'){
    if(!result.facts||Object.values(result.facts).some(v=>v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw new Error('Invalid observation facts');
   }
   return result;
  }catch{return {availability:'unavailable',reason:'Wait source observation failed'};}
 }
 check(id:string):DurableWait {
  return this.store.transaction(()=>{
   const wait=this.get(id);if(!wait)throw new Error('Wait not found');
   if(['consumed','expired','cancelled','ready'].includes(wait.status))return wait;
   if(wait.spec.deadline!==undefined&&wait.spec.deadline<=this.clock()||wait.spec.maxChecks!==undefined&&wait.checks>=wait.spec.maxChecks){wait.status='expired';wait.reason='Wait deadline or check budget exhausted';return this.save(wait);}
   const observation=this.observe(wait);wait.observation=observation;wait.checks++;
   if(observation.availability==='unauthorized'){wait.status='blocked';wait.reason=observation.reason;}
   else if(observation.availability==='unavailable'){wait.status='waiting';wait.reason=observation.reason;}
   else if(observation.availability==='available') {
    wait.status=conditionMatches(wait.spec.condition,observation.facts,wait.baseline)?'ready':'waiting';wait.reason=undefined;
    wait.baseline??=observation.facts;
   }
   if(wait.status!=='ready'&&wait.spec.maxChecks!==undefined&&wait.checks>=wait.spec.maxChecks){wait.status='expired';wait.reason='Wait check budget exhausted';}
   return this.save(wait);
  });
 }
 consume(id:string,action:(wait:DurableWait)=>void):boolean {
  return this.store.transaction(()=>{const wait=this.get(id);if(wait?.status!=='ready')return false;const current=this.observe(wait);if(current.availability!=='available'){wait.reason=current.reason;if(current.availability==='unauthorized')wait.status='blocked';this.save(wait);return false;}action(wait);wait.status='consumed';this.save(wait);return true;});
 }
 cancel(id:string,reason='Wait owner is no longer current'):void{this.store.transaction(()=>{const wait=this.get(id);if(wait&&!['consumed','cancelled','expired'].includes(wait.status)){wait.status='cancelled';wait.reason=reason;this.save(wait);}});}
}
