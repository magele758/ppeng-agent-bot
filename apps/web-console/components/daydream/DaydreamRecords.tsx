'use client';
import { KnowledgeFeedback, ReviewRecommendation } from './KnowledgeFeedback';
import { KnowledgeArtifacts } from './KnowledgeArtifacts';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { Run, Knowledge, Submission, Output } from './types';
import styles from './Daydream.module.css';
const statuses: Record<string, MessageKey> = { resolved:'daydream.resolved', dismissed:'daydream.dismissed', pending: 'daydream.pending', completed: 'daydream.completed', queued: 'daydream.queued', running: 'daydream.running', partial: 'daydream.partial', failed: 'daydream.failedStatus', cancelled: 'daydream.cancelled', saved: 'daydream.savedStatus', installed: 'daydream.installed', accepted: 'daydream.accepted', rejected: 'daydream.rejected', merged: 'daydream.merged', needsEvidence: 'daydream.needsEvidence', active: 'daydream.active', disputed: 'daydream.disputed', retired: 'daydream.retired' };
export function Status({ value }: {
    value: string;
}) { const { t } = useI18n(); return <span>{t('daydream.status', { status: t(statuses[value] ?? 'daydream.unknown') })}</span>; }
export function DaydreamRuns({ runs, busy, act }: {
    runs: Run[];
    busy: boolean;
    act: (path: string, body: unknown) => void;
}) {
    const { t } = useI18n();
    return <section><h4>{t('daydream.runs')}</h4>{runs.length === 0 && <p>{t('daydream.emptyRuns')}</p>}<ul className={styles.list}>{runs.map(run => <li key={run.id}><details className={styles.card}><summary>{run.logicalDate} · <Status value={run.status}/></summary><p>{run.summary || t('daydream.outputCount',{count:run.outputs?.length??0})}</p><RunOutputs runId={run.id} outputs={run.outputs ?? []} busy={busy} act={act}/></details></li>)}</ul></section>;
}
function RunOutputs({ runId, outputs, busy, act }: {
    runId: string;
    outputs: Output[];
    busy: boolean;
    act: (path: string, body: unknown) => void;
}) { return <ul>{outputs.map((output, index) => <RunOutput key={index} output={output} busy={busy} review={accept => act(`/runs/${encodeURIComponent(runId)}/outputs/${index}/review`, { accept })}/>)}</ul>; }
function RunOutput({ output, busy, review }: {
    output: Output;
    busy: boolean;
    review: (accept: boolean) => void;
}) { const { t } = useI18n(); return <li><strong>{t(output.kind === 'skill' ? 'daydream.outputSkill' : 'daydream.outputMemory')}</strong> · <Status value={output.status}/><p>{output.summary}</p><EvidenceList refs={output.evidenceRefs ?? []}/><OutputActions output={output} busy={busy} review={review}/></li>; }
function EvidenceList({ refs }: {
    refs: NonNullable<Output['evidenceRefs']>;
}) { const { t } = useI18n(); return <div aria-label={t('daydream.evidence')}>{refs.map((ref, i) => <p key={i}>{t('daydream.sources', { session: ref.sessionId, message: ref.messageId ?? String(ref.seq ?? '') })}</p>)}</div>; }
export function DaydreamKnowledge({ knowledge, busy, act }: {
    knowledge: Knowledge;
    busy: boolean;
    act: (path: string, body: unknown) => void;
}) {
    const { t } = useI18n();
    return <section><h4>{t('daydream.candidates')}</h4>{knowledge.canGovern && <button type="button" disabled={busy} onClick={() => act('/knowledge/govern', {})}>{t('daydream.govern')}</button>}{knowledge.submissions.length === 0 && <p>{t('daydream.emptyCandidates')}</p>}<ul className={styles.list}>{knowledge.submissions.map(sub => <li key={sub.id} className={styles.card}><p>{sub.summary}</p><p>{sub.reason}</p><ReviewRecommendation reason={sub.reviewDecision?.reason}/><Status value={sub.status}/><Decision sub={sub} allowed={knowledge.canGovern} busy={busy} act={act}/></li>)}</ul><KnowledgeFeedback items={knowledge.feedback??[]} busy={busy} act={act}/><KnowledgeArtifacts items={knowledge.artifacts} canGovern={knowledge.canGovern} evidence={knowledge.evidenceOptions??[]} busy={busy} act={act}/></section>;
}
function Decision({ sub, allowed, busy, act }: {
    sub: Submission;
    allowed: boolean;
    busy: boolean;
    act: (path: string, body: unknown) => void;
}) {
    const { t } = useI18n();
    if (!allowed)
        return null;
    if (sub.status !== 'pending')
        return null;
    return <div className={styles.actions}>{(['accept', 'reject', 'defer'] as const).map(decision => <button type="button" key={decision} disabled={busy} onClick={() => act(`/knowledge/${encodeURIComponent(sub.id)}/decision`, { decision })}>{t(`daydream.${decision}`)}</button>)}</div>;
}

function OutputActions({output,busy,review}:{output:Output;busy:boolean;review:(accept:boolean)=>void}) {
 const {t}=useI18n();
 if(output.status!=='pending')return null;
 if(output.kind==='memory' && output.conflict)return <div><p>{t('daydream.memoryConflict')}</p><a href="#/knowledge/memory">{t('daydream.resolveMemory')}</a><button type="button" disabled={busy} onClick={()=>review(false)}>{t('daydream.reject')}</button></div>;
 return <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>review(true)}>{t('daydream.accept')}</button><button type="button" disabled={busy} onClick={()=>review(false)}>{t('daydream.reject')}</button></div>;
}
