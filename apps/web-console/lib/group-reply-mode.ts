/** Group-room reply mode stored on the room itself, not the global room-settings resource. */

export function groupReplyRoomPath(roomId: string): string {
  return `/api/bot-rooms/${encodeURIComponent(roomId)}`;
}

export type GroupReplyMode = 'coordinator' | 'all-members';

const MODES = new Set<GroupReplyMode>(['coordinator', 'all-members']);

function isGroupReplyMode(value: unknown): value is GroupReplyMode {
  return typeof value === 'string' && MODES.has(value as GroupReplyMode);
}

function replyModeCandidates(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as { replyMode?: unknown; settings?: unknown; room?: unknown };
  const settings = record.settings;
  const room = record.room;
  const roomSettings = room && typeof room === 'object' ? (room as { settings?: unknown }).settings : undefined;
  return [
    record.replyMode,
    settings && typeof settings === 'object' ? (settings as { replyMode?: unknown }).replyMode : undefined,
    room && typeof room === 'object' ? (room as { replyMode?: unknown }).replyMode : undefined,
    roomSettings && typeof roomSettings === 'object' ? (roomSettings as { replyMode?: unknown }).replyMode : undefined
  ];
}

/** A mode the server actually returned. Missing or unknown values are not a mode. */
export function explicitGroupReplyMode(payload: unknown): GroupReplyMode | null {
  for (const candidate of replyModeCandidates(payload)) {
    if (isGroupReplyMode(candidate)) return candidate;
  }
  return null;
}

/** Saved mode, or the product default when the settings response omits the field. */
export function readGroupReplyMode(payload: unknown): GroupReplyMode {
  return explicitGroupReplyMode(payload) ?? 'coordinator';
}

export function groupReplyModeSaveInit(mode: GroupReplyMode): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyMode: mode })
  };
}

export async function loadGroupReplyMode(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  roomId: string
): Promise<GroupReplyMode> {
  return readGroupReplyMode(await request(groupReplyRoomPath(roomId)));
}

export async function saveGroupReplyMode(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  roomId: string,
  current: GroupReplyMode,
  next: GroupReplyMode
): Promise<{ mode: GroupReplyMode; error: string; saved: boolean }> {
  try {
    const data = await request(groupReplyRoomPath(roomId), groupReplyModeSaveInit(next));
    if (explicitGroupReplyMode(data) !== next) {
      return { mode: current, error: 'not-confirmed', saved: false };
    }
    return { mode: next, error: '', saved: true };
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : 'not-confirmed';
    return { mode: current, error: message, saved: false };
  }
}
