import { nowIso } from '../id.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js';
import { BotFunctionalGroupService } from '../bots/functional-groups.js';
import { botPrincipalKey, principalFromSession, type BotPrincipal } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
import type { SessionRecord } from '../types.js';
import { buildRoomContextView, type RoomContextView } from './context-view.js';

/** New room messages required before another summary fold. */
export const ROOM_SUMMARY_MESSAGE_GAP = 20;
/** Unsummarized text required before another summary fold. */
export const ROOM_SUMMARY_CHAR_GAP = 24_000;
/** Roughly 1,500 tokens. The stored summary is clipped to this. */
export const ROOM_SUMMARY_MAX_CHARS = 6_000;

export interface RoomTranscriptMessage {
  id: string;
  roomId: string;
  seq: number;
  sender: { type: 'user' | 'bot'; id: string; name: string };
  text: string;
  attachmentIds: string[];
  createdAt: string;
}

export interface RoomSummaryRecord {
  roomId: string;
  throughSeq: number;
  summaryMd: string;
  keyDecisions: string[];
  updatedAt: string;
}

export interface RoomSummarySourceMessage {
  seq: number;
  senderName: string;
  senderType: 'user' | 'bot';
  text: string;
  attachmentIds: string[];
}

export type RoomSummarizer = (input: {
  previous: { summaryMd: string; keyDecisions: string[] } | null;
  messages: RoomSummarySourceMessage[];
}) => { summaryMd: string; keyDecisions: string[] } | Promise<{ summaryMd: string; keyDecisions: string[] }>;

export interface RoomSummaryRefresh {
  record: RoomSummaryRecord | null;
  failed: boolean;
  refreshed: boolean;
}

