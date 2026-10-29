/**
 * Play 侧栏群聊的成员规则。
 * 已有 Bot Room API 会静默去重，也允许只有一个成员（Bots 页沿用该行为）。
 * 从 Bot 会话列表新建或改成员时，先走这里：至少两个、且不能重复。
 */

export const BOT_GROUPS_CHANGED_EVENT = 'ppeng-bot-groups-changed';

export type GroupMemberCode = 'need_two' | 'duplicate' | 'blank' | 'unknown';

export type GroupMembers =
  | { ok: true; members: string[] }
  | { ok: false; code: GroupMemberCode };

export function groupMemberIds(botIds: readonly string[], knownIds?: ReadonlySet<string>): GroupMembers {
  const members = botIds.map((id) => id.trim());
  if (members.some((id) => id.length === 0)) return { ok: false, code: 'blank' };
  const seen = new Set<string>();
  for (const id of members) {
    if (seen.has(id)) return { ok: false, code: 'duplicate' };
    seen.add(id);
  }
  if (knownIds && members.some((id) => !knownIds.has(id))) return { ok: false, code: 'unknown' };
  if (members.length < 2) return { ok: false, code: 'need_two' };
  return { ok: true, members };
}

export function addGroupMember(
  current: readonly string[],
  botId: string,
  knownIds?: ReadonlySet<string>
): GroupMembers {
  return groupMemberIds([...current, botId], knownIds);
}

export function removeGroupMember(current: readonly string[], botId: string): GroupMembers {
  return groupMemberIds(current.filter((id) => id !== botId));
}

/** 让本轮发言预算盖住当前成员（Room 上限 20）。 */
export function groupSpeakBudget(memberCount: number): number {
  if (!Number.isInteger(memberCount) || memberCount < 2) return 2;
  return Math.min(20, memberCount);
}

const GROUP_TITLE_MAX = 120;

/** A group title is 1–120 characters after trim. */
export function groupTitleOk(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length >= 1 && trimmed.length <= GROUP_TITLE_MAX;
}

/** Add the id if absent, otherwise remove it. Order of the remaining ids is kept. */
export function toggleGroupMember(current: readonly string[], id: string): string[] {
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

export type BotGroupCreateBody = {
  title: string;
  botIds: string[];
  hostBotId: string;
  maxBotTurns?: number;
};

/**
 * POST /api/bot-rooms body. The first accepted member hosts.
 * Returns null when the title or the member set would be rejected.
 */
export function buildBotGroupCreateBody(
  title: string,
  memberIds: readonly string[],
  knownIds: ReadonlySet<string>
): BotGroupCreateBody | null {
  return buildBotGroupBody(title, groupMemberIds(memberIds, knownIds));
}

/** The form can be submitted only when title and members would both be accepted. */
export function groupCreateReady(title: string, memberIds: readonly string[], knownIds: ReadonlySet<string>): boolean {
  return groupCreateDraft(title, memberIds, knownIds).ready;
}

/** Fewer than two known bots means there is nothing to pick from. */
export function groupCreateNeedsRoster(botCount: number): boolean {
  return botCount < 2;
}

export type GroupCreateBlock = 'title' | 'members' | null;

export type GroupCreateBlockKey = 'play.group.titleInvalid' | 'agents.bots.groupNeedTwo';

const GROUP_BLOCK_KEYS: Record<Exclude<GroupCreateBlock, null>, GroupCreateBlockKey> = {
  title: 'play.group.titleInvalid',
  members: 'agents.bots.groupNeedTwo'
};

/** i18n key for a blocked submit. A bad title wins; a missing body means "need two". */
export function groupCreateBlockKey(block: GroupCreateBlock, hasBody: boolean): GroupCreateBlockKey | null {
  if (block === 'title') return GROUP_BLOCK_KEYS.title;
  if (!hasBody || block === 'members') return GROUP_BLOCK_KEYS.members;
  return null;
}

/** Message for a failed create. Non-Error throws are stringified. */
export function groupCreateError(err: unknown, format: (message: string) => string): string {
  const message = err instanceof Error ? err.message : String(err);
  return format(message);
}

/** Why a group submit stops. A bad title is reported before a short member list. */
export function groupCreateBlock(titleOk: boolean, bodyReady: boolean): GroupCreateBlock {
  if (!titleOk) return 'title';
  if (!bodyReady) return 'members';
  return null;
}

export type GroupCreateDraft = {
  ready: boolean;
  body: BotGroupCreateBody | null;
  block: GroupCreateBlock;
  /** i18n key when submit must stop, otherwise null. */
  blockKey: GroupCreateBlockKey | null;
  warnMembers: boolean;
};

/** Everything the create form renders from the current title and member ids. */
export function groupCreateDraft(title: string, memberIds: readonly string[], knownIds: ReadonlySet<string>): GroupCreateDraft {
  const members = groupMemberIds(memberIds, knownIds);
  const body = buildBotGroupBody(title, members);
  const block = groupCreateBlock(groupTitleOk(title), body !== null);
  return {
    ready: body !== null,
    body,
    block,
    blockKey: groupCreateBlockKey(block, body !== null),
    warnMembers: !members.ok && memberIds.length > 0
  };
}

function buildBotGroupBody(title: string, members: GroupMembers): BotGroupCreateBody | null {
  if (!groupTitleOk(title) || !members.ok) return null;
  return {
    title: title.trim(),
    botIds: members.members,
    hostBotId: members.members[0]!
  };
}

export type MentionQuery = { start: number; query: string };

/** The @ being typed at the caret, if it starts a mention and is not already finished. */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
  const upto = value.slice(0, caret);
  const match = upto.match(/(^|\s)@([^\s@,，:：;；!?！？]*)$/u);
  if (!match || match.index == null) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

export function filterMentionMembers<T extends { name: string }>(members: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  return members.filter((member) => member.name.toLowerCase().includes(q));
}

export function insertMention(value: string, start: number, caret: number, name: string): { value: string; caret: number } {
  const insertion = `@${name} `;
  return {
    value: value.slice(0, start) + insertion + value.slice(caret),
    caret: start + insertion.length
  };
}

export function groupMatchesQuery(
  room: { title: string; botIds: readonly string[] },
  query: string,
  nameOf: (id: string) => string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (room.title.toLowerCase().includes(q)) return true;
  return room.botIds.some((id) => nameOf(id).toLowerCase().includes(q) || id.toLowerCase().includes(q));
}
