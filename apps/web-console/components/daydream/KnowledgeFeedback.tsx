'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Status } from './DaydreamRecords';
import type { FeedbackReview } from './types';
import styles from './Daydream.module.css';
type Act = (path:string,body:unknown)=>void;
export function KnowledgeFeedback({items,busy,act}:{items:FeedbackReview[];busy:boolean;act:Act}) {
 const{t}=useI18n();return <section><h4>{t('daydream.feedbackQueue')}</h4>{items.length===0&&<p>{t('daydream.emptyFeedback')}</p>}<ul className={styles.list}>{items.map(item=><li key={item.id} className={styles.card}><p>{item.description}</p><p>{t('daydream.version',{version:item.artifactVersion})} · <Status value={item.status}/></p><ReviewRecommendation reason={item.reviewDecision?.reason}/><FeedbackDecision item={item} busy={busy} act={act}/></li>)}</ul></section>;
}
export function ReviewRecommendation({reason}:{reason?:string}){const{t}=useI18n();if(!reason)return null;return <p>{t('daydream.recommendation',{reason})}</p>}
function FeedbackDecision({item,busy,act}:{item:FeedbackReview;busy:boolean;act:Act}) {
 const{t}=useI18n();if(item.status!=='pending')return null;
 return <FeedbackEditor key={`${item.id}:${item.artifactVersion}`} item={item} busy={busy} act={act}/>;
}
function FeedbackEditor({item,busy,act}:{item:FeedbackReview;busy:boolean;act:Act}) {
 const{t}=useI18n();const[content,setContent]=useState(item.reviewDecision?.content??item.originalContent);const[summary,setSummary]=useState(item.reviewDecision?.summary??item.originalSummary);const[reason,setReason]=useState(item.reviewDecision?.reason??'');
 const send=(action:'revise'|'dismiss')=>act(`/knowledge/feedback/${encodeURIComponent(item.id)}/decision`,{action,reason,content,summary,expectedVersion:item.artifactVersion});
 return <details><summary>{t('daydream.reviewFeedback')}</summary>{!item.available&&<p>{t('daydream.sourceUnavailable')}</p>}<details><summary>{t('daydream.originalVersion')}</summary><pre>{item.originalContent}</pre></details><form onSubmit={e=>{e.preventDefault();send('revise')}}><fieldset disabled={busy} className={styles.fields}>
 <label className={styles.field}>{t('daydream.revisionSummary')}<input required value={summary} onChange={e=>setSummary(e.target.value)}/></label>
 <label className={styles.field}>{t('daydream.revisionContent')}<textarea required value={content} onChange={e=>setContent(e.target.value)}/></label>
 <label className={styles.field}>{t('daydream.decisionReason')}<textarea required value={reason} onChange={e=>setReason(e.target.value)}/></label>
 <button type="submit" disabled={!item.available}>{t('daydream.publishRevision')}</button><button type="button" disabled={!reason.trim()} onClick={()=>send('dismiss')}>{t('daydream.dismissFeedback')}</button>
 </fieldset></form></details>;
}