interface RoomSql {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

interface RoomRecord {
  id: string;
  principalId: string;
  botIds: string[];
}

function roomDb(store: SqliteStateStore): RoomSql {
  return store.db as unknown as RoomSql;
}

export function ensureRoomSummarySchema(store: SqliteStateStore): void {
  roomDb(store).exec(`
    CREATE TABLE IF NOT EXISTS bot_room_summaries (
      room_id TEXT PRIMARY KEY,
      through_seq INTEGER NOT NULL DEFAULT 0,
      summary_md TEXT NOT NULL DEFAULT '',
      key_decisions_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `);
}

function tableExists(db: RoomSql, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function parseMessage(data: string): RoomTranscriptMessage | undefined {
  try {
    const value = JSON.parse(data) as Partial<RoomTranscriptMessage>;
    const sender = value.sender;
    if (!value || typeof value.id !== 'string' || !Number.isInteger(value.seq) || typeof value.text !== 'string') return undefined;
    if (!sender || (sender.type !== 'user' && sender.type !== 'bot') || typeof sender.name !== 'string') return undefined;
    const attachmentIds = Array.isArray(value.attachmentIds)
      ? value.attachmentIds.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      id: value.id,
      roomId: typeof value.roomId === 'string' ? value.roomId : '',
      seq: value.seq as number,
      sender: { type: sender.type, id: typeof sender.id === 'string' ? sender.id : '', name: sender.name },
      text: value.text,
      attachmentIds,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : ''
    };
  } catch {
    return undefined;
  }
}

/** Room transcript only. Does not read private sessions. Caller must already have authorized the room. */
export function listRoomMessages(store: SqliteStateStore, roomId: string): RoomTranscriptMessage[] {
  const db = roomDb(store);
  if (!tableExists(db, 'bot_room_messages')) return [];
  const rows = db.prepare('SELECT data FROM bot_room_messages WHERE room_id=? ORDER BY seq ASC').all(roomId) as Array<{ data?: string }>;
  const messages: RoomTranscriptMessage[] = [];
  for (const row of rows) {
    if (typeof row.data !== 'string') continue;
    const message = parseMessage(row.data);
    if (message) messages.push(message);
  }
  return messages;
}

function loadRoom(store: SqliteStateStore, roomId: string): RoomRecord {
  const db = roomDb(store);
  if (!tableExists(db, 'bot_rooms')) throw new NotFoundError('Room', roomId);
  const row = db.prepare('SELECT data, principal_id FROM bot_rooms WHERE id=?').get(roomId) as { data?: string; principal_id?: string } | undefined;
  if (!row?.data) throw new NotFoundError('Room', roomId);
  const parsed = JSON.parse(row.data) as { principalId?: unknown; botIds?: unknown };
  const botIds = Array.isArray(parsed.botIds) ? parsed.botIds.filter((id): id is string => typeof id === 'string') : [];
  const principalId = typeof parsed.principalId === 'string' ? parsed.principalId : String(row.principal_id ?? '');
  return { id: roomId, principalId, botIds };
}

/** Session must belong to this room's owner, and the bot must be a current member. */
export function assertRoomMemberAccess(
  store: SqliteStateStore,
  session: Pick<SessionRecord, 'metadata'>
): { roomId: string; botId: string; principal: BotPrincipal; room: RoomRecord } {
  const roomId = session.metadata?.roomId;
  const botId = session.metadata?.botId;
  if (typeof roomId !== 'string' || typeof botId !== 'string' || !roomId || !botId) throw new ValidationError('Not a room session');
  const room = loadRoom(store, roomId);
  const principal = principalFromSession(store, session);
  if (room.principalId !== botPrincipalKey(principal) || !room.botIds.includes(botId)) throw new AuthorizationError();
  return { roomId, botId, principal, room };
}

function parseDecisions(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function readRoomSummary(store: SqliteStateStore, roomId: string): RoomSummaryRecord | null {
  ensureRoomSummarySchema(store);
  const row = roomDb(store).prepare(
    'SELECT room_id, through_seq, summary_md, key_decisions_json, updated_at FROM bot_room_summaries WHERE room_id=?'
  ).get(roomId) as { room_id?: string; through_seq?: number; summary_md?: string; key_decisions_json?: string; updated_at?: string } | undefined;
  if (!row || typeof row.summary_md !== 'string') return null;
  return {
    roomId,
    throughSeq: typeof row.through_seq === 'number' ? row.through_seq : 0,
    summaryMd: row.summary_md,
    keyDecisions: parseDecisions(row.key_decisions_json),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : ''
  };
}

export function deleteRoomSummary(store: SqliteStateStore, roomId: string): void {
  ensureRoomSummarySchema(store);
  roomDb(store).prepare('DELETE FROM bot_room_summaries WHERE room_id=?').run(roomId);
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function isDecision(text: string): boolean {
  return /结论|共识|决定|决策|已确认|\bdecision\b|\bconsensus\b/i.test(text);
}

/** Deterministic fold used when the scheduler does not pass its own summarizer. */
export function extractRoomSummary(input: {
  previous: { summaryMd: string; keyDecisions: string[] } | null;
  messages: RoomSummarySourceMessage[];
}): { summaryMd: string; keyDecisions: string[] } {
  const fresh = input.messages
    .filter(message => isDecision(message.text))
    .map(message => `[seq:${message.seq}] ${clip(message.text, 240)}`);
  const keyDecisions = [...(input.previous?.keyDecisions ?? []), ...fresh].slice(-20);
  const objective = input.messages.find(message => message.senderType === 'user')?.text ?? '';
  const deliverables = input.messages.flatMap(message => message.attachmentIds.map(id => `${id} [seq:${message.seq}]`));
  const questions = input.messages.filter(message => /[?？]/.test(message.text)).slice(-8);
  const previousNote = input.previous?.summaryMd ? clip(input.previous.summaryMd, 800) : '';
  const summaryMd = [
    '### 群当前目标与背景 (Objective & Context)',
    previousNote,
    clip(objective, 500) || '（未单列目标）',
    '',
    '### 已达成共识与关键决策 (Consensus & Decisions, 附 [seq:N] 引用锚点)',
    keyDecisions.length ? keyDecisions.map(item => `- ${item}`).join('\n') : '（尚无标记为结论的发言）',
    '',
    '### 各专家近期产出摘要 (Recent Deliverables, 附 materialId / seq 锚点)',
    deliverables.length ? deliverables.join('\n') : '（暂无附件或产物）',
    '',
    '### 待解决分歧与下一步 (Open Questions & Next Steps)',
    questions.length ? questions.map(message => `[seq:${message.seq}] ${clip(message.text, 200)}`).join('\n') : '（无待确认问题）'
  ].join('\n').slice(0, ROOM_SUMMARY_MAX_CHARS);
  return { summaryMd, keyDecisions };
}

function pendingOf(throughSeq: number, messages: RoomTranscriptMessage[]): RoomTranscriptMessage[] {
  return messages.filter(message => message.seq > throughSeq);
}

export function roomSummaryIsDue(throughSeq: number, messages: Array<{ seq: number; text: string }>): boolean {
  let count = 0;
  let chars = 0;
  for (const message of messages) {
    if (message.seq <= throughSeq) continue;
    count += 1;
    chars += message.text.length;
    if (count >= ROOM_SUMMARY_MESSAGE_GAP || chars >= ROOM_SUMMARY_CHAR_GAP) return true;
  }
  return false;
}

function writeSummary(store: SqliteStateStore, record: RoomSummaryRecord): void {
  ensureRoomSummarySchema(store);
  roomDb(store).prepare(`
    INSERT INTO bot_room_summaries(room_id, through_seq, summary_md, key_decisions_json, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET
      through_seq=excluded.through_seq,
      summary_md=excluded.summary_md,
      key_decisions_json=excluded.key_decisions_json,
      updated_at=excluded.updated_at
  `).run(record.roomId, record.throughSeq, record.summaryMd, JSON.stringify(record.keyDecisions), record.updatedAt);
}

/**
 * Fold room messages into the shared summary once 20 new messages or 24,000 new characters arrive.
 * A thrown summarizer leaves the previous summary in place and does not advance throughSeq.
 */
export async function refreshRoomSummary(
  store: SqliteStateStore,
  roomId: string,
  summarizer: RoomSummarizer = extractRoomSummary
): Promise<RoomSummaryRefresh> {
  const previous = readRoomSummary(store, roomId);
  const pending = pendingOf(previous?.throughSeq ?? 0, listRoomMessages(store, roomId));
  if (!roomSummaryIsDue(previous?.throughSeq ?? 0, pending)) return { record: previous, failed: false, refreshed: false };
  try {
    const produced = await summarizer({
      previous: previous ? { summaryMd: previous.summaryMd, keyDecisions: previous.keyDecisions } : null,
      messages: pending.map(message => ({
        seq: message.seq,
        senderName: message.sender.name,
        senderType: message.sender.type,
        text: message.text,
        attachmentIds: message.attachmentIds
      }))
    });
    if (!produced || typeof produced.summaryMd !== 'string' || !produced.summaryMd.trim()) {
      return { record: previous, failed: true, refreshed: false };
    }
    const last = pending[pending.length - 1];
    const record: RoomSummaryRecord = {
      roomId,
      throughSeq: last?.seq ?? previous?.throughSeq ?? 0,
      summaryMd: produced.summaryMd.slice(0, ROOM_SUMMARY_MAX_CHARS),
      keyDecisions: (Array.isArray(produced.keyDecisions) ? produced.keyDecisions : [])
        .filter((item): item is string => typeof item === 'string')
        .slice(-20),
      updatedAt: nowIso()
    };
    writeSummary(store, record);
    return { record, failed: false, refreshed: true };
  } catch {
    return { record: previous, failed: true, refreshed: false };
  }
}

export interface PrepareRoomContextInput {
  store: SqliteStateStore;
  roomId: string;
  botId: string;
  session: Pick<SessionRecord, 'id' | 'agentId' | 'metadata' | 'mode' | 'parentSessionId'>;
  summarizer?: RoomSummarizer;
}

/**
 * Wake-up context for one room member. Summary failure still returns recent messages.
 * The scheduler should place `text` into that member's room prompt.
 */
export async function prepareRoomContextView(input: PrepareRoomContextInput): Promise<RoomContextView> {
  const sessionRoom = input.session.metadata?.roomId;
  const sessionBot = input.session.metadata?.botId;
  if (sessionRoom !== input.roomId || sessionBot !== input.botId) throw new AuthorizationError();
  assertRoomMemberAccess(input.store, input.session);
  const refreshed = await refreshRoomSummary(input.store, input.roomId, input.summarizer);
  const summary = refreshed.record?.summaryMd
    ? { throughSeq: refreshed.record.throughSeq, summaryMd: refreshed.record.summaryMd }
    : null;
  const sharedFacts = new BotFunctionalGroupService(input.store).sharedForSession(input.session);
  const messages = listRoomMessages(input.store, input.roomId).map(message => ({
    seq: message.seq,
    senderName: message.sender.name,
    text: message.text
  }));
  return buildRoomContextView({
    summary,
    summaryUnavailable: refreshed.failed || !summary,
    sharedFacts,
    messages
  });
}
