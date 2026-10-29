/**
 * Sole port for model-facing tool results that are too large to inline.
 *
 * `retain` persists the full text and returns a page reference plus a short
 * preview. Callers must put `text` back into the loop. A later `readPage` /
 * `search` on a new port instance reads the same files.
 */

import { resolve, sep } from 'node:path';
import {
  createPagedArtifact,
  formatToolResultArchivePreview,
  readPagedArtifactLines,
  readPagedArtifactManifest,
  readPagedArtifactPage,
  readPagedArtifactSlice,
  resolveArtifactAbsPath,
  searchPagedArtifact,
  type ArtifactSearchResult,
  type PagedArtifactManifest,
  type PagedArtifactPage
} from './paged-artifact.js';
import { defaultIngestionSettings, type IngestionSettings } from '../ingestion/settings.js';
import type { ArtifactIndexRecord } from '../stores/artifact-store.js';

const READ_BACK_SOURCES = new Set(['read_artifact_page', 'search_artifact_content', 'retrieve_tool_result']);

export interface DurableArtifactRef {
  handle: string;
  sessionId: string;
  source: string;
  totalPages: number;
  totalChars: number;
  pageSizeChars: number;
  preview: string;
}

export type DurableArtifactRetainResult =
  | { mode: 'inline'; text: string }
  | { mode: 'ref'; ref: DurableArtifactRef; text: string };

export type ArtifactLocateResult =
  | { found: true; manifest: PagedArtifactManifest; absPath: string }
  | { found: false; reason: 'missing' | 'forbidden' };

export interface DurableArtifactReadInput {
  sessionId: string;
  handle: string;
  page?: number;
  startOffset?: number;
  lineStart?: number;
  lineEnd?: number;
  maxChars?: number;
}

export interface DurableArtifactPort {
  /** Persist oversized text. `text` is what the model loop should see. */
  retain(input: {
    sessionId: string;
    source: string;
    content: string;
    mimeType?: string;
    fileName?: string;
  }): DurableArtifactRetainResult;
  readPage(input: DurableArtifactReadInput): PagedArtifactPage;
  search(input: {
    sessionId: string;
    handle: string;
    query: string;
    mode?: 'substring' | 'regex';
    maxResults?: number;
    contextChars?: number;
  }): ArtifactSearchResult;
  /** Resolve a stored artifact for an existing download. Wrong session is forbidden. */
  locate(input: { sessionId: string; handle: string }): ArtifactLocateResult;
}

export interface DurableArtifactPortOptions {
  stateDir: string;
  /** Read per call so a saved Lab change applies immediately. */
  settings?: IngestionSettings | (() => IngestionSettings);
  onRetained?: (manifest: PagedArtifactManifest) => void;
}

export function artifactIndexFromManifest(manifest: PagedArtifactManifest): ArtifactIndexRecord {
  return {
    id: manifest.handle,
    sessionId: manifest.sessionId,
    sourceTool: manifest.sourceTool,
    fileName: manifest.fileName,
    mimeType: manifest.mimeType,
    localRelPath: manifest.storageRelPath,
    totalBytes: manifest.totalBytes,
    totalChars: manifest.totalChars,
    pageSizeChars: manifest.pageSizeChars,
    totalPages: manifest.totalPages,
    createdAt: manifest.createdAt
  };
}

function currentSettings(opts: DurableArtifactPortOptions): IngestionSettings {
  if (!opts.settings) return defaultIngestionSettings();
  return typeof opts.settings === 'function' ? opts.settings() : opts.settings;
}

function staysInline(source: string, content: string, settings: IngestionSettings): boolean {
  if (READ_BACK_SOURCES.has(source)) return true;
  if (!settings.enabled) return true;
  return content.length <= settings.toolResultArchiveChars;
}

function pathInside(root: string, target: string): boolean {
  const base = resolve(root);
  const abs = resolve(target);
  return abs === base || abs.startsWith(base + sep);
}

function locateFailure(error: unknown): ArtifactLocateResult {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('不属于当前会话')) return { found: false, reason: 'forbidden' };
  return { found: false, reason: 'missing' };
}

export function createDurableArtifactPort(opts: DurableArtifactPortOptions): DurableArtifactPort {
  const { stateDir } = opts;
  return {
    retain(input) {
      const settings = currentSettings(opts);
      if (staysInline(input.source, input.content, settings)) {
        return { mode: 'inline', text: input.content };
      }
      const manifest = createPagedArtifact({
        stateDir,
        sessionId: input.sessionId,
        sourceTool: input.source,
        content: input.content,
        mimeType: input.mimeType || 'text/plain',
        pageSizeChars: settings.pageSizeChars,
        fileName: input.fileName || `${input.source}.txt`
      });
      try {
        opts.onRetained?.(manifest);
      } catch {
        /* index is best-effort; the file remains readable by handle */
      }
      const text = formatToolResultArchivePreview(manifest, settings.archivePreviewChars, input.content);
      const preview = input.content.slice(0, settings.archivePreviewChars);
      return {
        mode: 'ref',
        ref: {
          handle: manifest.handle,
          sessionId: manifest.sessionId,
          source: manifest.sourceTool,
          totalPages: manifest.totalPages,
          totalChars: manifest.totalChars,
          pageSizeChars: manifest.pageSizeChars,
          preview
        },
        text
      };
    },
    readPage(input) {
      if (typeof input.startOffset === 'number') {
        return readPagedArtifactSlice({
          stateDir,
          sessionId: input.sessionId,
          handle: input.handle,
          startOffset: input.startOffset,
          maxChars: input.maxChars
        });
      }
      if (typeof input.lineStart === 'number') {
        return readPagedArtifactLines({
          stateDir,
          sessionId: input.sessionId,
          handle: input.handle,
          lineStart: input.lineStart,
          lineEnd: input.lineEnd ?? input.lineStart,
          maxChars: input.maxChars
        });
      }
      return readPagedArtifactPage({
        stateDir,
        sessionId: input.sessionId,
        handle: input.handle,
        page: input.page ?? 1,
        maxChars: input.maxChars
      });
    },
    search(input) {
      return searchPagedArtifact({
        stateDir,
        sessionId: input.sessionId,
        handle: input.handle,
        query: input.query,
        mode: input.mode,
        maxResults: input.maxResults,
        contextChars: input.contextChars
      });
    },
    locate(input) {
      try {
        const manifest = readPagedArtifactManifest(stateDir, input.sessionId, input.handle);
        const absPath = resolveArtifactAbsPath(stateDir, manifest);
        if (!pathInside(stateDir, absPath)) return { found: false, reason: 'forbidden' };
        return { found: true, manifest, absPath };
      } catch (error) {
        return locateFailure(error);
      }
    }
  };
}
