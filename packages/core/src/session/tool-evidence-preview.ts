/** Bounded views preserve the diagnostic tail. Stored tool results remain untouched. */
export function headTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = `\n…[pruned ${text.length} chars; head/tail shown]\n`;
  const room = Math.max(0, limit - marker.length);
  const head = Math.floor(room * 0.4);
  return text.slice(0, head) + marker + (room > head ? text.slice(-(room - head)) : '');
}

function compactValue(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return headTail(value, Math.max(80, limit));
  if (!value || typeof value !== 'object') return value;
  if (depth >= 4) return headTail(JSON.stringify(value), Math.max(80, limit));
  if (Array.isArray(value)) {
    const selected = value.length > 8 ? [...value.slice(0, 4), { omittedItems: value.length - 8 }, ...value.slice(-4)] : value;
    return selected.map(item => compactValue(item, Math.floor(limit / selected.length), depth + 1));
  }
  const entries = Object.entries(value);
  return Object.fromEntries(entries.map(([key, item]) => [key, compactValue(item, Math.floor(limit / Math.max(1, entries.length)), depth + 1)]));
}

export function toolEvidencePreview(content: string, limit = 400): string {
  if (content.length <= limit) return content;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const compact = JSON.stringify(compactValue(parsed, limit));
      if (compact.length < content.length && compact.length <= limit * 2) return compact;
    }
  } catch { /* Plain command output. */ }
  return headTail(content, limit);
}
