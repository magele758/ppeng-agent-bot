/** Presentation math for the Play context-stack bar. Colors stay here, not in the API. */

export const CONTEXT_BLOCK_COLORS = {
  system: '#3d6b4f',
  'system-message': '#7d9a84',
  tools: '#c4962c',
  summary: '#d06a2b',
  memory: '#3d6f99',
  'working-log': '#1f7a78',
  user: '#5c8f55',
  assistant: '#6e7894',
  reasoning: '#7a5ea3',
  'tool-call': '#c45c4a',
  'tool-result': '#2f7d6d',
  'tool-stub': '#8d8d8d',
  image: '#a85d86',
  surface: '#4d6fa8',
  'history-sources': '#8c6239'
} as const;

export const CONTEXT_BLOCK_FALLBACK_COLOR = '#8a8580';

export type ContextStackBarKind = keyof typeof CONTEXT_BLOCK_COLORS;

export interface ContextStackBarInput {
  id: string;
  kind: string;
  tokens: number;
  chars: number;
  disposition?: 'keep' | 'summarize' | 'dropped';
}

export interface ContextStackSegment {
  id: string;
  kind: string;
  tokens: number;
  chars: number;
  share: number;
  color: string;
  disposition: 'keep' | 'summarize' | 'dropped';
}

export interface ContextStackLegendItem {
  kind: string;
  color: string;
  tokens: number;
  chars: number;
  share: number;
}

export function colorForContextKind(kind: string): string {
  if (Object.prototype.hasOwnProperty.call(CONTEXT_BLOCK_COLORS, kind)) {
    return CONTEXT_BLOCK_COLORS[kind as ContextStackBarKind];
  }
  return CONTEXT_BLOCK_FALLBACK_COLOR;
}

export function formatContextShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0';
  const pct = share * 100;
  if (pct < 0.1) return '<0.1';
  const text = pct.toFixed(1);
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

export function stackContextSegments(blocks: readonly ContextStackBarInput[]): {
  segments: ContextStackSegment[];
  totalTokens: number;
  totalChars: number;
} {
  const totalTokens = blocks.reduce((sum, block) => sum + Math.max(0, block.tokens), 0);
  const totalChars = blocks.reduce((sum, block) => sum + Math.max(0, block.chars), 0);
  const byTokens = totalTokens > 0;
  const total = byTokens ? totalTokens : totalChars;
  const segments = blocks.map((block) => {
    const weight = byTokens ? Math.max(0, block.tokens) : Math.max(0, block.chars);
    return {
      id: block.id,
      kind: block.kind,
      tokens: Math.max(0, block.tokens),
      chars: Math.max(0, block.chars),
      share: total > 0 ? weight / total : 0,
      color: colorForContextKind(block.kind),
      disposition: block.disposition ?? 'keep'
    };
  });
  return { segments, totalTokens, totalChars };
}

export function contextStackLegend(segments: readonly ContextStackSegment[]): ContextStackLegendItem[] {
  const order: string[] = [];
  const totals = new Map<string, { tokens: number; chars: number }>();
  for (const segment of segments) {
    const current = totals.get(segment.kind);
    if (!current) {
      order.push(segment.kind);
      totals.set(segment.kind, { tokens: segment.tokens, chars: segment.chars });
    } else {
      current.tokens += segment.tokens;
      current.chars += segment.chars;
    }
  }
  const totalTokens = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const totalChars = segments.reduce((sum, segment) => sum + segment.chars, 0);
  const byTokens = totalTokens > 0;
  const total = byTokens ? totalTokens : totalChars;
  return order.map((kind) => {
    const item = totals.get(kind)!;
    const weight = byTokens ? item.tokens : item.chars;
    return {
      kind,
      color: colorForContextKind(kind),
      tokens: item.tokens,
      chars: item.chars,
      share: total > 0 ? weight / total : 0
    };
  });
}
