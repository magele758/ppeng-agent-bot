/** Prepend an older page. Ids already loaded keep the loaded copy, so a cursor overlap cannot duplicate a row. */
export function prependHistoryPage<T extends { id: string }>(loaded: T[], older: T[]): T[] {
  const loadedIds = new Set(loaded.map((message) => message.id));
  const head: T[] = [];
  const seen = new Set<string>();
  for (const message of older) {
    if (loadedIds.has(message.id) || seen.has(message.id)) continue;
    seen.add(message.id);
    head.push(message);
  }
  return [...head, ...loaded];
}

/** Drop a poll that finished after the room changed or a newer history read started. */
export function historyPollStale(
  active: boolean,
  currentRoomId: string | null,
  polledRoomId: string,
  epochNow: number,
  epochThen: number,
): boolean {
  return !active || currentRoomId !== polledRoomId || epochNow !== epochThen;
}

/** Oldest loaded row. A poll window reset replaces this id without bumping historyEpoch. */
export function historyWindowAnchor(messages: ReadonlyArray<{ id: string }>): string | null {
  return messages[0]?.id ?? null;
}

/**
 * An older page fetched before a history reset must not be applied: its messages,
 * cursor, and turns belong to the window that was replaced.
 * A tail refresh is not an older page, so it is never dropped here.
 * open() bumps the epoch; a poll reset (mergeHistoryWindow) does not, so the
 * oldest loaded id is the other anchor. Either change drops the page.
 */
export function olderHistoryPageStale(
  older: boolean,
  epochNow: number,
  epochThen: number,
  anchorNow: string | null = null,
  anchorThen: string | null = null,
): boolean {
  return older && (epochNow !== epochThen || anchorNow !== anchorThen);
}

/** Load-older reads before the cursor. A tail refresh, or a missing cursor, does not. */
export function historyBeforeQuery(older: boolean, cursor: number | null): string {
  return older && cursor != null ? `&beforeSeq=${cursor}` : "";
}

/** Older page is prepended (loaded ids win). A tail refresh replaces the window. */
export function applyHistoryPage<T extends { id: string }>(loaded: T[], page: T[], older: boolean): T[] {
  return older ? prependHistoryPage(loaded, page) : page;
}

/**
 * Load-earlier cursor after a disjoint/reset tail merge.
 * The tail page cursor only reaches the skipped page. When the oldest visible
 * seq is past the start of history, the next older read starts at that row;
 * otherwise keep nextCursor while another page exists.
 */
export function loadEarlierCursorAfterReset(
  messages: ReadonlyArray<{ seq?: number }>,
  hasMore: boolean,
  nextCursor: number | null,
): number | null {
  const oldest = messages[0]?.seq;
  if (oldest != null && oldest > 1) return oldest;
  return hasMore ? nextCursor : null;
}

type RowBody = { text?: unknown; parts?: unknown };

function rowBody(message: RowBody): string {
  if (typeof message.text === 'string') return message.text;
  if (!Array.isArray(message.parts)) return '';
  let body = '';
  for (const part of message.parts) {
    if (!part || typeof part !== 'object') continue;
    const row = part as { type?: unknown; text?: unknown };
    if (row.type === 'text' && typeof row.text === 'string') body += row.text;
  }
  return body;
}

/** A refresh with no prose must not wipe a body already on screen. */
function keepLoadedBody<T extends { id: string }>(current: T | undefined, incoming: T): T {
  if (!current) return incoming;
  const previousBody = rowBody(current as RowBody).trim();
  const incomingBody = rowBody(incoming as RowBody).trim();
  if (previousBody && !incomingBody) return current;
  return incoming;
}

function mergeById<T extends { id: string; seq?: number }>(previous: readonly T[], incoming: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const message of previous) map.set(message.id, message);
  for (const message of incoming) map.set(message.id, keepLoadedBody(map.get(message.id), message));
  return Array.from(map.values()).sort((a, b) => a.seq != null && b.seq != null ? a.seq - b.seq : 0);
}

export function mergeHistoryWindow<T extends {id:string;seq?:number}>(previous:T[],incoming:T[],sameSession:boolean):{messages:T[];reset:boolean} {
 if(!sameSession||!previous.length)return {messages:incoming,reset:true};
 const ids=new Set(previous.map(message=>message.id));
 const overlap=incoming.some(message=>ids.has(message.id));
 const maxPrevious=previous.at(-1)?.seq;const minIncoming=incoming[0]?.seq;
 // A disjoint refresh must retain the new cursor, otherwise intermediate pages become unreachable.
 const disjoint=!overlap&&incoming.length>0&&!(maxPrevious!=null&&minIncoming!=null&&minIncoming<=maxPrevious+1);
 if(disjoint){
  const maxIncoming=incoming.reduce<number|null>((max,message)=>message.seq!=null&&(max==null||message.seq>max)?message.seq:max,null);
  const newer=maxIncoming==null?[]:previous.filter(message=>message.seq!=null&&message.seq>maxIncoming);
  if(newer.length)return {messages:mergeById(newer,incoming),reset:false};
  return {messages:incoming,reset:true};
 }
 return {messages:mergeById(previous,incoming),reset:false};
}

export type StreamTextPiece = { kind: string; raw?: string };

/** Assistant prose that was streamed but is not in the saved transcript yet. */
export function unpersistedAssistantText(
  messages: ReadonlyArray<{ role?: string; text?: string; parts?: ReadonlyArray<{ type?: string; text?: string }> }>,
  segments: ReadonlyArray<StreamTextPiece>
): string {
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  const saved = messages.slice(lastUser + 1)
    .filter((message) => message.role === 'assistant')
    .map((message) => rowBody(message).trim())
    .filter(Boolean);
  const pending: string[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'text') continue;
    const raw = (segment.raw ?? '').trim();
    if (!raw) continue;
    if (saved.some((body) => body.includes(raw))) continue;
    const prefix = saved.filter((body) => raw.startsWith(body) && body.length >= 12).sort((a, b) => b.length - a.length)[0];
    if (prefix) {
      const rest = raw.slice(prefix.length).trim();
      if (rest) pending.push(rest);
      continue;
    }
    pending.push(raw);
  }
  return pending.join('\n\n');
}

/**
 * Apply one saved page, then keep streamed prose only when that page does not
 * contain it yet. Nothing here sends the user message again.
 */
export function settleFinishedTurn<T extends { id: string; seq?: number; role?: string; text?: string; parts?: ReadonlyArray<{ type?: string; text?: string }> }>(input: {
  previous: T[];
  incoming: T[];
  sameSession: boolean;
  segments: ReadonlyArray<StreamTextPiece>;
}): { messages: T[]; heldText: string } {
  const merged = mergeHistoryWindow(input.previous, input.incoming, input.sameSession);
  return {
    messages: merged.messages,
    heldText: unpersistedAssistantText(merged.messages, input.segments)
  };
}
