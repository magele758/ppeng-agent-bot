/**
 * Paged artifact by-reference — long text on disk, model reads by handle/page.
 * Files live under stateDir/artifacts/<sessionId>/.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId, nowIso } from '../id.js';
import { DEFAULT_PAGE_SIZE_CHARS } from '../ingestion/settings.js';

export interface PagedArtifactManifest {
  handle: string;
  sessionId: string;
  sourceTool: string;
  fileName?: string;
  mimeType: string;
  encoding: 'utf-8';
  storageRelPath: string;
  totalBytes: number;
  totalChars: number;
  pageSizeChars: number;
  totalPages: number;
  createdAt: string;
  lastAccessAt?: string;
  kind: 'paged_artifact';
}

export interface PagedArtifactPage {
  handle: string;
  page: number;
  totalPages: number;
  pageSizeChars: number;
  startOffset: number;
  endOffset: number;
  lineStart?: number;
  lineEnd?: number;
  totalChars: number;
  hasNext: boolean;
  nextPage?: number;
  content: string;
}

export interface ArtifactSearchMatch {
  page: number;
  startOffset: number;
  endOffset: number;
  lineStart: number;
  lineEnd: number;
  preview: string;
}

export interface ArtifactSearchResult {
  handle: string;
  query: string;
  mode: 'substring' | 'regex';
  matches: ArtifactSearchMatch[];
  hasMore: boolean;
  totalMatchesEstimate: number;
  totalChars: number;
  /** Set once when the handle is already gone. Callers must not search it again. */
  terminal?: boolean;
  gone?: boolean;
}

const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ARTIFACT_MAX_PER_SESSION = 50;
const ARTIFACT_MAX_BYTES_PER_SESSION = 200 * 1024 * 1024;
const MAX_PAGE_READ_CHARS = 12_000;

export function artifactDir(stateDir: string, sessionId: string): string {
  return join(stateDir, 'artifacts', sessionId);
}

function manifestPath(stateDir: string, sessionId: string, handle: string): string {
  return join(artifactDir(stateDir, sessionId), `${handle}.manifest.json`);
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'tool';
}

export function offsetToLine(text: string, offset: number): number {
  const clamped = Math.min(offset, text.length);
  let line = 1;
  for (let i = 0; i < clamped; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

export function lineToOffset(text: string, lineNumber: number): number {
  if (lineNumber <= 1) return 0;
  let currentLine = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      currentLine++;
      if (currentLine === lineNumber) return i + 1;
    }
  }
  return text.length;
}

