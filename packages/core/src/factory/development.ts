import { AuthorizationError, ConflictError, ValidationError, NotFoundError } from '../errors.js';
import { botPrincipalKey,type BotPrincipal } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
import type { FactoryTask } from './types.js';
import type { DevelopmentHost,DevelopmentPolicy,DevelopmentSpec } from './development-types.js';
import { mergeDevelopmentIssueLedger } from './development-evidence.js';
import { parseDevelopmentPolicy } from './development-policy.js';
export class FactoryDevelopment {
 constructor(private store:SqliteStateStore,private host:DevelopmentHost){}
 private key(p:BotPrincipal,m:string,r:string){return 'factory.development:'+botPrincipalKey(p)+':'+m+':'+r;}
 settings(p:BotPrincipal,m:string,r:string):DevelopmentPolicy{return this.store.getDaemonControl<DevelopmentPolicy>(this.key(p,m,r))??{enabled:false} as DevelopmentPolicy;}
 save(p:BotPrincipal,m:string,r:string,input:unknown){this.target(p,m,r);const policy=parseDevelopmentPolicy(input);this.store.setDaemonControl(this.key(p,m,r),policy);for(const task of this.host.list(p)){if(task.machineId===m&&task.repositoryId===r&&task.development?.stage==='READY'&&task.development.policy.revision!==policy.revision){task.development.stage='WAITING_DECISION';task.status='failed';task.error='Development strategy changed; existing evidence is stale';this.host.updateDevelopment(task);}}return policy;}
 private target(p:BotPrincipal,m:string,r:string){const machine=this.host.settings(p).machines.find(x=>x.id===m);if(!machine)throw new NotFoundError('Machine');if(!machine.allowedUserIds.includes(p.userId))throw new AuthorizationError('Machine permission required');const repo=machine.repositories.find(x=>x.id===r);if(!repo)throw new ValidationError('Unknown repository');return {machine,repo};}
 private authorized(p:BotPrincipal,m:string,r:string){this.target(p,m,r);const policy=this.settings(p,m,r);if(!policy.enabled||!policy.allowedUserIds.includes(p.userId))throw new AuthorizationError('Development authorization required');if(!policy.criteriaApproved)throw new ValidationError('Approved acceptance criteria required');return policy;}
 async preflight(p:BotPrincipal,m:string,r:string,baseline:string){const policy=this.authorized(p,m,r);const {machine,repo}=this.target(p,m,r);return this.host.developmentPreflight({...machine,repositories:[repo]},policy,this.baseline(baseline));}
 private baseline(v:unknown){if(typeof v!=='string'||!/^[a-f0-9]{40}$/.test(v))throw new ValidationError('Exact baseline commit required');return v;}
 submit(p:BotPrincipal,input:any){
  const policy=this.authorized(p,input.machineId,input.repositoryId);
  if(typeof input.requirement!=='string'||!input.requirement.trim()||input.requirement.length>20000)throw new ValidationError('Requirement required');
  const spec:DevelopmentSpec={requirement:input.requirement,baseline:this.baseline(input.baseline),policy:structuredClone(policy),generation:1,stage:input.dependency?'WAITING_DEPENDENCY':'QUEUED',round:0,delivery:'not_pushed',decisions:[]};
  if(input.dependency){if(typeof input.dependency.taskId!=='string')throw new ValidationError('Invalid dependency');spec.dependency={taskId:input.dependency.taskId,sha:this.baseline(input.dependency.sha)};}
  return this.host.enqueueDevelopment(p,{machineId:input.machineId,repositoryId:input.repositoryId,requestKey:input.requestKey,roomId:input.roomId},spec);
 }
 current(p:BotPrincipal,id:string){const task=this.host.get(p,id);if(!task.development)throw new ValidationError('Development task required');const policy=this.settings(p,task.machineId,task.repositoryId);return {...task,evidenceCurrent:policy.revision===task.development.policy.revision};}
 decisions(p:BotPrincipal){return this.host.list(p).filter(t=>t.development&&['WAITING_DECISION','DEFERRED','PAUSED','FAILED','CANCELLED','TIMED_OUT'].includes(t.development.stage));}
 dependencySource(t:FactoryTask){const dep=t.development?.dependency;if(!dep)return undefined;try{const source=this.current(t.principal,dep.taskId);const result=source.result?.development as any;return source.development!.stage==='READY'&&result?.sha===dep.sha&&result?.artifact?.sha===dep.sha&&source.evidenceCurrent?source:undefined;}catch{return undefined;}}
 readyToClaim(t:FactoryTask){if(!t.development)return true;const d=t.development;const policy=this.authorized(t.principal,t.machineId,t.repositoryId);if(policy.revision!==d.policy.revision)throw new AuthorizationError('Development strategy changed; confirmation required');if(!d.dependency)return true;const machine=this.target(t.principal,t.machineId,t.repositoryId).machine;return !!this.dependencySource(t)&&d.dependencyPrepared?.generation===d.generation&&d.dependencyPrepared.sha===d.dependency.sha&&d.dependencyPrepared.identity===machine.identity&&d.dependencyPrepared.sshAlias===machine.sshAlias;}
 async control(p:BotPrincipal,id:string,action:string){if(!['pause','cancel'].includes(action))throw new ValidationError('Unsupported control action');const task=this.host.get(p,id);if(!task.development)throw new ValidationError('Development task required');this.target(p,task.machineId,task.repositoryId);if(task.status==='queued'){task.status=action==='pause'?'failed':'cancelled';task.development.stage=action==='pause'?'PAUSED':'CANCELLED';this.host.updateDevelopment(task);return task;}if(!['running','unknown'].includes(task.status))throw new ConflictError('Task is not active');const r=await this.host.developmentStop(task,action);this.host.acceptReport(id,r);return this.host.get(p,id);}
 private reviewCarry(task:FactoryTask){
  const development=task.development!;
  if(development.reviewCarry?.evidenceRecoveryRequired)throw new ConflictError('Full review evidence recovery required before continuation');
  let prior:any={issueLedger:development.reviewCarry?.issues??[]};
  const states=[...(development.executions??[]).map(execution=>(execution.result as any)?.development),(task.result as any)?.development];
  for(const state of states){
   if(!state)continue;
   if(state.receiptOverflow||state.evidenceRecoveryRequired)throw new ConflictError('Full review evidence recovery required before continuation');
   try{prior={issueLedger:mergeDevelopmentIssueLedger(prior,state)};}
   catch{throw new ConflictError('Prior review evidence is invalid; recovery required');}
  }
  const carry={issues:prior.issueLedger as unknown[]};
  if(Buffer.byteLength(JSON.stringify(carry),'utf8')>262144)throw new ConflictError('Review summary exceeds continuation budget; full evidence recovery required');
  return carry;
 }
 decide(p:BotPrincipal,id:string,input:any){const t=this.host.get(p,id);if(!t.development)throw new ValidationError('Development task required');if(['running','unknown'].includes(t.status))throw new ConflictError('Active running task must finish or verify first');if(!['add-rounds','resume','confirm-policy','reassign'].includes(input.action))throw new ValidationError('Unsupported decision action; publishing forbidden');const policy=this.authorized(p,t.machineId,t.repositoryId);if(!['WAITING_DECISION','DEFERRED','PAUSED','FAILED','CANCELLED','TIMED_OUT'].includes(t.development.stage)&&input.action!=='confirm-policy')throw new ConflictError('Task is not awaiting decision');
  const d=t.development;if(input.action==='confirm-policy'&&policy.maxRounds<d.round)throw new ConflictError('Policy repair budget cannot be below consumed rounds');if(input.action==='resume'&&d.round>=d.policy.maxRounds)throw new ConflictError('Repair rounds exhausted; explicit additional rounds required');const rounds=input.action==='add-rounds'?Number(input.rounds):0;if(input.action==='add-rounds'&&(!Number.isInteger(rounds)||rounds<1||rounds>20))throw new ValidationError('Invalid additional rounds');
  const reviewCarry=this.reviewCarry(t);
  d.executions??=[];d.executions.push({generation:d.generation,machineId:t.machineId,repositoryId:t.repositoryId,status:t.status,result:t.result,finishedAt:t.finishedAt});
  if(input.action==='reassign'){const target=this.target(p,input.machineId,input.repositoryId??t.repositoryId);const targetPolicy=this.authorized(p,input.machineId,input.repositoryId??t.repositoryId);if(targetPolicy.maxRounds<d.round)throw new ConflictError('Target policy repair budget cannot be below consumed rounds');if(target.machine.capacity===0)throw new ValidationError('Machine capacity is zero');t.machineId=target.machine.id;t.machine=structuredClone(target.machine);t.repositoryId=target.repo.id;t.repositoryPath=target.repo.path;t.botId=target.machine.botIds[0]!;if(!t.botId)throw new ValidationError('Target machine Bot required');d.policy=structuredClone(targetPolicy);}
  d.policy=input.action==='confirm-policy'?structuredClone(policy):d.policy;if(input.action!=='reassign'&&policy.revision!==d.policy.revision)throw new ConflictError('Policy needs explicit confirmation');
  d.reviewCarry=reviewCarry;
  d.policy.maxRounds+=rounds;d.decisions.push({userId:p.userId,at:new Date().toISOString(),action:input.action,...(rounds?{rounds}:{}),...(input.action==='reassign'?{machineId:t.machineId}:{})});d.generation++;d.stage='QUEUED';t.status='queued';t.seq=0;delete t.finishedAt;delete t.error;delete t.result;delete t.startedAt;this.host.updateDevelopment(t);return t;
 }
}
