/** Stored file and folder context, including historical messages and queued sends. */

export const CONTEXT_TEXT_LIMIT = 200_000;

export type ContextFolderEntry = { path: string; text: string };

export type ContextFileSource = { kind: 'file'; name: string; text: string };

export type ContextFolderSource = { kind: 'folder'; name: string; entries: ContextFolderEntry[] };

export type ContextSource = ContextFileSource | ContextFolderSource;

export type PendingContextSource = ContextSource & { id: string };

export type ContextLabel = { kind: 'file' | 'folder'; name: string };

/** Share attachment presence across image, upload, and dragged-context collections. */
export function composerHasAttachments(...collections: readonly (readonly unknown[])[]): boolean {
  return collections.some(items => items.length > 0);
}

/** Text and dragged context are both valid submissions, including context-only sends. */
export function contextSubmission(text: string, sources: readonly ContextSource[]) {
  return { hasContent: Boolean(text) || sources.length > 0, message: text || '(attachment)' };
}

export function composerClassName(base: string, acknowledged = false): string {
  return `${base}${acknowledged ? ' chat-composer--ack-flash' : ''}`;
}

export function composerSendDisabled(blocked: boolean, steerDisabled: boolean, running: boolean, text: string, contexts: readonly ContextSource[]): boolean {
  if (blocked || steerDisabled) return true;
  if (!running) return false;
  return !contextSubmission(text.trim(), contexts).hasContent;
}

export function withContextIds(sources: readonly ContextSource[]): PendingContextSource[] {
  return sources.map((source) => ({ ...source, id: crypto.randomUUID() }));
}

export function contextSourcesForSend(pending: readonly PendingContextSource[]): ContextSource[] {
  return pending.map((item) => toWire(item));
}

export function contextSourcesBody(
  sources: readonly ContextSource[]
): { contextSources: ContextSource[] } | Record<string, never> {
  if (sources.length === 0) return {};
  return { contextSources: sources.map((source) => toWire(source)) };
}

export function contextLabelsOf(sources: readonly ({ kind?: unknown; name?: unknown } | null | undefined)[]): ContextLabel[] {
  const labels: ContextLabel[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const label = labelOf(source.kind, source.name);
    if (label) labels.push(label);
  }
  return labels;
}

/** Names from a stored message. Missing or odd shapes yield an empty list. */
export function contextLabelsFromMessage(message: unknown): ContextLabel[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const direct = labelsFromUnknown(record.contextSources);
  if (direct.length > 0) return direct;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    const fromMetadata = labelsFromUnknown((metadata as Record<string, unknown>).contextSources);
    if (fromMetadata.length > 0) return fromMetadata;
  }
  return labelsFromParts(record.parts);
}

function labelsFromUnknown(value: unknown): ContextLabel[] {
  if (!Array.isArray(value)) return [];
  return contextLabelsOf(value as Array<{ kind?: unknown; name?: unknown }>);
}

function labelsFromParts(value: unknown): ContextLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: ContextLabel[] = [];
  for (const part of value) {
    if (!part || typeof part !== 'object') continue;
    labels.push(...labelsFromUnknown((part as Record<string, unknown>).contextSources));
  }
  return labels;
}

function labelOf(kind: unknown, name: unknown): ContextLabel | null {
  if ((kind !== 'file' && kind !== 'folder') || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return { kind, name: trimmed };
}

function toWire(source: ContextSource): ContextSource {
  switch (source.kind) {
    case 'file':
      return { kind: 'file', name: source.name, text: source.text };
    case 'folder':
      return {
        kind: 'folder',
        name: source.name,
        entries: source.entries.map((entry) => ({ path: entry.path, text: entry.text }))
      };
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Enforce the server's per-send budget across successive drops. */
export function limitContextSources(input: readonly PendingContextSource[]): { sources: PendingContextSource[]; truncated: boolean } {
  let remaining = CONTEXT_TEXT_LIMIT;
  let truncated = input.length > 20;
  const take = (text: string) => {
    if (text.length > remaining) truncated = true;
    const kept = text.slice(0, remaining);
    remaining -= kept.length;
    return kept;
  };
  const sources = input.slice(0, 20).map(source => source.kind === 'file'
    ? { ...source, text: take(source.text) }
    : { ...source, entries: source.entries.map(entry => ({ ...entry, text: take(entry.text) })) });
  return { sources, truncated };
}
