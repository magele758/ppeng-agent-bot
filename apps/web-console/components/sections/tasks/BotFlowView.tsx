'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { loadBotFlows } from '@/lib/load-bot-flows';
import type { Flow, FlowStep } from '@/lib/bot-activity-flow';
import { useLab } from '../../shell/LabProvider';
import {BotNetworkView} from './BotNetworkView';
import styles from './bot-flow.module.css';

const stateLabels:Record<string,'done'|'waiting'|'running'|'failed'|'reportedBlocked'>={
  requested:'waiting',done:'done',completed:'done',running:'running',queued:'waiting',waiting_condition:'waiting',
  waiting_approval:'waiting',blocked:'failed',failed:'failed',reportedBlocked:'reportedBlocked'
};
function Step({step,index,flow}:{step:FlowStep;index:number;flow:Flow}){
  const {t}=useI18n();
  const {bots,openSession}=useLab();
  const bot=bots.find(b=>b.id===step.bot);
  const session=step.session??bot?.canonicalSessionId;
  const state=stateLabels[step.state]??'other';
  const parent=flow.steps.find(s=>s.id===step.parent);
  const parentName=bots.find(b=>b.id===parent?.bot)?.name;
  return <li className={styles.step} data-state={state}>
    <div className={styles.row}><span className={styles.index}>{index+1}</span>
      <strong>{bot?.name??step.bot}</strong><span className={styles.status}>{t(`tasks.flow.${state}`,{state:step.state})}</span>
      {session && <button className="btn btn-ghost btn-sm" onClick={()=>void openSession(session,{focusChat:true})}>{t('tasks.flow.open')}</button>}
    </div>
    {parent && <small>{t('tasks.flow.upstream')} · {parentName??parent.bot} · {flow.steps.indexOf(parent)+1}</small>}
    {step.label && <p>{step.label.slice(0,240)}</p>}
    {state==='reportedBlocked' && <small>{t('tasks.flow.raw',{state:step.raw})}</small>}
    {step.tokens!=null && <small>{t('tasks.flow.tokens',{n:step.tokens.toLocaleString()})} </small>}
    {step.cost!=null && <small>{t('tasks.flow.cost',{value:'$'+step.cost.toLocaleString(undefined,{maximumFractionDigits:6})})}</small>}
    {step.report && <details><summary>{t('tasks.flow.result')}</summary><div className={styles.report}>{step.report}</div></details>}
  </li>;
}
function Branch({step,flow,ancestors}:{step:FlowStep;flow:Flow;ancestors:Set<string>}){
  const visited=new Set(ancestors).add(step.id);
  const children=flow.steps.filter(s=>s.parent===step.id&&!visited.has(s.id));
  return <li className={styles.branch}><ul><Step step={step} index={flow.steps.indexOf(step)} flow={flow}/></ul>
    {children.length>0 && <ul className={styles.children}>{children.map(s=><Branch key={s.id} step={s} flow={flow} ancestors={visited}/>)}</ul>}</li>;
}
function Activity({flow}:{flow:Flow}){
  const {t}=useI18n();
  return <article className={styles.card}><header><small>{t(`tasks.flow.${flow.kind}`)}</small>
    <time dateTime={flow.at}>{new Date(flow.at).toLocaleString()}</time></header>
    <h3>{flow.title}</h3><ul className={styles.tree}>{flow.steps.filter(step=>!step.parent).map(step=><Branch key={step.id} step={step} flow={flow} ancestors={new Set()}/>)}</ul>
    <footer>{flow.cost==null?t('tasks.flow.unknownCost'):t('tasks.flow.cost',{value:'$'+flow.cost.toLocaleString(undefined,{maximumFractionDigits:6})})}
      {flow.seconds!=null && <span>{t('tasks.flow.elapsed',{n:flow.seconds})}</span>}
      {flow.calls!=null && <span>{t('tasks.flow.calls',{count:flow.calls})}</span>}</footer></article>;
}
function useActivity(bot:string,session:string){
  const [view,setView]=useState<{bot:string;flows:Flow[];partial:boolean}|null>(null);
  useEffect(()=>{
    if(!bot||!session)return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      const result=await loadBotFlows(bot,session,AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));
      if(controller.signal.aborted)return;
      setView({bot,...result});timer=setTimeout(refresh,20000);
    }
    void refresh();return ()=>{controller.abort();clearTimeout(timer);};
  },[bot,session]);
  return view?.bot===bot?view:null;
}
export function BotFlowView(){
  const {t}=useI18n();
  const [focus,setFocus]=useState(()=>new URLSearchParams(typeof window==='undefined'?'':window.location.hash.split('?')[1]).get('bot')??'');
  const [detail,setDetail]=useState(false);
  if(!detail)return <BotNetworkView focus={focus} onInspect={id=>{setFocus(id);setDetail(true);}}/>;
  return <><button className="btn btn-ghost" onClick={()=>setDetail(false)}>← {t('tasks.flow.network')}</button><BotFlowDetail initial={focus}/></>;
}
function FlowListView({records,limit,onLoadMore,partial,loading}:{records?:Flow[];limit:number;onLoadMore:()=>void;partial:boolean;loading:boolean}){
  const {t}=useI18n();
  return <>
    {partial && <p role="status">{t('tasks.flow.partial')}</p>}
    {loading && <p role="status">{t('tasks.flow.loading')}</p>}
    {records?.length===0 && <p>{t('tasks.flow.empty')}</p>}
    {records?.slice(0,limit).map(flow=><Activity key={flow.id} flow={flow}/>)}
    {records && records.length>limit && <button className="btn" onClick={onLoadMore}>{t('tasks.flow.more')}</button>}
  </>;
}
function BotFlowDetail({initial}:{initial:string}){
  const {t}=useI18n();
  const {bots,selectedSessionId}=useLab();
  const [selection,setSelection]=useState(initial);
  const [limit,setLimit]=useState(12);
  const [period,setPeriod]=useState(7);
  const visible=bots.filter(bot=>!bot.hidden);
  const bot=selection||visible.find(b=>b.canonicalSessionId===selectedSessionId)?.id||visible[0]?.id||'';
  const data=useActivity(bot,visible.find(b=>b.id===bot)?.canonicalSessionId??'');
  const threshold=period ? Date.now()-period*86400000 : 0;
  const records=data?.flows.filter(flow=>Date.parse(flow.at)>=threshold);
  return <div className={styles.panel}><div className={styles.toolbar}>
    <h2>{t('tasks.flow.recent')}</h2><label>{t('tasks.flow.select')} <select value={bot} onChange={e=>{setSelection(e.target.value);setLimit(12);}}>{visible.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label><label>{t('tasks.flow.period')} <select value={period} onChange={e=>{setPeriod(Number(e.target.value));setLimit(12);}}>{[1,7,0].map(days=><option key={days} value={days}>{days?t('tasks.flow.days',{n:days}):t('tasks.flow.all')}</option>)}</select></label></div>
    <FlowListView records={records} limit={limit} onLoadMore={()=>setLimit(n=>n+12)} partial={!!data?.partial} loading={!data}/>
  </div>;
}
