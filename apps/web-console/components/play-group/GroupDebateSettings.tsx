'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { groupReplyRoomPath } from '@/lib/group-reply-mode';
import {
  DEBATE_MAX_ROUNDS,
  DEBATE_STANCE_MAX_CHARS,
  debateDraftFromRoom,
  debateDraftIssue,
  debateDraftReplies,
  debateSaveInit,
  effectiveDebateJudge,
  moveDebateRow,
  patchDebateRow,
  readDebateConfig,
  setDebateJudge,
  type DebateDraft,
  type DebateDraftIssue,
  type DebateDraftRow
} from '@/lib/group-debate';
import { useI18n, type MessageKey } from '@/lib/i18n';
import './play-group.css';

export interface DebateRoom { id: string; botIds: string[]; hostBotId: string; debate?: unknown }

const ISSUE_KEYS: Record<DebateDraftIssue, MessageKey> = {
  need_two: 'play.groupSettings.debateNeedTwo',
  too_many: 'play.groupSettings.debateTooMany',
  too_long: 'play.groupSettings.debateTooLong',
  rounds: 'play.groupSettings.debateRoundsRange'
};

const DEFAULT_STANCE_KEYS: readonly MessageKey[] = ['play.groupSettings.debateStancePro', 'play.groupSettings.debateStanceCon'];

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

const SAVE_STATE_KEYS: Record<SaveState, MessageKey | null> = {
  idle: null,
  saving: 'play.groupSettings.debateSaving',
  saved: 'play.groupSettings.saved',
  failed: 'play.groupSettings.debateSaveFailed'
};

function DebateSaveStatus({ state, error }: { state: SaveState; error: string }) {
  const { t } = useI18n();
  const key = SAVE_STATE_KEYS[state];
  if (!key) return null;
  return <span role="status" data-testid="group-debate-save-state">{[t(key), error].filter(Boolean).join(' ')}</span>;
}

function DebateRow({ row, order, name, last, onChange, onMove }: {
  row: DebateDraftRow;
  /** Position among the members who debate, or -1 when this member sits out. */
  order: number;
  name: string;
  last: boolean;
  onChange: (patch: Partial<Pick<DebateDraftRow, 'joined' | 'stance'>>) => void;
  onMove: (offset: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const placeholder = t(DEFAULT_STANCE_KEYS[Math.max(order, 0) % DEFAULT_STANCE_KEYS.length]!);
  return (
    <li className="play-group-debate__row" data-testid={`group-debate-row-${row.botId}`}>
      <label className="play-group-debate__join">
        <input type="checkbox" checked={row.joined} onChange={event => onChange({ joined: event.target.checked })} />
        <span>{name}</span>
      </label>
      <input
        type="text"
        className="play-group-debate__stance"
        aria-label={t('play.groupSettings.debateStanceOf', { name })}
        placeholder={placeholder}
        maxLength={DEBATE_STANCE_MAX_CHARS}
        disabled={!row.joined}
        value={row.stance}
        onChange={event => onChange({ stance: event.target.value })}
      />
      <button type="button" aria-label={t('play.groupSettings.debateMoveUp', { name })} disabled={order <= 0} onClick={() => onMove(-1)}>↑</button>
      <button type="button" aria-label={t('play.groupSettings.debateMoveDown', { name })} disabled={last} onClick={() => onMove(1)}>↓</button>
    </li>
  );
}

/** Rounds, sides in speaking order, stances, and the judge. Saved on the room with its own button. */
export function GroupDebateSettings({ room, names }: { room: DebateRoom; names: ReadonlyMap<string, string> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<DebateDraft>(() => debateDraftFromRoom(readDebateConfig(room), room.botIds, room.hostBotId));
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const edit = (next: DebateDraft) => { setDraft(next); setState('idle'); };
  const nameOf = (id: string) => names.get(id) ?? id;
  const issue = debateDraftIssue(draft);
  const judge = effectiveDebateJudge(draft, room.hostBotId);
  const joined = draft.rows.filter(row => row.joined);
  const save = async () => {
    setState('saving');
    setError('');
    try {
      await api(groupReplyRoomPath(room.id), debateSaveInit(draft));
      setState('saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState('failed');
    }
  };

  return (
    <div className="play-group-debate" data-testid="group-debate-settings">
      <h4>{t('play.groupSettings.debateSettings')}</h4>
      <p className="play-group-reply-mode__note">{t('play.groupSettings.debateSettingsHint')}</p>
      <label className="play-group-debate__field">
        <span>{t('play.groupSettings.debateRounds')}</span>
        <input
          type="number"
          data-testid="group-debate-rounds"
          min={1}
          max={DEBATE_MAX_ROUNDS}
          value={draft.rounds}
          onChange={event => edit({ ...draft, rounds: Number(event.target.value) })}
        />
      </label>
      <label className="play-group-debate__field">
        <span>{t('play.groupSettings.debateJudge')}</span>
        <select data-testid="group-debate-judge" value={draft.judge} onChange={event => edit(setDebateJudge(draft, event.target.value))}>
          <option value="default">{t('play.groupSettings.debateJudgeDefault')}</option>
          <option value="none">{t('play.groupSettings.debateJudgeNone')}</option>
          {room.botIds.map(id => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select>
      </label>
      <p className="play-group-debate__legend">{t('play.groupSettings.debateParticipants')}</p>
      <ol className="play-group-debate__rows">
        {draft.rows.map((row, index) => (
          <DebateRow
            key={row.botId}
            row={row}
            order={row.joined ? joined.indexOf(row) : -1}
            name={nameOf(row.botId)}
            last={index === draft.rows.length - 1}
            onChange={patch => edit(patchDebateRow(draft, row.botId, patch))}
            onMove={offset => edit(moveDebateRow(draft, row.botId, offset))}
          />
        ))}
      </ol>
      <p className="play-group-reply-mode__note" data-testid="group-debate-summary">
        {t(judge ? 'play.groupSettings.debateSummaryJudge' : 'play.groupSettings.debateSummaryNoJudge', { count: debateDraftReplies(draft, room.hostBotId), judge: nameOf(judge) })}
      </p>
      {issue ? <p role="alert" className="play-group-reply-mode__error" data-testid="group-debate-issue">{t(ISSUE_KEYS[issue])}</p> : null}
      <div className="play-group-debate__save">
        <button type="button" data-testid="group-debate-save" disabled={issue !== null || state === 'saving'} onClick={() => void save()}>{t('play.groupSettings.debateSave')}</button>
        <DebateSaveStatus state={state} error={error} />
      </div>
    </div>
  );
}
