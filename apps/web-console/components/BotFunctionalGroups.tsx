'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { botForCanonicalSession } from '@/lib/bots';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import styles from './BotFunctionalGroups.module.css';
import { BotEntryDialog } from './BotEntryDialog';

import { BOT_DRAG_MIME } from '@/lib/bot-pin-area';
import { canMoveBot, factEditorState, functionalGroupRows, functionalGroupPresentation, groupSaveDisabled, functionalGroupSaveRequest, moveBotInGroups, upsertFunctionalGroup, type FunctionalGroup } from '@/lib/functional-group-view';

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
    if (groupSaveDisabled(editing, pending)) return;
    if (!editing) return;
    setPending(true);
    setError('');
    try {
      const request = functionalGroupSaveRequest(editing);
      const { group } = await api(request.path, request.options) as { group: FunctionalGroup };
      setGroups((previous) => upsertFunctionalGroup(previous, group));
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
    if (!canMoveBot(groups, bots, pending, botId, groupId)) return;
    const previous = groups;
    setPending(true);
    setError('');
    setGroups(moveBotInGroups(groups, botId, groupId));
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/functional-group`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId })
      });
    } catch (cause) { setGroups(previous); fail(cause); }
    finally { setPending(false); }
  };

  const section = (group: FunctionalGroup | null) => {
    const presentation = functionalGroupPresentation(group, t('play.functionalGroups.ungrouped'));
    const groupId = presentation.id;
    const rows = functionalGroupRows(groups, bots, sessions, groupId);
    return <section key={presentation.key} data-testid={`functional-group-${presentation.key}`}
      className={`${styles.group} ${dragTarget === groupId ? styles.dropTarget : ''}`}
      aria-busy={pending}
      onDragOver={(event) => { if (pending || !event.dataTransfer.types.includes(BOT_DRAG_MIME)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragTarget(groupId); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(undefined); }}
      onDrop={(event) => { event.preventDefault(); setDragTarget(undefined); void move(event.dataTransfer.getData(BOT_DRAG_MIME), groupId); }}>
      <div className={styles.heading}>
        <h3>{presentation.name}</h3>
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
          data-bot-id={bot?.id} data-bot-name={bot?.name}
          onDragStart={(event) => { if (!bot || pending) { event.preventDefault(); return; } event.dataTransfer.setData(BOT_DRAG_MIME, bot.id); event.dataTransfer.effectAllowed = 'move'; }}
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
    <GroupLoadError error={error} loaded={loaded} retry={() => setRetry(n => n + 1)} />
    {editing ? <BotEntryDialog label={editing.id ? t('play.functionalGroups.rename') : t('play.functionalGroups.create')}><form className={styles.editor} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{t('play.functionalGroups.name')}<input required autoFocus value={editing.name} disabled={pending} maxLength={80} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
      <button type="submit" className="btn btn-sm" disabled={groupSaveDisabled(editing, pending)} aria-label={t('play.functionalGroups.save')}>{t('common.save')}</button>
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
  const controls = factEditorState(rows, busy, ready);
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
      <input aria-label={t('play.functionalGroups.factName', { index: index + 1 })} placeholder={t('play.functionalGroups.factNameHint')} value={row.key} disabled={controls.disabled} onChange={(event) => { setSaved(false); setRows(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r)); }} />
      <input aria-label={t('play.functionalGroups.factValue', { index: index + 1 })} placeholder={t('play.functionalGroups.factValueHint')} value={row.value} disabled={controls.disabled} onChange={(event) => { setSaved(false); setRows(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r)); }} />
      <button className="btn btn-ghost btn-sm" disabled={controls.disabled} aria-label={t('play.functionalGroups.removeFact', { index: index + 1 })} onClick={() => { setSaved(false); setRows(rows.filter((_, i) => i !== index)); }}>×</button>
    </div>)}
    <button className="btn btn-ghost btn-sm" disabled={controls.disabled} onClick={() => { setSaved(false); setRows([...rows, { key: '', value: '' }]); }}>{t('play.functionalGroups.addFact')}</button>
    <button className="btn btn-sm" disabled={controls.saveDisabled} onClick={() => { void save(); }}>{t('play.functionalGroups.saveShared')}</button>
    <GroupLoadError error={error && t('play.functionalGroups.failed', { error })} loaded={ready} busy={busy} retry={() => setRetry(n => n + 1)} />
    {saved ? <p role="status">{t('play.functionalGroups.saved')}</p> : null}
  </details>;
}

function GroupLoadError({ error, loaded, busy = false, retry }: { error: string; loaded: boolean; busy?: boolean; retry: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  return <div role="alert" className={styles.error}>{error}{!loaded ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={retry}>{t('play.functionalGroups.retry')}</button> : null}</div>;
}
