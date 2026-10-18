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
 * open() bumps the epoch; a poll reset (mergeHistoryWindow) does not, so the
 * oldest loaded id is the other anchor. Either change drops the page.
 */
export function olderHistoryPageStale(
  epochNow: number,
  epochThen: number,
  anchorNow: string | null = null,
  anchorThen: string | null = null,
): boolean {
  return epochNow !== epochThen || anchorNow !== anchorThen;
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

export function mergeHistoryWindow<T extends {id:string;seq?:number}>(previous:T[],incoming:T[],sameSession:boolean):{messages:T[];reset:boolean} {
 if(!sameSession||!previous.length)return {messages:incoming,reset:true};
 const ids=new Set(previous.map(message=>message.id));
 const overlap=incoming.some(message=>ids.has(message.id));
 const maxPrevious=previous.at(-1)?.seq;const minIncoming=incoming[0]?.seq;
 // A disjoint refresh must retain the new cursor, otherwise intermediate pages become unreachable.
 if(!overlap&&incoming.length&&!(maxPrevious!=null&&minIncoming!=null&&minIncoming<=maxPrevious+1))return {messages:incoming,reset:true};
 return {messages:Array.from(new Map([...previous,...incoming].map(message=>[message.id,message])).values()),reset:false};
}
