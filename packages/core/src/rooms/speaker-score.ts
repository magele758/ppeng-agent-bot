import { isSilenceToken } from '../bots/silence.js';

/** Member card used to decide who is on-topic for an unnamed room message. */
export interface RoomSpeakerCard {
  id: string;
  name: string;
  title: string;
  description: string;
  groupName: string;
}

export interface RoomSpeakerScore {
  id: string;
  score: number;
}

/**
 * Minimum score before an unnamed member is woken.
 * One distinctive title, name, group, or description term clears this.
 * Common words are not terms, so a generic message stays at zero.
 */
export const ROOM_SPEAKER_SCORE_THRESHOLD = 2;

/** Follow-up member must outscore the host by at least this many points. */
export const ROOM_SPEAKER_CLEAR_LEAD = 2;

const NAME_WEIGHT = 3;
const TITLE_WEIGHT = 3;
const GROUP_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 2;

const STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'you', 'are', 'bot',
  '这个', '那个', '什么', '怎么', '如何', '可以', '我们', '你们', '他们', '一个',
  '没有', '不是', '就是', '以及', '或者', '如果', '因为', '所以', '进行', '需要',
  '已经', '一下', '时候', '问题', '请问', '帮忙', '看看', '负责', '处理', '相关',
  '内容', '信息', '工作', '任务', '回答', '通用', '助手', '各种', '用户', '一般',
  '关于', '完成', '支持', '提供', '帮助', '咨询', '聊天', '对话', '消息', '群聊',
  '成员', '请', '谢谢', '你好'
]);

const SHORT_ROOM_NEGATIONS = new Set([
  '我不知道',
  '不知道',
  '不清楚',
  '我不清楚',
  '没有要补充',
  '我没有要补充',
  '没有补充',
  '没什么要补充',
  '没有什么要补充'
]);

function termsOf(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_-]{2,}/g)) {
    const word = match[0];
    if (!STOP_TERMS.has(word)) found.add(word);
  }
  for (const match of lower.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const run = match[0];
    if (run.length <= 12 && !STOP_TERMS.has(run)) found.add(run);
    const limit = Math.min(run.length, 12);
    for (let i = 0; i < limit - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!STOP_TERMS.has(bigram)) found.add(bigram);
    }
  }
  return [...found];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function haystackHas(hay: string, term: string): boolean {
  if (/^[a-z0-9][a-z0-9_-]*$/.test(term)) {
    return new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(term)}(?:$|[^a-z0-9_-])`, 'i').test(hay);
  }
  return hay.toLowerCase().includes(term);
}

function fieldScore(hay: string, text: string, weight: number): number {
  let score = 0;
  for (const term of termsOf(text)) if (haystackHas(hay, term)) score += weight;
  return score;
}

/** Lexical overlap of one member card against the user message. Higher means more on-topic. */
export function scoreRoomSpeaker(message: string, card: RoomSpeakerCard): number {
  const hay = message.toLowerCase();
  const title = card.title.trim();
  const name = card.name.trim();
  const titleScore = title && title.toLowerCase() !== name.toLowerCase()
    ? fieldScore(hay, title, TITLE_WEIGHT)
    : 0;
  return fieldScore(hay, name, NAME_WEIGHT)
    + titleScore
    + fieldScore(hay, card.groupName, GROUP_WEIGHT)
    + fieldScore(hay, card.description, DESCRIPTION_WEIGHT);
}

/** Every card scored, highest first. Equal scores keep room order. */
export function rankRoomSpeakers(message: string, cards: readonly RoomSpeakerCard[]): RoomSpeakerScore[] {
  return cards
    .map((card, index) => ({ id: card.id, score: scoreRoomSpeaker(message, card), index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Unnamed, unquoted turn: members at or above {@link ROOM_SPEAKER_SCORE_THRESHOLD},
 * best first, cut to maxSpeakers. The host is included only when their own score clears the line.
 */
export function selectUnnamedSpeakers(
  message: string,
  cards: readonly RoomSpeakerCard[],
  maxSpeakers: number
): { botIds: string[]; scores: RoomSpeakerScore[] } {
  const scores = rankRoomSpeakers(message, cards);
  const cap = Number.isInteger(maxSpeakers) && maxSpeakers > 0 ? maxSpeakers : scores.length;
  const botIds = scores
    .filter(item => item.score >= ROOM_SPEAKER_SCORE_THRESHOLD)
    .slice(0, cap)
    .map(item => item.id);
  return { botIds, scores };
}

/**
 * After the host has a visible reply, at most one unspoken member who still clears the
 * line and beats the host by {@link ROOM_SPEAKER_CLEAR_LEAD}.
 */
export function selectFollowUpSpeaker(input: {
  scores: readonly RoomSpeakerScore[];
  hostBotId: string;
  alreadyScheduled: readonly string[];
}): string | undefined {
  const hostScore = input.scores.find(item => item.id === input.hostBotId)?.score ?? 0;
  const blocked = new Set(input.alreadyScheduled);
  const ranked = [...input.scores].sort((left, right) => right.score - left.score);
  return ranked.find(item =>
    !blocked.has(item.id)
    && item.score >= ROOM_SPEAKER_SCORE_THRESHOLD
    && item.score >= hostScore + ROOM_SPEAKER_CLEAR_LEAD
  )?.id;
}

const TRAILING_PARTICLE = /[啊呢吧呀哦喔嘛]+$/u;

function compactRoomBody(body: string): string {
  return body.trim().replace(/^[\s"'「」“”]+|[\s"'「」“”。.!！?？,，、~～]+$/g, '').replace(/\s+/g, '');
}

/** Whole reply is a short refusal to add anything. A longer sentence that merely contains these words is not. */
export function isShortRoomNegation(body: string): boolean {
  const compact = compactRoomBody(body);
  if (SHORT_ROOM_NEGATIONS.has(compact)) return true;
  const bare = compact.replace(TRAILING_PARTICLE, '');
  return bare !== compact && SHORT_ROOM_NEGATIONS.has(bare);
}

/**
 * Nothing that should stay out of the room: empty, a silence token (a trailing period still counts),
 * or a short refusal. A longer sentence is kept.
 */
export function isWithheldRoomReply(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed || isSilenceToken(trimmed) || isShortRoomNegation(trimmed)) return true;
  const unpunctuated = trimmed.replace(/[。.!！?？~～]+$/g, '').trim();
  return unpunctuated !== trimmed && isSilenceToken(unpunctuated);
}
