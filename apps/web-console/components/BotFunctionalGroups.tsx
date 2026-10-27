'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react';
import type { BotInfo, SessionSummary } from '@/lib/types';
import { botForCanonicalSession } from '@/lib/bots';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import styles from './BotFunctionalGroups.module.css';
import { BotEntryDialog } from './BotEntryDialog';

import { displayPinnedRoomIds } from '@/lib/bot-pin';
import { arrangeSidebarRows, beginSidebarDrag, BOT_DRAG_MIME, commitBotPinState, commitRegionOrder, currentSidebarDrag, dropPlace, endSidebarDrag, forgetRegionRef, getBotPinServerSnapshot, getBotPinSnapshot, groupRowsWithoutPinnedBots, moveSidebarItem, orderRegionKey, regionRefs, ROOM_DRAG_MIME, sameOrderRegion, savedRegionRefs, sortBotRows, subscribeBotPins, type OrderRegion } from '@/lib/bot-pin-area';
import { canMoveBot, canMoveRoom, factEditorState, functionalGroupRows, functionalGroupPresentation, FUNCTIONAL_GROUPS_CHANGED_EVENT, groupForBot, groupSaveDisabled, functionalGroupSaveRequest, moveBotInGroups, moveRoomInGroups, roomsInGroup, upsertFunctionalGroup, type FunctionalGroup } from '@/lib/functional-group-view';
import { PlayGroupRow, deletePlayRoom, type SidebarRoom } from './play-group/PlayBotGroupList';

function publishFunctionalGroups(groups: FunctionalGroup[]) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FUNCTIONAL_GROUPS_CHANGED_EVENT, { detail: groups }));
}

function withRoomIds(groups: FunctionalGroup[]): FunctionalGroup[] {
  return groups.map((group) => ({ ...group, roomIds: group.roomIds ?? [] }));
}

