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
