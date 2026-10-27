/**
 * Model-only clock marks. `stampWrittenAt` prefixes them onto the request copy.
 * The model sometimes echoes a line back into the assistant transcript.
 * Hide that line in the bubble. Do not rewrite the saved text.
 */

const ZONE = String.raw`[A-Za-z0-9_+\-/]+`;
const WRITTEN_STAMP = new RegExp(String.raw`^\[written \d{4}-\d{2}-\d{2} \d{2}:\d{2} ${ZONE}\]$`);
const WRITTEN_STAMP_PREFIX = new RegExp(String.raw`^\[written \d{4}-\d{2}-\d{2} \d{2}:\d{2} ${ZONE}\]\s*`);
const CLOCK_LINE = /^\[conversation-clock\](?:\s.*)?$/;
const PARTIAL_WRITTEN_DATE = /^\[written \d{4}-\d{2}-\d{2}\b/;

function isPartialClockOpening(trimmed: string): boolean {
  if (!trimmed || trimmed.includes(']')) return false;
  if (PARTIAL_WRITTEN_DATE.test(trimmed) || trimmed === '[written') return true;
  if (trimmed.startsWith('[w') && '[written '.startsWith(trimmed)) return true;
  if (trimmed.startsWith('[conversation-clock')) return true;
  if (trimmed.startsWith('[c') && '[conversation-clock]'.startsWith(trimmed)) return true;
  return false;
}

/** Drop clock marks from text that is about to be drawn. The argument is not modified. */
export function stripVisibleClockMarks(text: string): string {
  if (!text.includes('[')) return text;
  const normalized = text.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const unfinished = index === lines.length - 1 && !trailingNewline;
    if (CLOCK_LINE.test(trimmed) || WRITTEN_STAMP.test(trimmed)) continue;
    const prefix = WRITTEN_STAMP_PREFIX.exec(trimmed);
    if (prefix && prefix[0].length < trimmed.length) {
      const rest = trimmed.slice(prefix[0].length);
      if (rest) kept.push(rest);
      continue;
    }
    if (unfinished && isPartialClockOpening(trimmed)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}
