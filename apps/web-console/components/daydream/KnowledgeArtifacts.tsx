'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { Artifact, EvidenceOption } from './types';
import { Status } from './DaydreamRecords';
import styles from './Daydream.module.css';
type Act = (path: string, body: unknown) => void;
export function KnowledgeArtifacts({items,canGovern,evidence,busy,act}:{items:Artifact[];canGovern:boolean;evidence:EvidenceOption[];busy:boolean;act:Act}) {
 const {t}=useI18n();return <section><h4>{t('daydream.artifacts')}</h4>{items.length===0&&<p>{t('daydream.emptyArtifacts')}</p>}<ul className={styles.list}>{items.map(item=><li className={styles.card} key={item.id}><p>{item.summary??item.name??item.id} · {t('daydream.version',{version:item.currentVersion})} · <Status value={item.status}/></p><Revoke item={item} allowed={canGovern} busy={busy} act={act}/><FeedbackForm item={item} evidence={evidence} busy={busy} act={act}/></li>)}</ul></section>;
}
function Revoke({item,allowed,busy,act}:{item:Artifact;allowed:boolean;busy:boolean;act:Act}) {
 const {t}=useI18n();if(!allowed)return null;
 return <button type="button" disabled={busy} onClick={()=>{if(window.confirm(t('daydream.revokeConfirm')))act(`/knowledge/${encodeURIComponent(item.id)}/revoke`,{version:item.currentVersion})}}>{t('daydream.revoke')}</button>;
}
function FeedbackForm({item,evidence,busy,act}:{item:Artifact;evidence:EvidenceOption[];busy:boolean;act:Act}) {
 const {t}=useI18n();const[kind,setKind]=useState('verified');const[description,setDescription]=useState('');const[messageId,setMessageId]=useState('');
 return <details><summary>{t('daydream.feedback')}</summary><form onSubmit={event=>{event.preventDefault();act(`/knowledge/${encodeURIComponent(item.id)}/feedback`,{version:item.currentVersion,kind,description,messageIds:[messageId]})}}><fieldset disabled={busy} className={styles.fields}>
 <label className={styles.field}>{t('daydream.feedbackKind')}<select value={kind} onChange={e=>setKind(e.target.value)}>{(['verified','failed','correction','extension'] as const).map(value=><option key={value} value={value}>{t(`daydream.feedback${value}`)}</option>)}</select></label>
 <label className={styles.field}>{t('daydream.feedbackDescription')}<textarea required maxLength={16000} value={description} onChange={e=>setDescription(e.target.value)}/></label>
 <label className={styles.field}>{t('daydream.feedbackEvidence')}<select required value={messageId} onChange={e=>setMessageId(e.target.value)}><option value="">{t('daydream.chooseEvidence')}</option>{evidence.map(ref=><option key={ref.messageId} value={ref.messageId}>{ref.observedAt} · {ref.messageId}</option>)}</select></label>
 <p>{t('daydream.feedbackHelp')}</p><button type="submit">{t('daydream.sendFeedback')}</button></fieldset></form></details>;
}
