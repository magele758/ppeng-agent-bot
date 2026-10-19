import type { ContextSource, MessagePart, TextPart } from '@ppeng/api-types';
import { fenceExternalContent } from '../safety/external-content.js';

export type { ContextFileSource, ContextFolderEntry, ContextFolderSource, ContextSource } from '@ppeng/api-types';

/** One send accepts at most this many named files and folders. */
export const CONTEXT_SOURCE_LIMIT = 20;
/** Combined file and folder-entry text kept for one send, in JS characters. */
export const CONTEXT_TEXT_CHAR_LIMIT = 200_000;
const NAME_MAX = 1024;

function named(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().slice(0, NAME_MAX);
  return name || undefined;
}

/**
 * Drop sources with no name or missing fields. Keep at most 20 named sources.
 * Text past the combined budget is cut; the name (and folder entry path) stays.
 * A non-array payload is ignored so a bad field cannot fail the send.
 */
export function normalizeContextSources(input: unknown): ContextSource[] {
  if (!Array.isArray(input)) return [];
  const sources: ContextSource[] = [];
  let budget = CONTEXT_TEXT_CHAR_LIMIT;
  const take = (text: string): string => {
    if (budget <= 0) return '';
    if (text.length <= budget) {
      budget -= text.length;
      return text;
    }
    const sliced = text.slice(0, budget);
    budget = 0;
    return sliced;
  };
  for (const item of input) {
    if (sources.length >= CONTEXT_SOURCE_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = named(row.name);
    if (!name) continue;
    if (row.kind === 'file') {
      if (typeof row.text !== 'string') continue;
      sources.push({ kind: 'file', name, text: take(row.text) });
      continue;
    }
    if (row.kind !== 'folder' || !Array.isArray(row.entries)) continue;
    const entries: Array<{ path: string; text: string }> = [];
    for (const entry of row.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const path = named(record.path);
      if (!path || typeof record.text !== 'string') continue;
      entries.push({ path, text: take(record.text) });
    }
    sources.push({ kind: 'folder', name, entries });
  }
  return sources;
}

/** Same untrusted fence the plus-button attachment path uses. Empty bodies are omitted. */
export function contextSourceModelText(sources: readonly ContextSource[]): string {
  const blocks: string[] = [];
  for (const source of sources) {
    if (source.kind === 'file') {
      if (!source.text) continue;
      blocks.push(fenceExternalContent({ source: 'attachment', label: source.name, body: source.text }));
      continue;
    }
    for (const entry of source.entries) {
      if (!entry.text) continue;
      blocks.push(
        fenceExternalContent({
          source: 'attachment',
          label: `${source.name}/${entry.path}`,
          body: entry.text
        })
      );
    }
  }
  return blocks.join('\n\n');
}

/**
 * Attach normalized sources to the user text part and add a fenced text part for the model.
 * Sources are not written when the list is empty.
 */
export function applyContextSources(parts: MessagePart[], sources: readonly ContextSource[]): MessagePart[] {
  if (sources.length === 0) return parts;
  const next = parts.map((part) => ({ ...part }));
  const modelText = contextSourceModelText(sources);
  const carrier = next.find((part): part is TextPart => part.type === 'text');
  const fenced: TextPart | undefined = modelText ? { type: 'text', text: modelText } : undefined;
  if (carrier) {
    carrier.contextSources = [...sources];
    if (fenced) next.splice(next.indexOf(carrier) + 1, 0, fenced);
    return next;
  }
  next.unshift({ type: 'text', text: modelText, contextSources: [...sources] });
  return next;
}
