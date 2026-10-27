/** View rules for a large room: header tiles, member drawer, @ choices, goal bar, approval button. */

export const MEMBER_TILE_LIMIT = 6;

export type RoomBot = {
  id: string;
  name: string;
  title?: string;
  description?: string;
};

export type FunctionalGroupRef = {
  id: string;
  name: string;
  botIds: readonly string[];
};

export type MentionChoice = {
  kind: 'group' | 'bot';
  id: string;
  name: string;
  insert: string;
  detail: string;
  count: number;
};

export type DrawerMember = {
  id: string;
  name: string;
  duty: string;
  host: boolean;
  speaking: boolean;
  removable: boolean;
};

export type AddGroupAction = {
  id: string;
  name: string;
};

export type MemberDrawer = {
  host: DrawerMember | null;
  speaking: DrawerMember[];
  current: DrawerMember[];
  addBots: DrawerMember[];
  addGroups: AddGroupAction[];
};

export type RoomGoalView = {
  id: string;
  title: string;
  progress: string;
  wave: string;
  canControl: boolean;
};

export type RoomApprovalMode = 'private' | 'room';

type TurnLike = {
  status?: string;
  botIds?: readonly string[];
  cursor?: number;
  approvalId?: string;
  members?: readonly { botId?: string; status?: string; approvalId?: string }[];
};

const OPEN_GOAL = new Set(['active', 'running', 'queued', 'paused', 'open', 'in_progress', 'waiting']);
const SPEAKING = new Set(['running', 'waiting_approval']);

export function tileMembersInHeader(count: number): boolean {
  return count <= MEMBER_TILE_LIMIT;
}

export function uniqueMemberIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function groupRemovalPlan(
  memberIds: readonly string[],
  groupBotIds: readonly string[]
): { ok: true; remove: string[]; next: string[] } | { ok: false; code: 'need_two' } {
  const current = uniqueMemberIds(memberIds);
  const drop = new Set(groupBotIds);
  const remove = current.filter((id) => drop.has(id));
  const next = current.filter((id) => !drop.has(id));
  if (remove.length === 0) return { ok: true, remove, next: current };
  if (next.length < 2) return { ok: false, code: 'need_two' };
  return { ok: true, remove, next };
}

export function groupCanAdd(
  memberIds: readonly string[],
  groupBotIds: readonly string[],
  knownIds: ReadonlySet<string>
): boolean {
  const inside = new Set(memberIds);
  return groupBotIds.some((id) => knownIds.has(id) && !inside.has(id));
}

export function normalizeFunctionalGroups(value: unknown): FunctionalGroupRef[] {
  if (!value || typeof value !== 'object') return [];
  const groups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  const next: FunctionalGroupRef[] = [];
  for (const item of groups) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    const botIds = (item as { botIds?: unknown }).botIds;
    if (typeof id !== 'string' || typeof name !== 'string' || !Array.isArray(botIds)) continue;
    next.push({ id, name, botIds: botIds.filter((botId): botId is string => typeof botId === 'string' && botId.length > 0) });
  }
  return next;
}

export function speakingBotIds(turns: readonly TurnLike[]): string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    if (!turn.status || !SPEAKING.has(turn.status)) continue;
    const live = (turn.members ?? []).filter((member) => member.status === 'running' || member.status === 'waiting_approval');
    if (live.length > 0) {
      for (const member of live) {
        if (member.botId && !ids.includes(member.botId)) ids.push(member.botId);
      }
      continue;
    }
    const list = turn.botIds ?? [];
    const cursor = turn.cursor ?? 0;
    const index = cursor >= 0 && cursor < list.length ? cursor : 0;
    const id = list[index];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function memberNeedsPerson(turns: readonly TurnLike[]): boolean {
  return turns.some((turn) => turn.status === 'waiting_approval' || (turn.members ?? []).some((member) => member.status === 'waiting_approval'));
}

export function pendingApprovalId(turns: readonly TurnLike[]): string {
  for (const turn of turns) {
    if (typeof turn.approvalId === 'string' && turn.approvalId) return turn.approvalId;
    for (const member of turn.members ?? []) {
      if (member.status === 'waiting_approval' && typeof member.approvalId === 'string' && member.approvalId) return member.approvalId;
    }
  }
  return '';
}

export function roomApprovalMode(settings: unknown): RoomApprovalMode {
  if (!settings || typeof settings !== 'object') return 'private';
  return (settings as { approvalMode?: unknown }).approvalMode === 'room' ? 'room' : 'private';
}

/** Approve stays out of the room unless the saved policy is in-room and someone is waiting. */
export function showInlineApprove(mode: RoomApprovalMode, needsPerson: boolean): boolean {
  return mode === 'room' && needsPerson;
}

