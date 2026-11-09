'use client';
import {useEffect,useMemo,useRef,useState,type CSSProperties,type ReactNode} from 'react';
import {useI18n} from '@/lib/i18n';
import {loadBotNetwork} from '@/lib/load-bot-network';
import {networkEdges,type Observation} from '@/lib/network-observations';
import {networkLayout} from '@/lib/network-layout';
import {useLab} from '../../shell/LabProvider';
import {BotFace} from '../../BotFace';
import {NetworkViewport} from './NetworkViewport';
import styles from './bot-network.module.css';

function useNetwork(){
  const [data,setData]=useState<Awaited<ReturnType<typeof loadBotNetwork>>>();
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function refresh(){
      const result=await loadBotNetwork(AbortSignal.any([controller.signal,AbortSignal.timeout(20000)]));
      if(controller.signal.aborted)return;
      setData(result);
      timer=setTimeout(refresh,30000);
    }
    void refresh();return ()=>{controller.abort();clearTimeout(timer);};
  },[]);
  return data;
}

function tone(state:string){
  if(/blocked|failed|error|rejected/.test(state))return 'failed';
  if(/running|processing|progress/.test(state))return 'running';
  if(/pending|queued|waiting|assigned/.test(state))return 'waiting';
  if(/completed|done|delivered|success/.test(state))return 'done';
  return 'other';
}
function RecordRow({row}:{row:Observation}){
  const {t,locale}=useI18n();
  const {openSession}=useLab();
  return <li><small>{new Date(row.at).toLocaleString(locale)} · {t(`tasks.flow.${tone(row.state)}`,{state:row.state})}</small>
    <details><summary><span>{row.title}</span></summary><p>{row.report}</p><small>{row.id}</small></details>
    {row.cost!=null && <small>{t('tasks.flow.cost',{value:'$'+row.cost})}</small>}
    {row.session && <button className="btn btn-ghost btn-sm" onClick={()=>void openSession(row.session!,{focusChat:true})}>{t('tasks.flow.open')}</button>}
  </li>;
}
type Selection={from:string;to?:string};
function matches(row:{from:string;to:string},sel:Selection){
  if(sel.to)return row.from===sel.from && row.to===sel.to;
  return row.from===sel.from || row.to===sel.from;
}
function graphData(records:Observation[],botIds:string[],roomIds:string[],days:number,extra:string[]){
  const visible=new Set([...botIds,...roomIds]);
  const cutoff=days?Date.now()-days*86400000:0;
  const edges=networkEdges(records.filter(r=>visible.has(r.from)&&visible.has(r.to)&&Date.parse(r.at)>=cutoff));
  const ids=[...new Set([...edges.flatMap(e=>[e.from,e.to]),...extra])].sort();
  return {edges,...networkLayout(ids,edges)};
}

function cameraOrigin(graph:ReturnType<typeof networkLayout>,focus:string):CSSProperties {
  const anchor=graph.byId.get(focus) ?? graph.points[0];
  if(!anchor)return {};
  return {
    '--origin-x': (100*anchor.x/graph.width)+'%',
    '--origin-y': (100*anchor.y/graph.height)+'%',
  } as CSSProperties;
}

function HandoffPreview({row,node}:{row:Observation|undefined;node:string}){
  if(!row?.title || row.from!==node)return null;
  return <span className={styles.preview} data-testid="handoff-preview" aria-hidden="true">{row.title}</span>;
}

