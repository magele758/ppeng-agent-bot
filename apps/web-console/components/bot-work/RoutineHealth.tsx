'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api, json, useAction, Feedback } from './shared';
import { RoutineRuns } from './RoutineRuns';
type Policy = { hardFailureThreshold:number; maxBackoffMs:number; notificationCooldownMs:number };
type Health = {policy:Policy;failures:number;hardFailures:number;paused:boolean;nextEligibleAt?:number;lastFailureClass?:string;notices:{kind:'failure'|'recovery';at:number;runId:string}[]};
function HealthCard({job}:{job:{id:string;name:string}}){
 const {t}=useI18n();const action=useAction();
 const [health,setHealth]=useState<Health>();const [policy,setPolicy]=useState<Policy>();
 useEffect(()=>{
  let alive=true;const refresh=()=>{void api(`/api/cron/jobs/${job.id}/health`).then(data=>{if(alive){const value=(data as {health:Health}).health;setHealth(value);setPolicy(prior=>prior??value.policy);}}).catch(()=>{});};
  refresh();const timer=setInterval(refresh,3000);return()=>{alive=false;clearInterval(timer);};
 },[job.id]);
 if(!health||!policy)return null;
 return <article data-testid={`routine-health-${job.id}`} className="card">
  <h3>{job.name}</h3>
  <p>{health.paused?t('botWork.healthPaused'):t('botWork.healthActive')} · {t('botWork.healthCounts',{failures:health.failures,hard:health.hardFailures})}</p>
  {health.lastFailureClass&&<p>{health.lastFailureClass==='transient'?t('botWork.failureTransient'):t('botWork.failureHard')}</p>}
  {health.nextEligibleAt&&<p>{t('botWork.healthNext',{time:new Date(health.nextEligibleAt).toLocaleString()})}</p>}
  <form onSubmit={e=>{e.preventDefault();void action.run(async()=>{const data=await api(`/api/cron/jobs/${job.id}/health`,json(policy,'PATCH')) as {health:Health};setHealth(data.health);setPolicy(data.health.policy);});}}>
   <label>{t('botWork.healthThreshold')}<input type="number" min={1} max={100} required value={policy.hardFailureThreshold} onChange={e=>setPolicy({...policy,hardFailureThreshold:Number(e.target.value)})}/></label>
   <label>{t('botWork.healthMaxWait')}<input type="number" min={2} max={1440} required value={policy.maxBackoffMs/60000} onChange={e=>setPolicy({...policy,maxBackoffMs:Number(e.target.value)*60000})}/></label>
   <label>{t('botWork.healthCooldown')}<input type="number" min={0} max={10080} required value={policy.notificationCooldownMs/60000} onChange={e=>setPolicy({...policy,notificationCooldownMs:Number(e.target.value)*60000})}/></label>
   <button disabled={action.busy} type="submit">{t('botWork.healthSave')}</button>
  </form>
  <button disabled={action.busy} onClick={()=>void action.run(async()=>{const data=await api(`/api/cron/jobs/${job.id}/resume`,json({})) as {health:Health};setHealth(data.health);})}>{t('botWork.healthResume')}</button>
  <p>{t('botWork.healthResumeHint')}</p>
  <Feedback {...action}/>
  <ul>{health.notices.map(n=><li key={`${n.runId}:${n.kind}`}>{new Date(n.at).toLocaleString()} · {n.kind==='failure'?t('botWork.healthFailureNotice'):t('botWork.healthRecoveryNotice')}</li>)}</ul>
  <RoutineRuns jobId={job.id}/>
 </article>;
}
export function RoutineHealthCenter(){
 const {t}=useI18n();const [jobs,setJobs]=useState<{id:string;name:string;scheduleKind:string}[]>([]);const [error,setError]=useState('');
 useEffect(()=>{let alive=true;const refresh=()=>{void api('/api/cron/jobs').then(data=>{if(alive){setJobs((data as {jobs:typeof jobs}).jobs.filter(j=>['every_ms','cron5'].includes(j.scheduleKind)));setError('');}}).catch(e=>{if(alive){setJobs([]);setError(String(e));}});};refresh();const timer=setInterval(refresh,5000);return()=>{alive=false;clearInterval(timer);};},[]);
 return <section><h2>{t('botWork.healthTitle')}</h2><p>{t('botWork.healthPrivate')}</p><Feedback busy={false} error={error}/>{jobs.map(job=><HealthCard key={job.id} job={job}/>)}</section>;
}
