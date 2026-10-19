/** Dragged files and folders handed to the existing send APIs as `contextSources`. */

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

export function composerClassName(base: string, over: boolean, acknowledged = false): string {
  return `${base}${acknowledged ? ' chat-composer--ack-flash' : ''}${over ? ' is-drop-over' : ''}`;
}

export function composerSendDisabled(blocked: boolean, steerDisabled: boolean, running: boolean, text: string, contexts: readonly ContextSource[]): boolean {
  if (blocked || steerDisabled) return true;
  if (!running) return false;
  return !contextSubmission(text.trim(), contexts).hasContent;
}

export type DroppedItem = {
  kind: string;
  webkitGetAsEntry?: () => FileSystemEntry | null;
  getAsFile?: () => File | null;
};

export type DropPayload = {
  items?: ArrayLike<DroppedItem> | null;
  files?: ArrayLike<File> | null;
};

export type ReadDroppedContextResult = {
  sources: ContextSource[];
  truncated: boolean;
};

type TextBudget = { remaining: number; truncated: boolean };

type Collected =
  | { kind: 'file'; name: string; file: File | null; entry: FileSystemFileEntry | null }
  | { kind: 'folder'; name: string; entry: FileSystemDirectoryEntry };

export function looksLikeBinary(bytes: Uint8Array): boolean {
  const length = Math.min(bytes.length, 8192);
  if (length === 0) return false;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, length));
  let bad = 0;
  for (const char of text) {
    if (char === '\0') return true;
    const code = char.charCodeAt(0);
    if (char === '\uFFFD' || (code < 32 && char !== '\t' && char !== '\n' && char !== '\r')) bad += 1;
  }
  return bad / Math.max(text.length, 1) > 0.02;
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

export async function readDroppedContext(payload: DropPayload): Promise<ReadDroppedContextResult> {
  const budget: TextBudget = { remaining: CONTEXT_TEXT_LIMIT, truncated: false };
  const sources: ContextSource[] = [];
  for (const item of collectSync(payload)) {
    if (item.kind === 'folder') {
      sources.push({ kind: 'folder', name: item.name, entries: await readFolder(item.entry, '', budget) });
      continue;
    }
    const file = item.file ?? (item.entry ? await fileFromEntry(item.entry) : null);
    sources.push({ kind: 'file', name: item.name, text: file ? await textFromFile(file, budget) : '' });
  }
  return { sources, truncated: budget.truncated };
}

function collectSync(payload: DropPayload): Collected[] {
  const items = payload.items ? Array.from(payload.items) : [];
  const fileItems = items.filter((item) => item.kind === 'file');
  if (items.length > 0 && fileItems.length === 0) return [];
  if (fileItems.length > 0) {
    const collected: Collected[] = [];
    for (const item of fileItems) {
      const entry = item.webkitGetAsEntry?.() ?? null;
      if (entry) {
        const name = entry.name.trim();
        if (!name) continue;
        if (entry.isDirectory) {
          collected.push({ kind: 'folder', name, entry: entry as FileSystemDirectoryEntry });
          continue;
        }
        if (entry.isFile) {
          collected.push({ kind: 'file', name, file: null, entry: entry as FileSystemFileEntry });
        }
        continue;
      }
      const file = item.getAsFile?.() ?? null;
      const name = file?.name.trim() ?? '';
      if (!file || !name) continue;
      collected.push({ kind: 'file', name, file, entry: null });
    }
    return collected;
  }
  const files = payload.files ? Array.from(payload.files) : [];
  return files.flatMap((file) => {
    const name = file.name.trim();
    if (!name) return [];
    return [{ kind: 'file' as const, name, file, entry: null }];
  });
}

async function readFolder(
  directory: FileSystemDirectoryEntry,
  prefix: string,
  budget: TextBudget
): Promise<ContextFolderEntry[]> {
  let children: FileSystemEntry[] = [];
  try {
    children = await readAllEntries(directory.createReader());
  } catch {
    return [];
  }
  const entries: ContextFolderEntry[] = [];
  for (const child of children) {
    const name = child.name.trim();
    if (!name) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.isDirectory) {
      entries.push(...(await readFolder(child as FileSystemDirectoryEntry, path, budget)));
      continue;
    }
    if (!child.isFile) continue;
    const file = await fileFromEntry(child as FileSystemFileEntry);
    entries.push({ path, text: file ? await textFromFile(file, budget) : '' });
  }
  return entries;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const read = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          read();
        },
        () => reject(new Error('readEntries failed'))
      );
    };
    read();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null)
    );
  });
}

async function textFromFile(file: File, budget: TextBudget): Promise<string> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return '';
  }
  try {
    const sampleSize = Math.min(file.size, 8192);
    if (sampleSize > 0) {
      const sample = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
      if (looksLikeBinary(sample)) return '';
    }
    const byteCap = Math.min(file.size, budget.remaining * 4 + 4);
    const text = await file.slice(0, byteCap).text();
    if (text.includes('\0')) return '';
    if (byteCap >= file.size && text.length <= budget.remaining) {
      budget.remaining -= text.length;
      return text;
    }
    budget.truncated = true;
    const cut = text.slice(0, budget.remaining);
    budget.remaining = 0;
    return cut;
  } catch {
    return '';
  }
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
