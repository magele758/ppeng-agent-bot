'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import './skill-capture.css';
import { BotSkillSharing, useSkillBots } from './BotSkillSharing';

type Capture = {
  id: string;
  ownerBotId?: string;
  sharedBotIds?: string[];
  name: string;
  description: string;
  reason: string;
  summary: string;
  kind: 'new' | 'update';
  status: 'pending' | 'processing' | 'saved' | 'rejected' | 'failed';
  error?: string;
};

export function SkillCaptureCards({ sessionId, onLayoutChange }: { sessionId: string; onLayoutChange?: () => void }) {
  const { t } = useI18n();
  const bots = useSkillBots();
  const dismissalKey = 'lab.skillCaptureDismissed.' + sessionId;
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(dismissalKey) ?? '[]');
      setDismissed(new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []));
    } catch { setDismissed(new Set()); }
    setExpanded(new Set());
    setStorageError(false);
  }, [dismissalKey]);
  const dismissalFocus = useRef<HTMLElement | null>(null);
  function dismiss(id: string, button: HTMLButtonElement) {
    const card = button.closest<HTMLElement>('.skill-capture-card');
    dismissalFocus.current = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null;
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    try {
      localStorage.setItem(dismissalKey, JSON.stringify([...next]));
      setStorageError(false);
    } catch { setStorageError(true); }
  }
  const [sharing, setSharing] = useState<Record<string, string[]>>({});
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pending = useRef(new Set<string>());
  const alive = useRef(true);
  const endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/skill-captures`;
  const layoutCallback = useRef(onLayoutChange);
  layoutCallback.current = onLayoutChange;
  useLayoutEffect(() => {
    layoutCallback.current?.();
    if (dismissalFocus.current?.isConnected) {
      dismissalFocus.current.focus({ preventScroll: true });
      dismissalFocus.current.scrollIntoView({ block: 'nearest' });
    }
    dismissalFocus.current = null;
  }, [captures, busy, errors, dismissed, expanded]);
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await api(endpoint) as { captures: Capture[] };
        if (!disposed) setCaptures(current => JSON.stringify(current) === JSON.stringify(data.captures) ? current : data.captures);
      } catch {
        // Existing daemon versions may not expose this optional panel yet.
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => { disposed = true; alive.current = false; clearTimeout(timer); };
  }, [endpoint]);

  async function decide(capture: Capture, action: 'confirm' | 'reject') {
    if (pending.current.has(capture.id)) return;
    pending.current.add(capture.id);
    setBusy(new Set(pending.current));
    setErrors(current => ({ ...current, [capture.id]: '' }));
    try {
      const result = await api(`${endpoint}/${encodeURIComponent(capture.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'confirm' && capture.ownerBotId ? { sharedBotIds: sharing[capture.id] ?? capture.sharedBotIds ?? [] } : {}) }) as { capture: Capture };
      if (alive.current) setCaptures(current => current.map(row => row.id === capture.id ? result.capture : row));
    } catch (error) {
      if (alive.current) setErrors(current => ({ ...current, [capture.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      pending.current.delete(capture.id);
      if (alive.current) setBusy(new Set(pending.current));
    }
  }

  return <div className="skill-capture-list">
    {storageError && <p role="status">{t('skillProposals.captureDismissStorageError')}</p>}
    {captures.filter(capture => capture.status !== 'saved' || !dismissed.has(capture.id)).map(capture => {
      const saved = capture.status === 'saved';
      const detailsOpen = !saved || expanded.has(capture.id);
      const working = capture.status === 'processing' || busy.has(capture.id);
      return <section key={capture.id} className="skill-capture-card" tabIndex={-1} role="dialog" aria-modal="false" aria-label={t('skillProposals.captureTitle')} data-testid={`skill-capture-${capture.id}`}>
        <header><strong>{t('skillProposals.captureTitle')}</strong><span>{t(capture.kind === 'update' ? 'skillProposals.kindUpdate' : 'skillProposals.kindNew')}</span></header>
        <h4>{capture.name}</h4>
        <div id={`capture-details-${capture.id}`} hidden={!detailsOpen}>
        <p>{capture.description}</p>
        <p>{capture.ownerBotId ? t('skillProposals.ownerBot', { name: bots.find(b => b.id === capture.ownerBotId)?.name ?? capture.ownerBotId }) : t('skillProposals.legacyShared')}</p>
        <dl>
          <dt>{t('skillProposals.captureReason')}</dt><dd>{capture.reason}</dd>
          <dt>{t('skillProposals.captureSummary')}</dt><dd>{capture.summary}</dd>
        </dl>
        </div>
        {capture.status === 'pending' && !working ? <>
          {capture.ownerBotId && <BotSkillSharing bots={bots} owner={capture.ownerBotId} selected={sharing[capture.id] ?? capture.sharedBotIds ?? []} onChange={ids => setSharing(current => ({ ...current, [capture.id]: ids }))} />}
          <p className="muted">{t('skillProposals.captureHint')}</p>
          <div className="skill-capture-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void decide(capture, 'confirm')}>{t('skillProposals.captureConfirm')}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => void decide(capture, 'reject')}>{t('skillProposals.reject')}</button>
          </div>
        </> : <p role="status">{t(working ? 'skillProposals.captureProcessing' : capture.status === 'saved' ? 'skillProposals.captureSaved' : capture.status === 'rejected' ? 'skillProposals.captureRejected' : 'skillProposals.captureFailed')}</p>}
        {saved && <div className="skill-capture-actions">
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={detailsOpen} aria-controls={`capture-details-${capture.id}`} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(capture.id)) next.delete(capture.id); else next.add(capture.id); return next; })}>{t(detailsOpen ? 'skillProposals.captureCollapse' : 'skillProposals.captureExpand')}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={event => dismiss(capture.id, event.currentTarget)}>{t('skillProposals.captureDismiss')}</button>
        </div>}
        {capture.error || errors[capture.id] ? <p role="alert">{capture.error || errors[capture.id]}</p> : null}
      </section>;
    })}
  </div>;
}
