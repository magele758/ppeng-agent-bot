'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
async function request<T>(path:string,init?:RequestInit):Promise<T>{return await api(path,init) as T;}
type Contract = {version:number;objective:string;constraints:string[];todos:string[];evidence:string[];source:string;updatedAt:string};
type Diagnostic = {at:string;changed:string[];cachedInputTokens:number|null;inputTokens:number|null};
export function SessionReliability({sessionId}:{sessionId:string}) {
 const {t}=useI18n();
 const [contract,setContract]=useState<Contract|null>(null);
 const [draft,setDraft]=useState({objective:'',constraints:'',todos:'',evidence:''});
 const [records,setRecords]=useState<Diagnostic[]>([]);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(false);
 useEffect(()=>{let active=true;setLoaded(false);setError('');
  void request<{contract:Contract|null;cacheDiagnostics:Diagnostic[]}>(`/api/sessions/${sessionId}/reliability`).then(data=>{
   if(!active)return;setContract(data.contract);setRecords(data.cacheDiagnostics);setDraft({objective:data.contract?.objective??'',constraints:data.contract?.constraints.join('\n')??'',todos:data.contract?.todos.join('\n')??'',evidence:data.contract?.evidence.join('\n')??''});setLoaded(true);
  }).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};
 },[sessionId]);
 async function save(){setBusy(true);setError('');try{
  const lines=(text:string)=>text.split('\n').map(x=>x.trim()).filter(Boolean);
  const data=await request<{contract:Contract}>(`/api/sessions/${sessionId}/reliability`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:contract?.version??0,contract:{objective:draft.objective,constraints:lines(draft.constraints),todos:lines(draft.todos),evidence:lines(draft.evidence)}})});
  setContract(data.contract);
 }catch(e){setError(String(e));}finally{setBusy(false);}}
 return <details><summary>{t('play.reliability.title')}</summary>
  <p>{t('play.reliability.hint')}</p>
  {error&&<p role="alert">{error}</p>}
  {(['objective','constraints','todos','evidence'] as const).map(key=><label className="field field--stack" key={key}><span>{t(`play.reliability.${key}`)}</span><textarea aria-label={t(`play.reliability.${key}`)} disabled={!loaded||busy} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}
  <button className="btn btn-secondary btn-sm" type="button" disabled={!loaded||busy} onClick={()=>void save()}>{t('play.reliability.save')}</button>
  {contract&&<p>{t('play.reliability.version',{version:contract.version})} · {contract.updatedAt}</p>}
  <h4>{t('play.reliability.cache')}</h4>
  <button className="btn btn-secondary btn-sm" type="button" onClick={()=>{void request<{cacheDiagnostics:Diagnostic[]}>(`/api/sessions/${sessionId}/reliability`).then(data=>setRecords(data.cacheDiagnostics)).catch(e=>setError(String(e)));}}>{t('play.reliability.refresh')}</button>
  <p>{t('play.reliability.cacheHint')}</p>
  {!records.length&&<p>{t('play.reliability.unknown')}</p>}
  <ul>{records.slice().reverse().map((r,i)=><li key={`${r.at}-${i}`}>{r.at} · {t('play.reliability.changed')}: {r.changed.length?r.changed.map(k=>k==='system'?t('play.reliability.system'):k==='tools'?t('play.reliability.tools'):t('play.reliability.stable')).join(', '):t('play.reliability.none')} · {t('play.reliability.cached')}: {r.cachedInputTokens??t('play.reliability.unknown')} / {r.inputTokens??t('play.reliability.unknown')}</li>)}</ul>
 </details>;
}
