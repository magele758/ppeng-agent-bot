/** Debate reply mode: what the settings form edits and what the chat shows while a debate runs. No I/O. */

export const DEBATE_DEFAULT_ROUNDS = 3;
export const DEBATE_MAX_ROUNDS = 10;
export const DEBATE_MAX_PARTICIPANTS = 8;
export const DEBATE_MAX_SPEECHES = 40;
export const DEBATE_STANCE_MAX_CHARS = 60;

export interface DebateConfig {
  rounds?: number;
  participants?: { botId: string; stance?: string }[];
  judgeBotId?: string | null;
}

/** `default` lets the server pick the host; `none` runs without a judge; anything else is a member id. */
export type DebateJudgeChoice = 'default' | 'none' | string;

export interface DebateDraftRow { botId: string; joined: boolean; stance: string }
export interface DebateDraft { rounds: number; judge: DebateJudgeChoice; rows: DebateDraftRow[] }

export type DebateDraftIssue = 'need_two' | 'too_many' | 'too_long' | 'rounds';

export interface LiveDebate {
  rounds: number;
  participants: { botId: string; stance: string }[];
  judgeBotId?: string;
  speeches: number;
  step: number;
  verdictDone?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readParticipant(value: unknown): { botId: string; stance?: string } | null {
  if (!isRecord(value) || typeof value.botId !== 'string') return null;
  return typeof value.stance === 'string' ? { botId: value.botId, stance: value.stance } : { botId: value.botId };
}

function readJudge(value: unknown): { judgeBotId?: string | null } {
  if (value === null || typeof value === 'string') return { judgeBotId: value };
  return {};
}

/** Saved debate settings from a room payload. Anything unreadable is treated as not saved. */
export function readDebateConfig(room: unknown): DebateConfig {
  const raw = isRecord(room) ? room.debate : undefined;
  if (!isRecord(raw)) return {};
  const participants = Array.isArray(raw.participants)
    ? raw.participants.map(readParticipant).filter((item): item is { botId: string; stance?: string } => item !== null)
    : [];
  return {
    ...(typeof raw.rounds === 'number' ? { rounds: raw.rounds } : {}),
    ...(participants.length ? { participants } : {}),
    ...readJudge(raw.judgeBotId)
  };
}

function judgeChoice(config: DebateConfig, botIds: readonly string[]): DebateJudgeChoice {
  if (config.judgeBotId === null) return 'none';
  return config.judgeBotId && botIds.includes(config.judgeBotId) ? config.judgeBotId : 'default';
}

/** The member who judges for this draft, or '' when nobody does. Mirrors the server default. */
export function effectiveDebateJudge(draft: Pick<DebateDraft, 'judge' | 'rows'>, hostBotId: string): string {
  if (draft.judge === 'none') return '';
  if (draft.judge !== 'default') return draft.judge;
  const others = draft.rows.filter(row => row.joined && row.botId !== hostBotId).length;
  const hostJoined = draft.rows.some(row => row.joined && row.botId === hostBotId);
  return !hostJoined && others >= 2 ? hostBotId : '';
}

/** Form state for a room: saved debaters first in their order, then the remaining members. */
export function debateDraftFromRoom(config: DebateConfig, botIds: readonly string[], hostBotId: string): DebateDraft {
  const saved = (config.participants ?? []).filter(item => botIds.includes(item.botId));
  const judge = judgeChoice(config, botIds);
  const explicit = saved.length >= 2;
  const savedIds = new Set(saved.map(item => item.botId));
  // Without a saved list everyone debates, except the judge when at least two others remain.
  const defaultJudge = judge === 'none' ? '' : judge === 'default' ? (botIds.length >= 3 ? hostBotId : '') : judge;
  const rows: DebateDraftRow[] = explicit
    ? [
        ...saved.map(item => ({ botId: item.botId, joined: true, stance: item.stance ?? '' })),
        ...botIds.filter(id => !savedIds.has(id)).map(botId => ({ botId, joined: false, stance: '' }))
      ]
    : botIds.map(botId => ({ botId, joined: botId !== defaultJudge, stance: '' }));
  const rounds = Number.isInteger(config.rounds) ? Math.min(Math.max(config.rounds as number, 1), DEBATE_MAX_ROUNDS) : DEBATE_DEFAULT_ROUNDS;
  return { rounds, judge, rows };
}

export function moveDebateRow(draft: DebateDraft, botId: string, offset: -1 | 1): DebateDraft {
  const from = draft.rows.findIndex(row => row.botId === botId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= draft.rows.length) return draft;
  const rows = [...draft.rows];
  [rows[from], rows[to]] = [rows[to]!, rows[from]!];
  return { ...draft, rows };
}

export function patchDebateRow(draft: DebateDraft, botId: string, patch: Partial<Pick<DebateDraftRow, 'joined' | 'stance'>>): DebateDraft {
  const rows = draft.rows.map(row => (row.botId === botId ? { ...row, ...patch } : row));
  // A member put on a side stops being the judge.
  const judge = patch.joined === true && draft.judge === botId ? 'default' : draft.judge;
  return { ...draft, rows, judge };
}

/** Choosing a member as judge takes that member off the sides. */
export function setDebateJudge(draft: DebateDraft, judge: DebateJudgeChoice): DebateDraft {
  const rows = draft.rows.map(row => (row.botId === judge ? { ...row, joined: false } : row));
  return { ...draft, judge, rows };
}

export function debateDraftIssue(draft: DebateDraft): DebateDraftIssue | null {
  const joined = draft.rows.filter(row => row.joined).length;
  if (!Number.isInteger(draft.rounds) || draft.rounds < 1 || draft.rounds > DEBATE_MAX_ROUNDS) return 'rounds';
  if (joined < 2) return 'need_two';
  if (joined > DEBATE_MAX_PARTICIPANTS) return 'too_many';
  return draft.rounds * joined > DEBATE_MAX_SPEECHES ? 'too_long' : null;
}

/** Debater speeches plus the verdict, for the hint under the form. */
export function debateDraftReplies(draft: DebateDraft, hostBotId: string): number {
  const joined = draft.rows.filter(row => row.joined).length;
  return draft.rounds * joined + (effectiveDebateJudge(draft, hostBotId) ? 1 : 0);
}

function judgePayload(judge: DebateJudgeChoice): { judgeBotId?: string | null } {
  if (judge === 'default') return {};
  return { judgeBotId: judge === 'none' ? null : judge };
}

/** Body of the `debate` field sent to the room. */
export function debateConfigFromDraft(draft: DebateDraft): DebateConfig {
  const participants = draft.rows.filter(row => row.joined).map(row => {
    const stance = row.stance.trim().slice(0, DEBATE_STANCE_MAX_CHARS);
    return stance ? { botId: row.botId, stance } : { botId: row.botId };
  });
  return { rounds: draft.rounds, participants, ...judgePayload(draft.judge) };
}

export function debateSaveInit(draft: DebateDraft): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ debate: debateConfigFromDraft(draft) })
  };
}

function liveDebate(turns: readonly { status: string; debate?: LiveDebate }[]): LiveDebate | undefined {
  return turns.find(turn => turn.status === 'running' && turn.debate)?.debate;
}

/** The member whose speech is being prepared in a running debate, or '' when no debate is running. */
export function debateLiveSpeakerId(turns: readonly { status: string; debate?: LiveDebate }[]): string {
  const debate = liveDebate(turns);
  if (!debate) return '';
  if (debate.step < debate.speeches) return debate.participants[debate.step % Math.max(debate.participants.length, 1)]?.botId ?? '';
  return debate.verdictDone ? '' : debate.judgeBotId ?? '';
}

/** Where a running debate is: a round out of the total, or the verdict. Null when no debate is running. */
export function debateProgress(turns: readonly { status: string; debate?: LiveDebate }[]): { verdict: boolean; round: number; rounds: number } | null {
  const debate = liveDebate(turns);
  if (!debate) return null;
  const verdict = debate.step >= debate.speeches;
  const round = Math.min(debate.rounds, Math.floor(debate.step / Math.max(debate.participants.length, 1)) + 1);
  return { verdict, round, rounds: debate.rounds };
}
