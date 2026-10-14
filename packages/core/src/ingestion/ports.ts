import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchPinnedPublic, webFetchAllowsPrivate, type PublicFetchDeps } from '../net/public-fetch.js';
import type { ImageAssetRecord } from '../types.js';
import type { IngestionSettings } from './settings.js';
import { DEFAULT_DOWNLOAD_MAX_BYTES, defaultIngestionSettings } from './settings.js';

export const DOWNLOAD_MAX_BYTES = DEFAULT_DOWNLOAD_MAX_BYTES;

export interface DownloadResult {
  ok: boolean;
  status: number;
  buffer?: Buffer;
  mimeType?: string;
  error?: string;
}

export interface IngestionPorts {
  sessionId: string;
  settings: IngestionSettings;
  tmpDir: string;
  download(url: string, maxBytes?: number): Promise<DownloadResult>;
  writeFile(filePath: string, data: Buffer | string): void;
  ensureDir(dirPath: string): void;
  uploadsDir(): string;
  persistWorkspace(absPath: string, relPath: string, buf: Buffer): Promise<{ ok: true; relPath: string } | { ok: false; reason: string }>;
  ingestImage(input: {
    buffer: Buffer;
    mimeType: string;
    sourceUrl?: string;
  }): Promise<ImageAssetRecord>;
  archiveText(input: { fileName: string; text: string; fileType: string }): Promise<
    | { ok: true; handle: string; preview: string; pages: number }
    | { ok: false; reason: string }
  >;
}

export async function defaultDownload(
  url: string,
  maxBytes: number,
  timeoutMs = 30_000,
  deps?: PublicFetchDeps
): Promise<DownloadResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchPinnedPublic(url, {
      signal: ctrl.signal,
      allowPrivateHosts: deps?.allowPrivateHosts ?? webFetchAllowsPrivate(),
      resolveHost: deps?.resolveHost,
      request: deps?.request,
      maxRedirects: deps?.maxRedirects
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, error: `下载失败 HTTP ${res.status}` };
    }
    const ct = res.headers.get('content-type')?.split(';')[0]?.trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return {
        ok: false,
        status: res.status,
        error: `文件过大（${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限）`
      };
    }
    return { ok: true, status: res.status, buffer: buf, mimeType: ct };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

export function makeFsPorts(input: {
  sessionId: string;
  stateDir: string;
  settings?: IngestionSettings;
  ingestImage: IngestionPorts['ingestImage'];
  archiveText: IngestionPorts['archiveText'];
}): IngestionPorts {
  const settings = input.settings ?? defaultIngestionSettings();
  const tmp = join(tmpdir(), 'ppeng-ingest', input.sessionId);
  const uploads = join(input.stateDir, 'attachments', input.sessionId);
  return {
    sessionId: input.sessionId,
    settings,
    tmpDir: tmp,
    download: (url, maxBytes) => defaultDownload(url, maxBytes ?? settings.maxBytes),
    writeFile: (filePath, data) => writeFileSync(filePath, data),
    ensureDir: (dirPath) => mkdirSync(dirPath, { recursive: true }),
    uploadsDir: () => uploads,
    persistWorkspace: async (_abs, relPath, buf) => {
      try {
        mkdirSync(uploads, { recursive: true });
        const dest = join(input.stateDir, relPath);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        return { ok: true, relPath };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    ingestImage: input.ingestImage,
    archiveText: input.archiveText
  };
}