function HandoffCamera({children,origin,record,playing}:{children:ReactNode;origin:CSSProperties;record?:string;playing:boolean}){
  const layer=useRef<HTMLDivElement>(null);
  const previous=useRef(record);
  useEffect(()=>{
    const changed=previous.current && previous.current!==record;
    previous.current=record;
    if(!changed || !playing || window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const shot=layer.current?.animate([
      {transform:'scale(1)',offset:0},{transform:'scale(1.65)',offset:.30},
      {transform:'scale(1.65)',offset:.62},{transform:'scale(1)',offset:1},
    ],{duration:4400,easing:'ease-in-out'});
    return ()=>shot?.cancel();
  },[record,playing]);
  return <div ref={layer} className={styles.camera} style={origin}>{children}</div>;
}

function useHandoffPlayback(edges:ReturnType<typeof networkEdges>,enabled:boolean){
  const [index,setIndex]=useState(0);
  const recent=useMemo(()=>edges.map(edge=>edge.records.reduce((a,b)=>a.at>b.at?a:b))
    .sort((a,b)=>b.at.localeCompare(a.at)).slice(0,12),[edges]);
  useEffect(()=>{
    if(!enabled || recent.length<2)return;
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const timer=window.setInterval(()=>{
      if(!media.matches && !document.hidden)setIndex(n=>n+1);
    },4800);
    return ()=>window.clearInterval(timer);
  },[enabled,recent.length]);
  return recent[index%recent.length];
}

function nodeStyle(p:ReturnType<typeof networkLayout>['points'][number],zoom:number,index:number):CSSProperties{
  const diameter=p.degree ? 28+Math.min(15,p.degree*2) : 19+(index*7)%12;
  return {left:p.x*zoom,top:p.y*zoom,'--face-size':diameter*zoom+'px',
    '--phase':-(index%11)*.48+'s','--reveal':Math.min(index*8,550)+'ms'} as CSSProperties;
}

function anchorX(graph:ReturnType<typeof networkLayout>,id:string){
  return graph.byId.get(id)?.x ?? graph.width/2;
}

function initialAnchor(graph:ReturnType<typeof graphData>,focus:string){
  return focus || graph.points[0]?.id || '';
}

function useNetworkStory(graph:ReturnType<typeof graphData>,rows:Observation[],selection:Selection,focus:string){
  const [paused,setPaused]=useState(false);
  const playing=!paused && !selection.from;
  const playback=useHandoffPlayback(graph.edges,playing);
  const preview=selection.from?rows[0]:playback;
  return {playing,setPaused,preview,spotlight:preview ?? selection,anchor:initialAnchor(graph,focus)};
}

function PlaybackButton({playing,onClick}:{playing:boolean;onClick:()=>void}){
  const {t}=useI18n();
  const label=t(playing?'tasks.flow.pauseReplay':'tasks.flow.playReplay');
  return <button aria-label={label} title={label} onClick={onClick}>{playing?'Ⅱ':'▷'}</button>;
}

function NetworkFigure({room,id,name,degree}:{room:boolean;id:string;name:string;degree:number}){
  return <span className={styles.figure}>{room?<span className={styles.group} aria-hidden="true">•••</span>
    :<BotFace name={name} botId={id} size="sm"/>}{degree>0 && <i aria-hidden="true">{degree}</i>}</span>;
}

export function BotNetworkView({focus,onInspect}:{focus:string;onInspect:(id:string)=>void}){
  const {t}=useI18n();
  const {bots,openSession}=useLab();
  const data=useNetwork();
  const [selection,select]=useState<Selection>({from:focus});
  const [days,setDays]=useState(7);
  const [showIdle,setShowIdle]=useState(true);
  const [zoom,setZoom]=useState(1);
  const visible=useMemo(()=>bots.filter(b=>!b.hidden),[bots]);
  const graph=useMemo(()=>graphData(data?.records??[],visible.map(b=>b.id),(data?.rooms??[]).map(r=>r.id),days,showIdle?visible.map(b=>b.id):visible.filter(b=>b.id===focus).map(b=>b.id)),[data,visible,days,showIdle,focus]);
  const labels=new Map([...visible,...(data?.rooms??[]).map(r=>({id:r.id,name:r.title}))].map(n=>[n.id,n.name]));
  const roomIds=new Set(data?.rooms.map(r=>r.id));
  const related=graph.edges.filter(e=>matches(e,selection));
  const rows=related.flatMap(e=>e.records).sort((a,b)=>b.at.localeCompare(a.at));
  const story=useNetworkStory(graph,rows,selection,focus);
  const {preview,spotlight,anchor}=story;
  const bot=visible.find(b=>b.id===selection.from);
  const label=(id:string)=>labels.get(id)??id;
  const linkLabel=(a:string,b:string)=>label(a)+(roomIds.has(a)?' · ':' → ')+label(b);
  return <section className={styles.network}><header><h2>{t('tasks.flow.network')}</h2>
    <div className={styles.filters}><label><input type="checkbox" checked={showIdle} onChange={e=>setShowIdle(e.target.checked)}/>{t('tasks.flow.idle')}</label><select aria-label={t('tasks.flow.period')} value={days} onChange={e=>setDays(Number(e.target.value))}>{[1,7,0].map(n=><option key={n} value={n}>{n?t('tasks.flow.days',{n}):t('tasks.flow.all')}</option>)}</select></div></header>
    <div className={styles.board}><div className={styles.tools}><PlaybackButton playing={story.playing} onClick={()=>{select({from:''});story.setPaused(story.playing);}}/><button aria-label={t('tasks.flow.smaller')} disabled={zoom<=.6} onClick={()=>setZoom(v=>v-.2)}>−</button><button aria-label={t('tasks.flow.larger')} disabled={zoom>=1.8} onClick={()=>setZoom(v=>v+.2)}>+</button></div>
    <NetworkViewport onDrag={()=>story.setPaused(true)} center={anchorX(graph,anchor)*zoom} ready={Boolean(data)}><div className={styles.stage} style={{width:graph.width*zoom,height:graph.height*zoom}}>
      <div className={styles.scene} data-testid="network-scene" data-ready={Boolean(data)} style={cameraOrigin(graph,anchor)}>
      <HandoffCamera origin={cameraOrigin(graph,spotlight.from)} record={preview?.id} playing={story.playing}>
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`} width="100%" height="100%">
        {graph.edges.map(edge=>{
          const a=graph.byId.get(edge.from)!,b=graph.byId.get(edge.to)!;
          const path=connectionPath(a,b);
          return <g key={edge.from+'/'+edge.to} className={styles.edge} data-tone={tone(edge.records.reduce((x,y)=>x.at>y.at?x:y).state)} data-active={matches(edge,spotlight)} role="button" tabIndex={0} aria-label={linkLabel(edge.from,edge.to)} onClick={()=>select(edge)} onKeyDown={e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(edge);}}}>
            <title>{linkLabel(edge.from,edge.to)}</title><path d={path}/><path className={styles.packet} pathLength={100} d={path}/><path className={styles.hit} d={path}/>
          </g>;
        })}
      </svg>
      {graph.points.map((p,index)=><button key={p.id} className={styles.node} data-anchor={p.id===anchor} data-degree={p.degree} data-speaking={p.id===spotlight.from} data-selected={p.id===selection.from} aria-label={label(p.id)} title={label(p.id)} onClick={()=>select({from:p.id})} style={nodeStyle(p,zoom,index)}>
        <NetworkFigure room={roomIds.has(p.id)} id={p.id} name={label(p.id)} degree={p.degree}/><span className={styles.caption}>{label(p.id)}</span>
        <HandoffPreview key={preview?.id} row={preview} node={p.id}/>
      </button>)}
    </HandoffCamera></div></div></NetworkViewport>
      <span className={styles.panHint}>{t('tasks.flow.pan')}</span></div>
    <div className={styles.legend}>{(['running','waiting','failed','done'] as const).map(status=><span key={status} data-tone={status}>{t(`tasks.flow.${status}`)}</span>)}</div>
    <section className={styles.inspect} aria-live="polite">
      {data?.partial && <p>{t('tasks.flow.partial')}</p>}
      <header><h3>{selection.to?linkLabel(selection.from,selection.to):label(selection.from)}</h3>
      {bot && <div className={styles.filters}>
        <button className="btn btn-ghost btn-sm" onClick={()=>void openSession(bot.canonicalSessionId,{focusChat:true})}>{t('tasks.flow.open')}</button>
        <button className="btn btn-sm" onClick={()=>onInspect(bot.id)}>{t('tasks.flow.single')}</button></div>}</header>
      <NetworkRecords key={selection.from+selection.to} rows={rows} selected={Boolean(selection.from)} loaded={Boolean(data)}/>
    </section>
  </section>;
}
function NetworkRecords({rows,selected,loaded}:{rows:Observation[];selected:boolean;loaded:boolean}){
  const {t}=useI18n();
  const [limit,setLimit]=useState(12);
  if(!loaded)return <p>{t('tasks.flow.loading')}</p>;
  if(!selected)return <p>{t('tasks.flow.networkHint')}</p>;
  if(!rows.length)return <p>{t('tasks.flow.empty')}</p>;
  return <><ul>{rows.slice(0,limit).map(row=><RecordRow key={row.id} row={row}/>)}</ul>
    {rows.length>limit && <button className="btn" onClick={()=>setLimit(n=>n+12)}>{t('tasks.flow.more')}</button>}</>;
}

function connectionPath(a:{x:number;y:number},b:{x:number;y:number}){
  const dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy));
  const cx=(a.x+b.x)/2-16*dy/d,cy=(a.y+b.y)/2+16*dx/d;
  return `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
}
