'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { botForCanonicalSession } from '@/lib/bots';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import styles from './BotFunctionalGroups.module.css';
import { BotEntryDialog } from './BotEntryDialog';

type FunctionalGroup = { id: string; name: string; botIds: string[] };
const BOT_DRAG = 'application/x-agent-home-bot';

export function BotFunctionalGroups({ bots, sessions, renderSession, createRequest = 0 }: {
  createRequest?: number;
  bots: readonly BotInfo[];
  sessions: readonly SessionSummary[];
  renderSession: (session: SessionSummary) => ReactNode;
}) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<FunctionalGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (createRequest) { setError(''); setEditing({ name: '' }); } }, [createRequest]);

  useEffect(() => {
    let alive = true;
    void api('/api/bot-functional-groups').then((data) => {
      if (!alive) return;
      setGroups((data as { groups: FunctionalGroup[] }).groups);
      setLoaded(true);
      setError('');
    }).catch((cause: unknown) => {
      if (alive) setError(t('play.functionalGroups.failed', { error: String(cause instanceof Error ? cause.message : cause) }));
    });
    return () => { alive = false; };
  }, [retry, t]);

  const fail = (cause: unknown) => setError(t('play.functionalGroups.failed', {
    error: cause instanceof Error ? cause.message : String(cause)
  }));

  const save = async () => {
    if (!editing?.name.trim() || pending) return;
    setPending(true);
    setError('');
    try {
      const { group } = await api(`/api/bot-functional-groups${editing.id ? `/${encodeURIComponent(editing.id)}` : ''}`, {
        method: editing.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editing.name.trim() })
      }) as { group: FunctionalGroup };
      setGroups((previous) => editing.id ? previous.map((g) => g.id === group.id ? group : g) : [...previous, group]);
      setEditing(null);
    } catch (cause) { fail(cause); }
    finally { setPending(false); }
  };

  const remove = async (group: FunctionalGroup) => {
    if (pending || !window.confirm(t('play.functionalGroups.deleteConfirm', { name: group.name }))) return;
    setPending(true);
    setError('');
    try {
      await api(`/api/bot-functional-groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      setGroups((previous) => previous.filter((g) => g.id !== group.id));
    } catch (cause) { fail(cause); }
    finally { setPending(false); }
  };

  const move = async (botId: string, groupId: string | null) => {
    if (pending || !bots.some((b) => b.id === botId)) return;
    const previous = groups;
    const currentGroup = groups.find((g) => g.botIds.includes(botId))?.id ?? null;
    if (currentGroup === groupId) return;
    setPending(true);
    setError('');
    setGroups(groups.map((g) => ({ ...g, botIds: [...g.botIds.filter((id) => id !== botId), ...(g.id === groupId ? [botId] : [])] })));
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/functional-group`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId })
      });
    } catch (cause) { setGroups(previous); fail(cause); }
    finally { setPending(false); }
  };

  const section = (group: FunctionalGroup | null) => {
    const groupId = group?.id ?? null;
    const rows = sessions.filter((session) => {
      const bot = botForCanonicalSession(bots, session.id, sessions);
      if (bot?.hidden) return false;
      const assigned = bot ? groups.find((g) => g.botIds.includes(bot.id))?.id ?? null : null;
      return assigned === groupId;
    });
    return <section key={groupId ?? 'ungrouped'} data-testid={`functional-group-${groupId ?? 'ungrouped'}`}
      className={`${styles.group} ${dragTarget === groupId ? styles.dropTarget : ''}`}
      aria-busy={pending}
      onDragOver={(event) => { if (pending || !event.dataTransfer.types.includes(BOT_DRAG)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragTarget(groupId); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(undefined); }}
      onDrop={(event) => { event.preventDefault(); setDragTarget(undefined); void move(event.dataTransfer.getData(BOT_DRAG), groupId); }}>
      <div className={styles.heading}>
        <h3>{group?.name ?? t('play.functionalGroups.ungrouped')}</h3>
        <span className={styles.count}>{rows.length}</span>
        {group ? <>
          <button className="btn btn-ghost btn-sm" disabled={pending} aria-label={t('play.functionalGroups.rename')} title={t('play.functionalGroups.rename')}
            onClick={() => setEditing({ id: group.id, name: group.name })}>{t('play.functionalGroups.renameShort')}</button>
          <button className="btn btn-ghost btn-sm" disabled={pending} aria-label={t('play.functionalGroups.delete')} title={t('play.functionalGroups.delete')}
            onClick={() => { void remove(group); }}>{t('play.functionalGroups.deleteShort')}</button>
        </> : null}
      </div>
      {rows.map((session) => {
        const bot = botForCanonicalSession(bots, session.id, sessions);
        return <div key={session.id} draggable={!!bot && !pending} className={styles.draggable}
          onDragStart={(event) => { if (!bot || pending) { event.preventDefault(); return; } event.dataTransfer.setData(BOT_DRAG, bot.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => setDragTarget(undefined)}>
          {renderSession(session)}
        </div>;
      })}
      {!rows.length ? <div className={styles.empty}>{t('play.functionalGroups.dropHint')}</div> : null}
    </section>;
  };

  return <div className={styles.root}>
    <div className={styles.toolbar}>
      <span>{t('play.functionalGroups.title')}</span>

    </div>
    {error ? <div role="alert" className={styles.error}>{error}{!loaded ? <button className="btn btn-ghost btn-sm" onClick={() => setRetry((n) => n + 1)}>{t('play.functionalGroups.retry')}</button> : null}</div> : null}
    {editing ? <BotEntryDialog label={editing.id ? t('play.functionalGroups.rename') : t('play.functionalGroups.create')}><form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{t('play.functionalGroups.name')}<input required autoFocus value={editing.name} disabled={pending} maxLength={80} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <button type="submit" className="btn btn-sm" disabled={pending || !editing.name.trim()} aria-label={t('play.functionalGroups.save')}>{t('common.save')}</button>
      <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setEditing(null)}>{t('common.cancel')}</button>
      {error ? <p role="alert">{error}</p> : null}
    </form></BotEntryDialog> : null}
    {loaded ? <>{groups.map((g) => section(g))}{section(null)}<SharedFacts groups={groups} /></> : null}
  </div>;
}

function SharedFacts({ groups }: { groups: FunctionalGroup[] }) {
  const { t } = useI18n();
  const [scope, setScope] = useState('global');
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const path = scope === 'global' ? '/api/bot-shared-context?scope=global' : `/api/bot-shared-context?scope=group&id=${encodeURIComponent(scope)}`;
  const ready = loadedPath === path;
  useEffect(() => { if (scope !== 'global' && !groups.some((g) => g.id === scope)) setScope('global'); }, [groups, scope]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setError(''); setSaved(false); setRows([]); setLoadedPath(null);
    void api(path).then((data) => { if (alive) { setRows(Object.entries((data as { entries: Record<string, string> }).entries).map(([key, value]) => ({ key, value }))); setLoadedPath(path); } })
      .catch((cause: unknown) => { if (alive) setError(String(cause)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [path, open, retry]);
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const entries = Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));
      await api(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
      setSaved(true);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <details className={styles.shared} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t('play.functionalGroups.sharedTitle')}</summary>
    <p>{t('play.functionalGroups.sharedHint')}</p>
    <label>{t('play.functionalGroups.sharedScope')}<select aria-label={t('play.functionalGroups.sharedScope')} value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}>
      <option value="global">{t('play.functionalGroups.global')}</option>{groups.map((g) => <option value={g.id} key={g.id}>{g.name}</option>)}
    </select></label>
    {rows.map((row, index) => <div className={styles.fact} key={index}>
      <input aria-label={t('play.functionalGroups.factName', { index: index + 1 })} placeholder={t('play.functionalGroups.factNameHint')} value={row.key} disabled={busy || !ready} onChange={(event) => { setSaved(false); setRows(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r)); }} />
      <input aria-label={t('play.functionalGroups.factValue', { index: index + 1 })} placeholder={t('play.functionalGroups.factValueHint')} value={row.value} disabled={busy || !ready} onChange={(event) => { setSaved(false); setRows(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r)); }} />
      <button className="btn btn-ghost btn-sm" disabled={busy || !ready} aria-label={t('play.functionalGroups.removeFact', { index: index + 1 })} onClick={() => { setSaved(false); setRows(rows.filter((_, i) => i !== index)); }}>×</button>
    </div>)}
    <button className="btn btn-ghost btn-sm" disabled={busy || !ready} onClick={() => { setSaved(false); setRows([...rows, { key: '', value: '' }]); }}>{t('play.functionalGroups.addFact')}</button>
    <button className="btn btn-sm" disabled={busy || !ready || rows.some((r) => !r.key.trim()) || new Set(rows.map((r) => r.key.trim())).size !== rows.length} onClick={() => { void save(); }}>{t('play.functionalGroups.saveShared')}</button>
    {error ? <p role="alert">{t('play.functionalGroups.failed', { error })}{!ready ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRetry((n) => n + 1)}>{t('play.functionalGroups.retry')}</button> : null}</p> : null}
    {saved ? <p role="status">{t('play.functionalGroups.saved')}</p> : null}
  </details>;
}
