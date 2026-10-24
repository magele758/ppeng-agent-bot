import { readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { MemorySuppressedError } from '../memory/deletion-suppression.js';
import type { AgentMemoryStore } from '../memory/store.js';
import { sensitiveReadRefusal } from '../workspace/sensitive-read.js';
import { isTextFileName } from './classify.js';
import { decodeTextBytes, looksBinary } from './encoding-policy.js';
import { extractOoxmlText, ooxmlKindOf } from './ooxml-text.js';
import { readIngestionSettings, type IngestionSettings, type IngestionSettingsStore } from './settings.js';

const LIBRARY_SCOPE = 'library' as const;
const MAX_FILES = 5000;
const MAX_DEPTH = 24;

export interface LibraryIndexStore extends IngestionSettingsStore {
  agentMemory(): AgentMemoryStore;
}

export interface LibrarySyncStats {
  indexed: number;
  removed: number;
  roots: string[];
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const abs = resolve(target);
  return abs === base || abs.startsWith(base + sep);
}

function relKey(root: string, file: string): string | undefined {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const key = rel.split(sep).join('/');
  return key.length > 0 && key.length <= 1024 ? key : undefined;
}

function fileText(abs: string, settings: IngestionSettings, home: string): { text: string; stamp: string } | undefined {
  if (sensitiveReadRefusal(abs, home, 'file')) return undefined;
  let size = 0;
  let stamp = '';
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size <= 0 || st.size > settings.maxBytes) return undefined;
    size = st.size;
    stamp = `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return undefined;
  }
  if (size <= 0) return undefined;
  const name = basename(abs);
  let raw: Buffer;
  try {
    raw = readFileSync(abs);
  } catch {
    return undefined;
  }
  const ooxml = ooxmlKindOf(name);
  let text = '';
  if (ooxml) {
    const got = extractOoxmlText(raw, ooxml);
    if (got.kind !== 'text') return undefined;
    text = got.text;
  } else if (isTextFileName(name) && !looksBinary(raw)) {
    text = decodeTextBytes(raw, settings.gbkFallback).text;
  } else {
    return undefined;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const cap = settings.inlineTextMaxBytes;
  return { text: trimmed.length > cap ? trimmed.slice(0, cap) : trimmed, stamp };
}

interface WalkState {
  files: number;
  complete: boolean;
}

function walk(
  root: string,
  dir: string,
  depth: number,
  home: string,
  visited: Set<string>,
  state: WalkState,
  visit: (file: string) => void
): void {
  if (!state.complete) return;
  if (depth > MAX_DEPTH || state.files >= MAX_FILES) {
    state.complete = false;
    return;
  }
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (!isInside(root, realDir) || sensitiveReadRefusal(realDir, home, 'directory')) return;
  if (visited.has(realDir)) return;
  visited.add(realDir);
  let entries;
  try {
    entries = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!state.complete) return;
    const abs = resolve(realDir, entry.name);
    if (entry.isSymbolicLink()) {
      walkSymlink(root, abs, depth, home, visited, state, visit);
      continue;
    }
    if (entry.isDirectory()) {
      if (sensitiveReadRefusal(abs, home, 'directory')) continue;
      walk(root, abs, depth + 1, home, visited, state, visit);
      continue;
    }
    if (!entry.isFile()) continue;
    state.files += 1;
    if (state.files > MAX_FILES) {
      state.complete = false;
      return;
    }
    visit(abs);
  }
}

function resolveRoot(dir: string, home: string): string | undefined {
  try {
    const real = realpathSync(dir);
    if (!statSync(real).isDirectory()) return undefined;
    if (sensitiveReadRefusal(real, home, 'directory')) return undefined;
    if (!isInside(real, real)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

/**
 * Index text from the folders saved in ingestion settings into agent memory scope `library`.
 * Only those folders are walked. Secrets and blocked paths are skipped.
 */
function canonicalHome(home: string): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

export function syncLibraryIndex(store: LibraryIndexStore, options?: { home?: string }): LibrarySyncStats {
  const home = canonicalHome(options?.home ?? homedir());
  const settings = readIngestionSettings(store);
  const memory = store.agentMemory();
  const seen = new Map<string, Set<string>>();
  const incomplete = new Set<string>();
  let indexed = 0;

  for (const dir of settings.libraryDirs) {
    const root = resolveRoot(dir, home);
    if (!root) continue;
    const keys = seen.get(root) ?? new Set<string>();
    seen.set(root, keys);
    const state: WalkState = { files: 0, complete: true };
    try {
      walk(root, root, 0, home, new Set<string>(), state, (file) => {
        const key = relKey(root, file);
        if (!key || sensitiveReadRefusal(file, home, 'file')) return;
        let stamp = '';
        try {
          const st = statSync(file);
          stamp = `${Math.trunc(st.mtimeMs)}:${st.size}`;
        } catch {
          return;
        }
        const existing = memory.search({ scope: LIBRARY_SCOPE, namespace: root, key, limit: 1 })[0];
        if (existing?.source === stamp) {
          keys.add(key);
          return;
        }
        const extracted = fileText(file, settings, home);
        if (!extracted) return;
        try {
          memory.set({
            scope: LIBRARY_SCOPE,
            namespace: root,
            key,
            value: extracted.text,
            source: extracted.stamp,
            importance: 0.8,
            confidence: 'high'
          });
          keys.add(key);
          indexed += 1;
        } catch (error) {
          if (error instanceof MemorySuppressedError) return;
          state.complete = false;
        }
      });
    } catch {
      state.complete = false;
    }
    if (!state.complete) incomplete.add(root);
  }

  let removed = 0;
  const rows = memory.search({ scope: LIBRARY_SCOPE, limit: 20000 });
  for (const row of rows) {
    const keys = seen.get(row.namespace);
    if (!keys) {
      memory.delete(row.id);
      removed += 1;
      continue;
    }
    if (incomplete.has(row.namespace)) continue;
    if (!keys.has(row.key)) {
      memory.delete(row.id);
      removed += 1;
    }
  }

  return { indexed, removed, roots: [...seen.keys()] };
}

/** Watch saved folders and refresh the library index without a process restart. */
export class LibraryIndexWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(
    private readonly store: LibraryIndexStore,
    private readonly options?: { home?: string; debounceMs?: number }
  ) {}

  start(): LibrarySyncStats {
    this.stopped = false;
    this.stopWatchers();
    const stats = syncLibraryIndex(this.store, { home: this.options?.home });
    for (const root of stats.roots) {
      try {
        const watcher = watch(root, { recursive: true }, () => this.schedule());
        watcher.on('error', () => undefined);
        watcher.unref();
        this.watchers.push(watcher);
      } catch {
        /* folder vanished between the scan and the watch */
      }
    }
    return stats;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopWatchers();
  }

  private stopWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      if (this.timer !== timer || this.stopped) return;
      this.timer = undefined;
      try {
        this.start();
      } catch {
        /* a bad file must not take down the process */
      }
    }, this.options?.debounceMs ?? 400);
    timer.unref?.();
    this.timer = timer;
  }
}

function walkSymlink(root: string, abs: string, depth: number, home: string, visited: Set<string>, state: WalkState, visit: (file: string) => void): void {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        return;
      }
      if (!isInside(root, real) || sensitiveReadRefusal(real, home)) return;
      let linked;
      try {
        linked = statSync(real);
      } catch {
        return;
      }
      if (linked.isDirectory()) walk(root, real, depth + 1, home, visited, state, visit);
      else if (linked.isFile()) {
        state.files += 1;
        if (state.files > MAX_FILES) {
          state.complete = false;
          return;
        }
        visit(real);
      }
}