export function readRoomGoal(room: unknown): RoomGoalView | null {
  if (!room || typeof room !== 'object') return null;
  const goal = (room as { goal?: unknown }).goal;
  if (!goal || typeof goal !== 'object') return null;
  const record = goal as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const status = typeof record.status === 'string' ? record.status : '';
  if (!title || !OPEN_GOAL.has(status)) return null;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const progress = typeof record.progress === 'string' ? record.progress.trim() : '';
  const wave = typeof record.wave === 'string' ? record.wave.trim() : '';
  return { id, title, progress, wave, canControl: id.length > 0 };
}

function dutyOf(bot: RoomBot | undefined, fallback: string): string {
  const title = bot?.title?.trim() ?? '';
  const description = bot?.description?.trim() ?? '';
  if (title && title !== bot?.name) return title;
  return description || fallback;
}

function botMatches(bot: RoomBot, query: string): boolean {
  if (!query) return true;
  const haystack = [bot.name, bot.title ?? '', bot.description ?? ''].join('\n').toLowerCase();
  return haystack.includes(query);
}

function toMember(
  id: string,
  bots: readonly RoomBot[],
  hostId: string,
  speakingIds: ReadonlySet<string>,
  removable: boolean
): DrawerMember {
  const bot = bots.find((item) => item.id === id);
  return {
    id,
    name: bot?.name ?? id,
    duty: dutyOf(bot, ''),
    host: id === hostId,
    speaking: speakingIds.has(id),
    removable
  };
}

export function memberDrawer(input: {
  memberIds: readonly string[];
  bots: readonly RoomBot[];
  groups: readonly FunctionalGroupRef[];
  hostId: string;
  speakingIds: readonly string[];
  query: string;
}): MemberDrawer {
  const memberIds = uniqueMemberIds(input.memberIds);
  const known = new Set(input.bots.map((bot) => bot.id));
  const inside = new Set(memberIds);
  const speakingIds = new Set(input.speakingIds);
  const query = input.query.trim().toLowerCase();
  const current = memberIds.map((id) => toMember(id, input.bots, input.hostId, speakingIds, id !== input.hostId));
  const addGroups: AddGroupAction[] = [];
  const covered = new Set<string>();
  for (const group of input.groups) {
    if (!groupCanAdd(memberIds, group.botIds, known)) continue;
    if (query && !group.name.toLowerCase().includes(query)) continue;
    addGroups.push({ id: group.id, name: group.name });
    for (const id of group.botIds) {
      if (!inside.has(id)) covered.add(id);
    }
  }
  const addBots = input.bots
    .filter((bot) => !inside.has(bot.id) && !covered.has(bot.id) && (!query || botMatches(bot, query)))
    .map((bot) => toMember(bot.id, input.bots, input.hostId, speakingIds, false));
  const host = input.hostId ? toMember(input.hostId, input.bots, input.hostId, speakingIds, false) : null;
  const speaking = input.speakingIds
    .filter((id) => inside.has(id))
    .map((id) => toMember(id, input.bots, input.hostId, speakingIds, id !== input.hostId));
  return { host, speaking, current, addBots, addGroups };
}

function groupInsert(group: FunctionalGroupRef, members: readonly RoomBot[], inRoom: ReadonlySet<string>): string {
  const names = uniqueMemberIds(group.botIds)
    .filter((id) => inRoom.has(id))
    .map((id) => members.find((bot) => bot.id === id)?.name ?? id);
  return names.length > 0 ? names.join(' @') : group.name;
}

export function mentionChoices(
  members: readonly RoomBot[],
  groups: readonly FunctionalGroupRef[],
  query: string,
  inRoom: ReadonlySet<string>
): MentionChoice[] {
  const q = query.trim().toLowerCase();
  const roomMembers = members.filter((bot) => inRoom.has(bot.id));
  const groupChoices: MentionChoice[] = groups
    .filter((group) => !q || group.name.toLowerCase().includes(q))
    .map((group) => {
      const count = uniqueMemberIds(group.botIds).filter((id) => inRoom.has(id)).length;
      return {
        kind: 'group' as const,
        id: group.id,
        name: group.name,
        insert: groupInsert(group, roomMembers, inRoom),
        detail: '',
        count
      };
    });
  const botChoices: MentionChoice[] = roomMembers
    .filter((bot) => !q || botMatches(bot, q))
    .map((bot) => ({
      kind: 'bot' as const,
      id: bot.id,
      name: bot.name,
      insert: bot.name,
      detail: dutyOf(bot, ''),
      count: 1
    }));
  return [...groupChoices, ...botChoices];
}
