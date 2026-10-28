'use client';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import {useI18n} from '@/lib/i18n';
export type RoutineWorkLinkValue={goalId:string;backgroundJobId?:string;sopSkill?:string};
export function RoutineWorkLinkFields({botId,value,onChange}:{botId:string|null;value:RoutineWorkLinkValue|null;onChange:(value:RoutineWorkLinkValue|null)=>void}){
 const {t}=useI18n();const [goals,setGoals]=useState<{id:string;title:string;status:string}[]>([]);const [error,setError]=useState('');
 useEffect(()=>{
  let live=true;setGoals([]);setError('');
  if(botId)void api(`/api/bots/${encodeURIComponent(botId)}/open`,{method:'POST'}).then(opened=>{
   const sid=(opened as {session:{id:string}}).session.id;
   return api(`/api/bots/${encodeURIComponent(botId)}/goals?sessionId=${encodeURIComponent(sid)}`);
  }).then(data=>{if(live)setGoals((data as {goals:typeof goals}).goals);}).catch(e=>{if(live)setError(String(e));});
  return ()=>{live=false;};
 },[botId]);
 return <fieldset data-testid="routine-work-link"><legend>{t('play.cronPanel.workLink')}</legend>
  <p>{t('play.cronPanel.workLinkHint')}</p>
  {error&&<p role="alert">{error}</p>}
  <label><span>{t('play.cronPanel.workGoal')}</span><select aria-label={t('play.cronPanel.workGoal')} value={value?.goalId??''} onChange={e=>onChange(e.target.value?{...value,goalId:e.target.value}:null)}>
   <option value="">{t('play.cronPanel.workIndependent')}</option>
   {value?.goalId&&!goals.some(g=>g.id===value.goalId)&&<option value={value.goalId}>{value.goalId}</option>}
   {goals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}
  </select></label>
  {value&&<>
   <label><span>{t('play.cronPanel.workJob')}</span><input aria-label={t('play.cronPanel.workJob')} value={value.backgroundJobId??''} onChange={e=>onChange({...value,backgroundJobId:e.target.value||undefined})}/></label>
   <label><span>{t('play.cronPanel.workSop')}</span><input aria-label={t('play.cronPanel.workSop')} value={value.sopSkill??''} onChange={e=>onChange({...value,sopSkill:e.target.value||undefined})}/></label>
  </>}
 </fieldset>;
}