function touchManifest(path: string, manifest: PagedArtifactManifest): void {
  try {
    manifest.lastAccessAt = nowIso();
    writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch {
    /* ignore */
  }
}

export function createPagedArtifact(input: {
  stateDir: string;
  sessionId: string;
  sourceTool: string;
  content: string;
  mimeType?: string;
  pageSizeChars?: number;
  preferredExt?: string;
  fileName?: string;
}): PagedArtifactManifest {
  const dir = artifactDir(input.stateDir, input.sessionId);
  mkdirSync(dir, { recursive: true });
  const safeTool = sanitizeFilenamePart(input.sourceTool);
  const handle = createId(`art-${safeTool}`).slice(0, 48);
  const ext = input.preferredExt || (input.mimeType?.includes('json') ? 'json' : 'txt');
  const storageRelPath = `artifacts/${input.sessionId}/${handle}.${ext}`.replace(/\\/g, '/');
  const storagePath = join(input.stateDir, storageRelPath);
  const pageSizeChars = Math.max(100, input.pageSizeChars || DEFAULT_PAGE_SIZE_CHARS);
  writeFileSync(storagePath, input.content, 'utf-8');
  const stat = statSync(storagePath);
  const manifest: PagedArtifactManifest = {
    handle,
    sessionId: input.sessionId,
    sourceTool: input.sourceTool,
    fileName: input.fileName,
    mimeType: input.mimeType || 'text/plain',
    encoding: 'utf-8',
    storageRelPath,
    totalBytes: stat.size,
    totalChars: input.content.length,
    pageSizeChars,
    totalPages: Math.max(1, Math.ceil(input.content.length / pageSizeChars)),
    createdAt: nowIso(),
    kind: 'paged_artifact'
  };
  writeFileSync(manifestPath(input.stateDir, input.sessionId, handle), JSON.stringify(manifest, null, 2), 'utf-8');
  cleanupArtifactDir(input.stateDir, input.sessionId);
  return manifest;
}

export function readPagedArtifactManifest(
  stateDir: string,
  sessionId: string,
  handle: string
): PagedArtifactManifest {
  const path = manifestPath(stateDir, sessionId, handle);
  if (!existsSync(path)) {
    throw new Error(`分页内容不存在: ${handle}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PagedArtifactManifest;
  if (parsed.sessionId !== sessionId) {
    throw new Error(`分页内容不属于当前会话: ${handle}`);
  }
  const abs = join(stateDir, parsed.storageRelPath);
  if (!existsSync(abs)) {
    throw new Error(`分页内容数据文件不存在: ${parsed.storageRelPath}`);
  }
  return parsed;
}

function readContent(stateDir: string, manifest: PagedArtifactManifest): string {
  return readFileSync(join(stateDir, manifest.storageRelPath), 'utf-8');
}

export function readPagedArtifactPage(input: {
  stateDir: string;
  sessionId: string;
  handle: string;
  page?: number;
  maxChars?: number;
}): PagedArtifactPage {
  const manifest = readPagedArtifactManifest(input.stateDir, input.sessionId, input.handle);
  const safePage = Math.min(Math.max(1, input.page || 1), manifest.totalPages);
  const maxChars = Math.min(
    Math.max(1000, input.maxChars || manifest.pageSizeChars),
    Math.max(manifest.pageSizeChars, MAX_PAGE_READ_CHARS)
  );
  const startOffset = (safePage - 1) * manifest.pageSizeChars;
  const content = readContent(input.stateDir, manifest);
  const slice = content.slice(startOffset, startOffset + maxChars);
  const endOffset = startOffset + slice.length;
  touchManifest(manifestPath(input.stateDir, input.sessionId, input.handle), manifest);
  return {
    handle: manifest.handle,
    page: safePage,
    totalPages: manifest.totalPages,
    pageSizeChars: manifest.pageSizeChars,
    startOffset,
    endOffset,
    lineStart: offsetToLine(content, startOffset),
    lineEnd: offsetToLine(content, endOffset),
    totalChars: manifest.totalChars,
    hasNext: safePage < manifest.totalPages,
    nextPage: safePage < manifest.totalPages ? safePage + 1 : undefined,
    content: slice
  };
}

export function readPagedArtifactSlice(input: {
  stateDir: string;
  sessionId: string;
  handle: string;
  startOffset: number;
  maxChars?: number;
}): PagedArtifactPage {
  const manifest = readPagedArtifactManifest(input.stateDir, input.sessionId, input.handle);
  const maxChars = Math.min(
    Math.max(100, input.maxChars || manifest.pageSizeChars),
    Math.max(manifest.pageSizeChars, MAX_PAGE_READ_CHARS)
  );
  const content = readContent(input.stateDir, manifest);
  const safeStart = Math.max(0, Math.min(input.startOffset, manifest.totalChars));
  const slice = content.slice(safeStart, safeStart + maxChars);
  const endOffset = safeStart + slice.length;
  const resolvedPage = Math.floor(safeStart / manifest.pageSizeChars) + 1;
  touchManifest(manifestPath(input.stateDir, input.sessionId, input.handle), manifest);
  return {
    handle: manifest.handle,
    page: resolvedPage,
    totalPages: manifest.totalPages,
    pageSizeChars: manifest.pageSizeChars,
    startOffset: safeStart,
    endOffset,
    lineStart: offsetToLine(content, safeStart),
    lineEnd: offsetToLine(content, endOffset),
    totalChars: manifest.totalChars,
    hasNext: endOffset < manifest.totalChars,
    nextPage: endOffset < manifest.totalChars ? Math.floor(endOffset / manifest.pageSizeChars) + 1 : undefined,
    content: slice
  };
}

export function readPagedArtifactLines(input: {
  stateDir: string;
  sessionId: string;
  handle: string;
  lineStart: number;
  lineEnd: number;
  maxChars?: number;
}): PagedArtifactPage {
  const manifest = readPagedArtifactManifest(input.stateDir, input.sessionId, input.handle);
  const content = readContent(input.stateDir, manifest);
  const safeLineStart = Math.max(1, input.lineStart);
  const safeLineEnd = Math.max(safeLineStart, input.lineEnd);
  const startOffset = lineToOffset(content, safeLineStart);
  const rawEnd = lineToOffset(content, safeLineEnd + 1);
  const endOffset = rawEnd > startOffset ? rawEnd : content.length;
  const maxChars = Math.max(100, input.maxChars || manifest.pageSizeChars);
  const slice = content.slice(startOffset, startOffset + maxChars);
  const actualEnd = startOffset + slice.length;
  const resolvedPage = Math.floor(startOffset / manifest.pageSizeChars) + 1;
  touchManifest(manifestPath(input.stateDir, input.sessionId, input.handle), manifest);
  return {
    handle: manifest.handle,
    page: resolvedPage,
    totalPages: manifest.totalPages,
    pageSizeChars: manifest.pageSizeChars,
    startOffset,
    endOffset: actualEnd,
    lineStart: safeLineStart,
    lineEnd: offsetToLine(content, actualEnd),
    totalChars: manifest.totalChars,
    hasNext: actualEnd < manifest.totalChars,
    nextPage: actualEnd < manifest.totalChars ? Math.floor(actualEnd / manifest.pageSizeChars) + 1 : undefined,
    content: slice
  };
}

function goneArtifactSearch(input: {
  handle: string;
  query: string;
  mode?: 'substring' | 'regex';
}): ArtifactSearchResult {
  return {
    handle: input.handle,
    query: input.query,
    mode: input.mode || 'substring',
    matches: [],
    hasMore: false,
    totalMatchesEstimate: 0,
    totalChars: 0,
    terminal: true,
    gone: true
  };
}

export function searchPagedArtifact(input: {
  stateDir: string;
  sessionId: string;
  handle: string;
  query: string;
  mode?: 'substring' | 'regex';
  maxResults?: number;
  contextChars?: number;
}): ArtifactSearchResult {
  const manifestPathname = manifestPath(input.stateDir, input.sessionId, input.handle);
  if (!existsSync(manifestPathname)) return goneArtifactSearch(input);
  let manifest: PagedArtifactManifest;
  try {
    manifest = readPagedArtifactManifest(input.stateDir, input.sessionId, input.handle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('分页内容不存在') || message.startsWith('分页内容数据文件不存在')) {
      return goneArtifactSearch(input);
    }
    throw error;
  }
  const content = readContent(input.stateDir, manifest);
  const mode = input.mode || 'substring';
  const maxResults = Math.min(Math.max(1, input.maxResults || 20), 100);
  const contextChars = Math.max(50, Math.min(input.contextChars || 200, 800));
  const matches: ArtifactSearchMatch[] = [];
  let totalMatchesEstimate = 0;
  let hasMore = false;

  if (mode === 'substring') {
    const queryLower = input.query.toLowerCase();
    const contentLower = content.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < content.length) {
      const idx = contentLower.indexOf(queryLower, searchFrom);
      if (idx === -1) break;
      totalMatchesEstimate++;
      if (matches.length < maxResults) {
        const matchEnd = idx + input.query.length;
        const ctxStart = Math.max(0, idx - contextChars);
        const ctxEnd = Math.min(content.length, matchEnd + contextChars);
        matches.push({
          page: Math.floor(idx / manifest.pageSizeChars) + 1,
          startOffset: idx,
          endOffset: matchEnd,
          lineStart: offsetToLine(content, idx),
          lineEnd: offsetToLine(content, matchEnd),
          preview: content.slice(ctxStart, ctxEnd)
        });
      } else {
        hasMore = true;
      }
      searchFrom = idx + input.query.length;
    }
  } else {
    let regex: RegExp;
    try {
      regex = new RegExp(input.query, 'gi');
    } catch (e) {
      throw new Error(`无效的正则表达式: ${e instanceof Error ? e.message : String(e)}`);
    }
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      totalMatchesEstimate++;
      if (matches.length < maxResults) {
        const idx = match.index;
        const matchEnd = idx + match[0].length;
        const ctxStart = Math.max(0, idx - contextChars);
        const ctxEnd = Math.min(content.length, matchEnd + contextChars);
        matches.push({
          page: Math.floor(idx / manifest.pageSizeChars) + 1,
          startOffset: idx,
          endOffset: matchEnd,
          lineStart: offsetToLine(content, idx),
          lineEnd: offsetToLine(content, matchEnd),
          preview: content.slice(ctxStart, ctxEnd)
        });
      } else {
        hasMore = true;
      }
      if (match[0].length === 0) regex.lastIndex++;
    }
  }

  touchManifest(manifestPath(input.stateDir, input.sessionId, input.handle), manifest);
  return {
    handle: manifest.handle,
    query: input.query,
    mode,
    matches,
    hasMore,
    totalMatchesEstimate,
    totalChars: manifest.totalChars
  };
}

export function formatArchivePreview(input: {
  fileName: string;
  fileType: string;
  sizeBytes: number;
  inlineMaxBytes: number;
  previewChars: number;
  manifest: PagedArtifactManifest;
  fullText: string;
}): string {
  const preview = input.fullText.slice(0, input.previewChars);
  const truncatedSuffix =
    input.fullText.length > input.previewChars
      ? `\n\n[预览到此截断，剩余 ${input.fullText.length - input.previewChars} 字符在 artifact 中，可用上述工具读取]`
      : '';
  return (
    `【文件分析结果 · 已归档】\n` +
    `文件名: ${input.fileName}\n` +
    `类型: ${input.fileType}\n` +
    `大小: ${(input.sizeBytes / 1024).toFixed(1)} KB（超过 ${(input.inlineMaxBytes / 1024).toFixed(0)}KB 内联上限，完整正文已落盘）\n` +
    `Artifact Handle: \`${input.manifest.handle}\`（共 ${input.manifest.totalPages} 页 / ${input.manifest.totalChars} 字符）\n` +
    `---\n` +
    `请按需查阅：\n` +
    `  • 关键词定位: \`search_artifact_content(handle="${input.manifest.handle}", query="...")\`\n` +
    `  • 浏览首页: \`read_artifact_page(handle="${input.manifest.handle}", page=1)\`\n` +
    `  • 跳转任意页: \`read_artifact_page(handle="${input.manifest.handle}", page=N)\`\n\n` +
    `预览（前 ${input.previewChars} 字符）：\n\n${preview}${truncatedSuffix}`
  );
}

export function formatToolResultArchivePreview(manifest: PagedArtifactManifest, previewChars: number, fullText: string): string {
  const preview = fullText.slice(0, previewChars);
  return (
    `【工具结果 · 已归档为分页 artifact】\n` +
    `来源工具: ${manifest.sourceTool}\n` +
    `Artifact Handle: \`${manifest.handle}\`（共 ${manifest.totalPages} 页 / ${manifest.totalChars} 字符）\n` +
    `完整内容已落盘；retrieve_tool_result 仍可用于历史 stub。\n` +
    `  • search_artifact_content(handle="${manifest.handle}", query="...")\n` +
    `  • read_artifact_page(handle="${manifest.handle}", page=1)\n\n` +
    `预览：\n${preview}${fullText.length > previewChars ? '\n…' : ''}`
  );
}

export function listArtifactManifests(stateDir: string, sessionId: string): PagedArtifactManifest[] {
  const dir = artifactDir(stateDir, sessionId);
  if (!existsSync(dir)) return [];
  const out: PagedArtifactManifest[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.manifest.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as PagedArtifactManifest);
    } catch {
      /* skip corrupt */
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function cleanupArtifactDir(stateDir: string, sessionId: string): void {
  const dir = artifactDir(stateDir, sessionId);
  if (!existsSync(dir)) return;
  const entries: Array<{ manifestPath: string; dataPath: string; lastAccessAt: number; totalBytes: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.manifest.json')) continue;
    const mp = join(dir, f);
    try {
      const m = JSON.parse(readFileSync(mp, 'utf-8')) as PagedArtifactManifest;
      entries.push({
        manifestPath: mp,
        dataPath: join(stateDir, m.storageRelPath),
        lastAccessAt: Date.parse(m.lastAccessAt ?? m.createdAt) || 0,
        totalBytes: m.totalBytes ?? 0
      });
    } catch {
      try {
        unlinkSync(mp);
      } catch {
        /* ignore */
      }
    }
  }
  const now = Date.now();
  const deleteEntry = (e: (typeof entries)[number]) => {
    try {
      unlinkSync(e.manifestPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(e.dataPath);
    } catch {
      /* ignore */
    }
  };
  const alive = entries.filter((e) => {
    if (now - e.lastAccessAt > ARTIFACT_TTL_MS) {
      deleteEntry(e);
      return false;
    }
    return true;
  });
  alive.sort((a, b) => a.lastAccessAt - b.lastAccessAt);
  while (alive.length > ARTIFACT_MAX_PER_SESSION) {
    deleteEntry(alive.shift()!);
  }
  let totalBytes = alive.reduce((sum, e) => sum + e.totalBytes, 0);
  while (totalBytes > ARTIFACT_MAX_BYTES_PER_SESSION && alive.length > 0) {
    const oldest = alive.shift()!;
    totalBytes -= oldest.totalBytes;
    deleteEntry(oldest);
  }
}

export function deleteArtifactDir(stateDir: string, sessionId: string): void {
  const dir = artifactDir(stateDir, sessionId);
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function resolveArtifactAbsPath(stateDir: string, manifest: PagedArtifactManifest): string {
  return join(stateDir, manifest.storageRelPath);
}
