export type BotListPhase = 'loading' | 'error' | 'empty' | 'keep' | null;

function unloadedPhase(error: string): BotListPhase {
  if (error) return 'error';
  return 'loading';
}

function nothingListed(botCount: number, roomCount: number, groupCount: number): boolean {
  if (botCount !== 0) return false;
  if (roomCount !== 0) return false;
  if (groupCount !== 0) return false;
  return true;
}

function loadedPhase(error: string, botCount: number, roomCount: number, groupCount: number): BotListPhase {
  if (error) return 'keep';
  if (nothingListed(botCount, roomCount, groupCount)) return 'empty';
  return null;
}

/** What the Bot list should show. A failed load is not an empty list, and a later save error keeps the rows. */
export function botListPhase(
  loaded: boolean,
  error: string,
  botCount: number,
  roomCount: number,
  groupCount: number
): BotListPhase {
  if (!loaded) return unloadedPhase(error);
  return loadedPhase(error, botCount, roomCount, groupCount);
}
