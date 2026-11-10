'use client';
import './BotCoachingPanel.css';
import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import {useI18n} from '@/lib/i18n';
import {newCoachingLesson,replaceCoachingLesson,type BotCoaching,type CoachingLesson,type CoachingCheck,type CoachingProfile} from '@/lib/bot-coaching';
function ProfileFields({value,onChange}:{value:CoachingProfile;onChange:(p:CoachingProfile)=>void}){
 const {t}=useI18n();
 return <>{(['role','host','executor','completion'] as const).map(field=><label key={field} style={{display:'block',marginBlock:8}}>{t(`coaching.${field}`)}<textarea rows={2} style={{display:'block',width:'100%'}} value={value[field]??''} onChange={e=>onChange({...value,[field]:e.target.value})}/></label>)}<label>{t('coaching.requiredSkills')}<input style={{display:'block',width:'100%'}} value={(value.requiredSkills??[]).join(', ')} onChange={e=>onChange({...value,requiredSkills:e.target.value.split(',').map(s=>s.trim()).filter(Boolean)})}/></label></>;
}
function CheckEditor({onAdd}:{onAdd:(check:CoachingCheck)=>void}){
 const {t}=useI18n();const [scenario,setScenario]=useState('');const [evidence,setEvidence]=useState('');const [outcome,setOutcome]=useState<CoachingCheck['outcome']>('blocked');
 return <fieldset><legend>{t('coaching.check')}</legend><label>{t('coaching.scenario')}<input value={scenario} onChange={e=>setScenario(e.target.value)}/></label><label>{t('coaching.evidence')}<input value={evidence} onChange={e=>setEvidence(e.target.value)}/></label><label>{t('coaching.outcome')}<select value={outcome} onChange={e=>setOutcome(e.target.value as CoachingCheck['outcome'])}>{(['passed','failed','blocked'] as const).map(o=><option key={o} value={o}>{t(`coaching.${o}`)}</option>)}</select></label><button type="button" className="ag-btn" disabled={!scenario.trim()||!evidence.trim()} onClick={()=>{onAdd({scenario,evidence,outcome});setScenario('');setEvidence('');}}>{t('coaching.addCheck')}</button></fieldset>;
}
function LessonEditor({value,onChange}:{value:CoachingLesson;onChange:(p:CoachingLesson)=>void}){
 const {t}=useI18n();
 return <fieldset><legend>{t('coaching.lesson')}</legend><label>{t('coaching.rule')}<textarea style={{display:'block',width:'100%'}} value={value.rule} onChange={e=>onChange({...value,rule:e.target.value})}/></label><label>{t('coaching.source')}<input value={value.source} onChange={e=>onChange({...value,source:e.target.value})}/></label><label>{t('coaching.status')}<select value={value.status} onChange={e=>onChange({...value,status:e.target.value as CoachingLesson['status']})}>{(['candidate','verified','retired'] as const).map(s=><option key={s} value={s}>{t(`coaching.${s}`)}</option>)}</select></label><ul>{value.checks.map((c,i)=><li key={i}>{c.scenario} · {t(`coaching.${c.outcome}`)} · {c.evidence}</li>)}</ul><CheckEditor onAdd={check=>onChange({...value,checks:[...value.checks,check]})}/></fieldset>;
}
function CoachingForm({botId,initial}:{botId:string;initial:BotCoaching}){
 const {t}=useI18n();const [value,setValue]=useState(initial);const [busy,setBusy]=useState(false);const [status,setStatus]=useState<'saved'|'saveFailed'|null>(null);
 async function save(){setBusy(true);setStatus(null);try{const r=await api(`/api/bots/${encodeURIComponent(botId)}/coaching`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});setValue((r as {coaching:BotCoaching}).coaching);setStatus('saved');}catch{setStatus('saveFailed');}finally{setBusy(false);}}
 return <div className="bot-coaching"><p>{t('coaching.hint')}</p><ProfileFields value={value.profile} onChange={profile=>setValue({...value,profile})}/>{value.lessons.map(lesson=><LessonEditor key={lesson.id} value={lesson} onChange={next=>setValue({...value,lessons:replaceCoachingLesson(value.lessons,next)})}/>)}<button type="button" disabled={busy} onClick={()=>setValue({...value,lessons:[...value.lessons,newCoachingLesson()]})}>{t('coaching.addLesson')}</button><button type="button" disabled={busy} onClick={()=>void save()}>{t('coaching.save')}</button><p role="status">{status&&t(`coaching.${status}`)}</p></div>;
}
export function BotCoachingPanel({botId}:{botId:string}){
 const {t}=useI18n();const [loaded,setLoaded]=useState<BotCoaching|null>(null);const [failed,setFailed]=useState(false);
 useEffect(()=>{let alive=true;setLoaded(null);setFailed(false);void api(`/api/bots/${encodeURIComponent(botId)}/coaching`).then(r=>{if(alive)setLoaded((r as {coaching:BotCoaching}).coaching);}).catch(()=>{if(alive)setFailed(true);});return()=>{alive=false;};},[botId]);
 return <details className="bot-settings-disclosure"><summary>{t('coaching.title')}</summary>{failed&&<p role="alert">{t('coaching.loadFailed')}</p>}{loaded&&<CoachingForm key={botId} botId={botId} initial={loaded}/>}</details>;
}