export function BotFunctionalGroups({ bots, sessions, rooms = [], renderSession, createRequest = 0, selectedRoomId = null, onOpenRoom, onRoomDeleted }: {
  createRequest?: number;
  bots: readonly BotInfo[];
  sessions: readonly SessionSummary[];
  rooms?: readonly SidebarRoom[];
  renderSession: (session: SessionSummary) => ReactNode;
  selectedRoomId?: string | null;
  onOpenRoom?: (roomId: string) => void;
  onRoomDeleted?: (roomId: string) => void;
}) {
  const { t } = useI18n();
  const pinState = useSyncExternalStore(subscribeBotPins, getBotPinSnapshot, getBotPinServerSnapshot);
  const [groups, setGroups] = useState<FunctionalGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<{ id?: string; name: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null | undefined>(undefined);
  const [insert, setInsert] = useState<string | null>(null);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (createRequest) { setError(''); setEditing({ name: '' }); } }, [createRequest]);

  useEffect(() => {
    let alive = true;
    void api('/api/bot-functional-groups').then((data) => {
      if (!alive) return;
      const next = withRoomIds((data as { groups: FunctionalGroup[] }).groups ?? []);
      setGroups(next);
      publishFunctionalGroups(next);
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
      setGroups((previous) => {
        const next = upsertFunctionalGroup(previous, group);
        publishFunctionalGroups(next);
        return next;
      });
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
      setGroups((previous) => {
        const next = previous.filter((g) => g.id !== group.id);
        publishFunctionalGroups(next);
        return next;
      });
    } catch (cause) { fail(cause); }
    finally { setPending(false); }
  };

  const move = async (botId: string, groupId: string | null) => {
    if (!canMoveBot(groups, bots, pending, botId, groupId)) return;
    const previous = groups;
    const previousPins = getBotPinSnapshot();
    const source = groupForBot(groups, botId);
    setPending(true);
    setError('');
    const next = moveBotInGroups(groups, botId, groupId);
    setGroups(next);
    publishFunctionalGroups(next);
    const forgotten = forgetRegionRef(previousPins, source ? { type: 'group', id: source } : { type: 'ungrouped' }, { kind: 'bot', id: botId });
    if (forgotten !== previousPins) commitBotPinState(forgotten);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/functional-group`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId })
      });
    } catch (cause) {
      setGroups(previous);
      publishFunctionalGroups(previous);
      if (forgotten !== previousPins) commitBotPinState(previousPins);
      fail(cause);
    }
    finally { setPending(false); }
  };

  const moveRoom = async (roomId: string, groupId: string | null) => {
    if (!canMoveRoom(groups, rooms, pending, roomId, groupId)) return;
    const previous = groups;
    const previousPins = getBotPinSnapshot();
    const source = groups.find((item) => (item.roomIds ?? []).includes(roomId))?.id ?? null;
    const next = moveRoomInGroups(groups, roomId, groupId);
    setPending(true);
    setError('');
    setGroups(next);
    publishFunctionalGroups(next);
    const forgotten = forgetRegionRef(
      previousPins,
      source ? { type: 'group', id: source } : { type: 'looseRooms' },
      { kind: 'room', id: roomId }
    );
    if (forgotten !== previousPins) commitBotPinState(forgotten);
    try {
      await api(`/api/bot-rooms/${encodeURIComponent(roomId)}/functional-group`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId })
      });
    } catch (cause) {
      setGroups(previous);
      publishFunctionalGroups(previous);
      if (forgotten !== previousPins) commitBotPinState(previousPins);
      fail(cause);
    }
    finally { setPending(false); }
  };

  const removeRoom = (room: SidebarRoom) => {
    setError('');
    void deletePlayRoom(room, t, deletingRoomId, setDeletingRoomId).then((result) => {
      if (result === 'failed') setError(t('play.group.deleteFailed'));
      if (result === 'deleted') onRoomDeleted?.(room.id);
    });
  };

  const section = (group: FunctionalGroup | null) => {
    const presentation = functionalGroupPresentation(group, t('play.functionalGroups.ungrouped'));
    const groupId = presentation.id;
    const region: OrderRegion = groupId ? { type: 'group', id: groupId } : { type: 'ungrouped' };
    const rows = groupRowsWithoutPinnedBots(functionalGroupRows(groups, bots, sessions, groupId), bots, sessions, pinState);
    const pinnedRoomIds = displayPinnedRoomIds(rooms, pinState);
    const roomRows = roomsInGroup(rooms, group, pinnedRoomIds);
    const nameOf = (id: string) => bots.find((bot) => bot.id === id)?.name ?? id;
    const ordered = arrangeSidebarRows(
      sortBotRows(rows.map((session) => {
        const bot = botForCanonicalSession(bots, session.id, sessions);
        return {
          kind: 'bot' as const,
          id: bot?.id ?? `session:${session.id}`,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          status: session.status,
          tie: session.id,
          value: session
        };
      })),
      roomRows.map((room) => ({ kind: 'room' as const, id: room.id, value: room })),
      savedRegionRefs(pinState, region)
    );
    const reorderOver = (event: DragEvent<HTMLDivElement>, kind: 'bot' | 'room', id: string) => {
      const drag = currentSidebarDrag();
      if (!drag || !sameOrderRegion(drag.region, region)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setInsert(`${orderRegionKey(region)}:${kind}:${id}:${dropPlace(event.clientY, rect.top, rect.height)}`);
    };
    const reorderDrop = (event: DragEvent<HTMLDivElement>, kind: 'bot' | 'room', id: string) => {
      const drag = currentSidebarDrag();
      if (!drag || !sameOrderRegion(drag.region, region)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      const next = moveSidebarItem(
        regionRefs(ordered),
        { kind: drag.kind, id: drag.id },
        { kind, id },
        dropPlace(event.clientY, rect.top, rect.height)
      );
      if (next) commitRegionOrder(pinState, region, next);
      setInsert(null);
      setDragTarget(undefined);
    };
    return <section key={presentation.key} data-testid={`functional-group-${presentation.key}`}
      className={`${styles.group} ${dragTarget === groupId ? styles.dropTarget : ''}`}
      aria-busy={pending}
      onDragOver={(event) => {
        if (pending) return;
        const drag = currentSidebarDrag();
        if (drag && sameOrderRegion(drag.region, region)) return;
        const types = event.dataTransfer.types;
        if (!types.includes(BOT_DRAG_MIME) && !types.includes(ROOM_DRAG_MIME)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDragTarget(groupId);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragTarget(undefined); }}
      onDrop={(event) => {
        const drag = currentSidebarDrag();
        if (drag && sameOrderRegion(drag.region, region)) return;
        event.preventDefault();
        setDragTarget(undefined);
        const roomId = event.dataTransfer.getData(ROOM_DRAG_MIME);
        if (roomId) { void moveRoom(roomId, groupId); return; }
        void move(event.dataTransfer.getData(BOT_DRAG_MIME), groupId);
      }}>
      <div className={styles.heading}>
        <h3>{presentation.name}</h3>
        <span className={styles.count}>{ordered.length}</span>
        {group ? <>
          <button className="btn btn-ghost btn-sm" disabled={pending} aria-label={t('play.functionalGroups.rename')} title={t('play.functionalGroups.rename')}
            onClick={() => setEditing({ id: group.id, name: group.name })}>{t('play.functionalGroups.renameShort')}</button>
          <button className="btn btn-ghost btn-sm" disabled={pending} aria-label={t('play.functionalGroups.delete')} title={t('play.functionalGroups.delete')}
            onClick={() => { void remove(group); }}>{t('play.functionalGroups.deleteShort')}</button>
        </> : null}
      </div>
      {ordered.map((entry) => {
        const placeKey = `${orderRegionKey(region)}:${entry.kind}:${entry.id}:`;
        const place = insert?.startsWith(placeKey) ? insert.slice(placeKey.length) : '';
        const insertClass = place === 'before' ? styles.insertBefore : place === 'after' ? styles.insertAfter : '';
        if (entry.kind === 'bot') {
          const session = entry.value;
          const bot = entry.id.startsWith('session:') ? undefined : botForCanonicalSession(bots, session.id, sessions);
          return <div key={session.id} draggable={!!bot && !pending}
            className={`${styles.draggable}${insertClass ? ` ${insertClass}` : ''}`}
            title={t('play.sidebar.reorder')}
            data-reorder-region={orderRegionKey(region)}
            data-bot-id={bot?.id} data-bot-name={bot?.name}
            onDragOver={(event) => reorderOver(event, 'bot', entry.id)}
            onDrop={(event) => reorderDrop(event, 'bot', entry.id)}
            onDragStart={(event) => {
              if (!bot || pending) { event.preventDefault(); return; }
              beginSidebarDrag({ kind: 'bot', id: bot.id, region });
              event.dataTransfer.setData(BOT_DRAG_MIME, bot.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => { endSidebarDrag(); setInsert(null); setDragTarget(undefined); }}>
            {renderSession(session)}
          </div>;
        }
        const room = entry.value;
        return (
          <div key={room.id} draggable={!pending}
            className={`${styles.draggable}${insertClass ? ` ${insertClass}` : ''}`}
            title={t('play.sidebar.reorder')}
            data-reorder-region={orderRegionKey(region)}
            data-room-id={room.id}
            onDragOver={(event) => reorderOver(event, 'room', room.id)}
            onDrop={(event) => reorderDrop(event, 'room', room.id)}
            onDragStart={(event) => {
              if (pending) { event.preventDefault(); return; }
              beginSidebarDrag({ kind: 'room', id: room.id, region });
              event.dataTransfer.setData(ROOM_DRAG_MIME, room.id);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => { endSidebarDrag(); setInsert(null); setDragTarget(undefined); }}>
            <PlayGroupRow
              room={room}
              names={room.botIds.map(nameOf).join('、')}
              selected={selectedRoomId === room.id}
              busy={deletingRoomId === room.id}
              disabled={deletingRoomId !== null || pending}
              placement="group"
              onOpen={() => onOpenRoom?.(room.id)}
              onDelete={() => removeRoom(room)}
            />
          </div>
        );
      })}
      {!ordered.length ? <div className={styles.empty}>{t('play.functionalGroups.dropHint')}</div> : null}
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
  const drafts = useRef(new Map<string, { key: string; value: string }[]>());
  const [scope, setScope] = useState('global');
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const path = scope === 'global' ? '/api/bot-shared-context?scope=global' : `/api/bot-shared-context?scope=group&id=${encodeURIComponent(scope)}`;
  const editRows = (next: { key: string; value: string }[]) => { drafts.current.set(path, next); setRows(next); };
  const ready = loadedPath === path;
  const controls = factEditorState(rows, busy, ready);
  useEffect(() => { if (scope !== 'global' && !groups.some((g) => g.id === scope)) setScope('global'); }, [groups, scope]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true); setError(''); setSaved(false); setRows([]); setLoadedPath(null);
    void api(path).then((data) => { if (alive) { setRows(drafts.current.get(path) ?? Object.entries((data as { entries: Record<string, string> }).entries).map(([key, value]) => ({ key, value }))); setLoadedPath(path); } })
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
      drafts.current.delete(path);
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
      <input aria-label={t('play.functionalGroups.factName', { index: index + 1 })} placeholder={t('play.functionalGroups.factNameHint')} value={row.key} disabled={controls.disabled} onChange={(event) => { setSaved(false); editRows(rows.map((r, i) => i === index ? { ...r, key: event.target.value } : r)); }} />
      <input aria-label={t('play.functionalGroups.factValue', { index: index + 1 })} placeholder={t('play.functionalGroups.factValueHint')} value={row.value} disabled={controls.disabled} onChange={(event) => { setSaved(false); editRows(rows.map((r, i) => i === index ? { ...r, value: event.target.value } : r)); }} />
      <button className="btn btn-ghost btn-sm" disabled={controls.disabled} aria-label={t('play.functionalGroups.removeFact', { index: index + 1 })} onClick={() => { setSaved(false); editRows(rows.filter((_, i) => i !== index)); }}>×</button>
    </div>)}
    <button className="btn btn-ghost btn-sm" disabled={controls.disabled} onClick={() => { setSaved(false); editRows([...rows, { key: '', value: '' }]); }}>{t('play.functionalGroups.addFact')}</button>
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
