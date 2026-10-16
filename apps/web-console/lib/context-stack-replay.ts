/** Replay frames for the Play context tab. The last frame is the live prepare. */

export interface ReplayBlock {
  id: string;
  kind: string;
  label: string;
  text: string;
  tokens: number;
  chars: number;
  pinned: boolean;
  disposition: 'keep' | 'summarize' | 'dropped';
}

export interface ReplaySnapshot {
  id: string;
  turn: number;
  createdAt: string;
  blocks: ReplayBlock[];
}

export interface ReplayFrame {
  id: string;
  live: boolean;
  turn: number | null;
  createdAt: string | null;
  blocks: ReplayBlock[];
}

export function orderContextSnapshots<T extends { turn: number; createdAt: string; id: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => {
    if (a.turn !== b.turn) return a.turn - b.turn;
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

export function normalizeReplayBlock(block: {
  id?: string;
  kind?: string;
  label?: string;
  text?: string;
  tokens?: number;
  chars?: number;
  pinned?: boolean;
  disposition?: string;
}, index = 0): ReplayBlock {
  const text = typeof block.text === 'string' ? block.text : '';
  const disposition = block.disposition === 'summarize' || block.disposition === 'dropped' ? block.disposition : 'keep';
  return {
    id: block.id || `block-${index}`,
    kind: block.kind || 'user',
    label: block.label ?? '',
    text,
    tokens: typeof block.tokens === 'number' && Number.isFinite(block.tokens) ? Math.max(0, block.tokens) : 0,
    chars: text.length,
    pinned: block.pinned === true,
    disposition
  };
}

/** Stored moments, oldest first, then the live prepared context as the newest frame. */
export function buildContextReplayFrames(
  snapshots: readonly ReplaySnapshot[],
  liveBlocks: readonly ReplayBlock[]
): ReplayFrame[] {
  const history = orderContextSnapshots(snapshots).map((snapshot) => ({
    id: snapshot.id,
    live: false,
    turn: snapshot.turn,
    createdAt: snapshot.createdAt,
    blocks: snapshot.blocks.map((block, index) => normalizeReplayBlock(block, index))
  }));
  return [
    ...history,
    {
      id: 'live',
      live: true,
      turn: null,
      createdAt: null,
      blocks: liveBlocks.map((block, index) => normalizeReplayBlock(block, index))
    }
  ];
}

export function selectContextReplayFrame(frames: readonly ReplayFrame[], index: number): ReplayFrame | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= frames.length) return undefined;
  return frames[index];
}

export function replayFrameIndex(frames: readonly ReplayFrame[], selectedId: string): number {
  if (frames.length === 0) return 0;
  if (selectedId === 'live') return frames.length - 1;
  const found = frames.findIndex((frame) => frame.id === selectedId);
  return found >= 0 ? found : frames.length - 1;
}
