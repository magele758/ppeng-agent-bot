import { watch, type Dirent, type FSWatcher, type Stats } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
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
/** A read that does not finish is skipped so one file cannot stall later requests. */
const FILE_READ_BUDGET_MS = 2_000;
const OBSIDIAN_META_DIR = '.obsidian';

export interface LibraryIndexStore extends IngestionSettingsStore {
  agentMemory(): AgentMemoryStore;
}

export interface LibrarySyncStats {
  indexed: number;
  removed: number;
  roots: string[];
}

export interface LibrarySyncOptions {
  home?: string;
  /** When this returns false the scan stops and does not delete unseen entries. */
  isCurrent?: () => boolean;
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

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * iCloud evicts file bodies but keeps the logical size. Those placeholders
 * report zero allocated blocks; reading them downloads the body.
 */
function isEvictedCloudFile(st: Stats): boolean {
  return st.isFile() && st.size > 0 && st.blocks === 0;
}

async function readFileBounded(abs: string): Promise<Buffer | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_READ_BUDGET_MS);
  timer.unref();
  try {
    return await readFile(abs, { signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fileText(abs: string, settings: IngestionSettings, home: string): Promise<{ text: string; stamp: string } | undefined> {
  if (sensitiveReadRefusal(abs, home, 'file')) return undefined;
  let size = 0;
  let stamp = '';
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size <= 0 || st.size > settings.maxBytes || isEvictedCloudFile(st)) return undefined;
    size = st.size;
    stamp = `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return undefined;
  }
  if (size <= 0) return undefined;
  const raw = await readFileBounded(abs);
  if (!raw) return undefined;
  const name = basename(abs);
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

interface IndexCounters {
  indexed: number;
}

function stillRunning(options: LibrarySyncOptions | undefined): boolean {
  return options?.isCurrent ? options.isCurrent() : true;
}

async function indexOne(
  file: string,
  root: string,
  home: string,
  settings: IngestionSettings,
  memory: AgentMemoryStore,
  keys: Set<string>,
  state: WalkState,
  counters: IndexCounters,
  options: LibrarySyncOptions | undefined
): Promise<void> {
  await yieldEventLoop();
  if (!stillRunning(options)) {
    state.complete = false;
    return;
  }
  const key = relKey(root, file);
  if (!key || sensitiveReadRefusal(file, home, 'file')) return;
  let stamp = '';
  try {
    const info = await stat(file);
    if (isEvictedCloudFile(info)) return;
    stamp = `${Math.trunc(info.mtimeMs)}:${info.size}`;
  } catch {
    return;
  }
  const existing = memory.search({ scope: LIBRARY_SCOPE, namespace: root, key, limit: 1 })[0];
  if (existing?.source === stamp) {
    keys.add(key);
    return;
  }
  const extracted = await fileText(file, settings, home);
  if (!extracted || !stillRunning(options)) {
    if (!stillRunning(options)) state.complete = false;
    return;
  }
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
    counters.indexed += 1;
  } catch (error) {
    if (error instanceof MemorySuppressedError) return;
    state.complete = false;
  }
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  home: string,
  visited: Set<string>,
  state: WalkState,
  settings: IngestionSettings,
  memory: AgentMemoryStore,
  keys: Set<string>,
  counters: IndexCounters,
  options: LibrarySyncOptions | undefined
): Promise<void> {
  if (!state.complete || !stillRunning(options)) {
    state.complete = false;
    return;
  }
  if (basename(dir) === OBSIDIAN_META_DIR) return;
  if (depth > MAX_DEPTH || state.files >= MAX_FILES) {
    state.complete = false;
    return;
  }
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch {
    return;
  }
  if (!isInside(root, realDir) || sensitiveReadRefusal(realDir, home, 'directory')) return;
  if (visited.has(realDir)) return;
  visited.add(realDir);
  let entries: Dirent[];
  try {
    entries = await readdir(realDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!state.complete || !stillRunning(options)) {
      state.complete = false;
      return;
    }
    if (entry.name === OBSIDIAN_META_DIR) continue;
    const abs = resolve(realDir, entry.name);
    if (entry.isSymbolicLink()) {
      await walkSymlink(root, abs, depth, home, visited, state, settings, memory, keys, counters, options);
      continue;
    }
    if (entry.isDirectory()) {
      if (sensitiveReadRefusal(abs, home, 'directory')) continue;
      await walk(root, abs, depth + 1, home, visited, state, settings, memory, keys, counters, options);
      continue;
    }
    if (!entry.isFile()) continue;
    state.files += 1;
    if (state.files > MAX_FILES) {
      state.complete = false;
      return;
    }
    await indexOne(abs, root, home, settings, memory, keys, state, counters, options);
  }
}

async function walkSymlink(
  root: string,
  abs: string,
  depth: number,
  home: string,
  visited: Set<string>,
  state: WalkState,
  settings: IngestionSettings,
  memory: AgentMemoryStore,
  keys: Set<string>,
  counters: IndexCounters,
  options: LibrarySyncOptions | undefined
): Promise<void> {
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return;
  }
  if (!isInside(root, real) || sensitiveReadRefusal(real, home)) return;
  if (basename(real) === OBSIDIAN_META_DIR) return;
  let linked: Stats;
  try {
    linked = await stat(real);
  } catch {
    return;
  }
  if (linked.isDirectory()) {
    await walk(root, real, depth + 1, home, visited, state, settings, memory, keys, counters, options);
    return;
  }
  if (!linked.isFile()) return;
  state.files += 1;
  if (state.files > MAX_FILES) {
    state.complete = false;
    return;
  }
  await indexOne(real, root, home, settings, memory, keys, state, counters, options);
}

async function resolveRoot(dir: string, home: string): Promise<string | undefined> {
  try {
    const real = await realpath(dir);
    const info = await stat(real);
    if (!info.isDirectory()) return undefined;
    if (sensitiveReadRefusal(real, home, 'directory')) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

async function canonicalHome(home: string): Promise<string> {
  try {
    return await realpath(home);
  } catch {
    return home;
  }
}

async function removeStale(
  memory: AgentMemoryStore,
  seen: Map<string, Set<string>>,
  incomplete: Set<string>,
  options: LibrarySyncOptions | undefined
): Promise<number> {
  let removed = 0;
  const rows = memory.search({ scope: LIBRARY_SCOPE, limit: 20000 });
  for (const row of rows) {
    await yieldEventLoop();
    if (!stillRunning(options)) return removed;
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
  return removed;
}

/**
 * Index text from the folders saved in ingestion settings into agent memory scope `library`.
 * Only those folders are walked. Secrets and blocked paths are skipped.
 * The walk yields between files so a large folder cannot block other requests.
 */
export async function syncLibraryIndex(store: LibraryIndexStore, options?: LibrarySyncOptions): Promise<LibrarySyncStats> {
  await yieldEventLoop();
  if (!stillRunning(options)) return { indexed: 0, removed: 0, roots: [] };
  const home = await canonicalHome(options?.home ?? homedir());
  const settings = readIngestionSettings(store);
  const memory = store.agentMemory();
  const seen = new Map<string, Set<string>>();
  const incomplete = new Set<string>();
  const counters: IndexCounters = { indexed: 0 };

  for (const dir of settings.libraryDirs) {
    if (!stillRunning(options)) return { indexed: counters.indexed, removed: 0, roots: [...seen.keys()] };
    const root = await resolveRoot(dir, home);
    if (!root || basename(root) === OBSIDIAN_META_DIR) continue;
    const keys = seen.get(root) ?? new Set<string>();
    seen.set(root, keys);
    const state: WalkState = { files: 0, complete: true };
    try {
      await walk(root, root, 0, home, new Set<string>(), state, settings, memory, keys, counters, options);
    } catch {
      state.complete = false;
    }
    if (!state.complete || !stillRunning(options)) incomplete.add(root);
  }

  if (!stillRunning(options)) return { indexed: counters.indexed, removed: 0, roots: [...seen.keys()] };
  const removed = await removeStale(memory, seen, incomplete, options);
  return { indexed: counters.indexed, removed, roots: [...seen.keys()] };
}

/** Watch saved folders and refresh the library index without a process restart. */
export class LibraryIndexWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private generation = 0;

  constructor(
    private readonly store: LibraryIndexStore,
    private readonly options?: { home?: string; debounceMs?: number }
  ) {}

  start(): Promise<LibrarySyncStats> {
    this.stopped = false;
    const generation = ++this.generation;
    this.stopWatchers();
    const current = () => generation === this.generation && !this.stopped;
    return this.run(generation, current);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopWatchers();
  }

  private async run(generation: number, current: () => boolean): Promise<LibrarySyncStats> {
    let stats: LibrarySyncStats = { indexed: 0, removed: 0, roots: [] };
    try {
      stats = await syncLibraryIndex(this.store, { home: this.options?.home, isCurrent: current });
    } catch {
      return stats;
    }
    if (!current()) return stats;
    this.installWatchers(stats.roots, generation);
    return stats;
  }

  private installWatchers(roots: string[], generation: number): void {
    if (generation !== this.generation || this.stopped) return;
    this.stopWatchers();
    if (generation !== this.generation || this.stopped) return;
    for (const root of roots) {
      if (generation !== this.generation || this.stopped) {
        this.stopWatchers();
        return;
      }
      try {
        const watcher = watch(root, { recursive: true }, () => this.schedule());
        watcher.on('error', () => undefined);
        watcher.unref();
        this.watchers.push(watcher);
      } catch {
        /* folder vanished between the scan and the watch */
      }
    }
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
      void this.start().catch(() => undefined);
    }, this.options?.debounceMs ?? 400);
    timer.unref?.();
    this.timer = timer;
  }
}
