import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NotFoundError, ValidationError } from '../errors.js';
import { createId, nowIso } from '../id.js';
import { ingestImageAsset } from '../image-assets.js';
import { fenceExternalContent } from '../safety/external-content.js';
import type { Logger } from '../logger.js';
import type { SqliteStateStore } from '../storage.js';
import type { ImageAssetRecord } from '../types.js';
import { createPagedArtifact, formatArchivePreview } from '../artifact/paged-artifact.js';
import { makeFsPorts } from './ports.js';
import { runIngestion } from './pipeline.js';
import type { AttachmentInput } from './normalize.js';
import { resolveIngestionSettings } from './settings.js';
import type { AttachmentKind } from './types.js';
import type { AttachmentStatus } from './status.js';

export interface AttachmentRecord {
  id: string;
  sessionId: string;
  fileName: string;
  mimeType?: string;
  kind: AttachmentKind;
  sourceType: 'upload' | 'url';
  sourceUrl?: string;
  localRelPath?: string;
  sizeBytes: number;
  status: AttachmentStatus['state'];
  statusReason?: string;
  encoding?: 'utf-8' | 'gbk';
  imageAssetId?: string;
  artifactHandle?: string;
  emitText?: string;
  createdAt: string;
}

export interface AttachmentStoreApi {
  createAttachment(row: AttachmentRecord): AttachmentRecord;
  getAttachment(id: string): AttachmentRecord | undefined;
  listAttachmentsForSession(sessionId: string): AttachmentRecord[];
}

export interface AttachmentIngestCtx {
  store: SqliteStateStore;
  stateDir: string;
  log: Logger;
}

function fenceAttachmentEmit(fileName: string | undefined, text: string): string | undefined {
  if (!text) return undefined;
  return fenceExternalContent({
    source: 'attachment',
    label: fileName || 'file',
    body: text
  });
}

function stripDataUrl(b64: string): string {
  const t = b64.trim();
  if (!t.startsWith('data:')) return t;
  const comma = t.indexOf(',');
  return comma >= 0 ? t.slice(comma + 1) : '';
}

export class AttachmentIngestService {
  constructor(private readonly ctx: AttachmentIngestCtx) {}

  expandForMessage(
    _sessionId: string,
    attachmentIds?: string[]
  ): { imageAssetIds: string[]; textParts: string[] } {
    const imageAssetIds: string[] = [];
    const textParts: string[] = [];
    for (const id of attachmentIds ?? []) {
      const row = this.ctx.store.getAttachment(id);
      if (!row) continue;
      if (row.imageAssetId) imageAssetIds.push(row.imageAssetId);
      if (row.emitText) textParts.push(row.emitText);
    }
    return { imageAssetIds, textParts };
  }

  async ingestBase64(
    sessionId: string,
    input: { dataBase64: string; mimeType?: string; fileName?: string }
  ): Promise<{ attachment: AttachmentRecord; imageAsset?: ImageAssetRecord; statuses: AttachmentStatus[] }> {
    const session = this.ctx.store.getSession(sessionId);
    if (!session) throw new NotFoundError('Session', sessionId);
    const dataBase64 = stripDataUrl(String(input.dataBase64 ?? ''));
    if (!dataBase64) throw new ValidationError('Missing dataBase64');
    return this.ingestOne(sessionId, {
      fileName: input.fileName || 'upload.bin',
      mimeType: input.mimeType,
      base64: dataBase64
    });
  }

  async ingestFromUrl(
    sessionId: string,
    input: { url: string; fileName?: string; mimeType?: string }
  ): Promise<{ attachment: AttachmentRecord; imageAsset?: ImageAssetRecord; statuses: AttachmentStatus[] }> {
    const session = this.ctx.store.getSession(sessionId);
    if (!session) throw new NotFoundError('Session', sessionId);
    const url = String(input.url ?? '').trim();
    if (!url) throw new ValidationError('Missing url');
    return this.ingestOne(sessionId, {
      fileName: input.fileName || url.split('/').pop() || 'remote.bin',
      mimeType: input.mimeType,
      url
    });
  }

  private async ingestOne(
    sessionId: string,
    file: AttachmentInput
  ): Promise<{ attachment: AttachmentRecord; imageAsset?: ImageAssetRecord; statuses: AttachmentStatus[] }> {
    const settings = resolveIngestionSettings(this.ctx.store);
    const ports = makeFsPorts({
      sessionId,
      stateDir: this.ctx.stateDir,
      settings,
      ingestImage: async ({ buffer, mimeType, sourceUrl }) =>
        ingestImageAsset(this.ctx.store, this.ctx.stateDir, {
          sessionId,
          buffer,
          mimeType,
          sourceType: sourceUrl ? 'url' : 'upload',
          sourceUrl
        }),
      archiveText: async ({ fileName, text, fileType }) => {
        try {
          const manifest = createPagedArtifact({
            stateDir: this.ctx.stateDir,
            sessionId,
            sourceTool: 'user_upload',
            content: text,
            mimeType: 'text/plain',
            pageSizeChars: settings.pageSizeChars,
            fileName
          });
          this.ctx.store.createArtifactIndex({
            id: manifest.handle,
            sessionId,
            sourceTool: manifest.sourceTool,
            fileName,
            mimeType: manifest.mimeType,
            localRelPath: manifest.storageRelPath,
            totalBytes: manifest.totalBytes,
            totalChars: manifest.totalChars,
            pageSizeChars: manifest.pageSizeChars,
            totalPages: manifest.totalPages,
            createdAt: manifest.createdAt
          });
          return {
            ok: true as const,
            handle: manifest.handle,
            pages: manifest.totalPages,
            preview: formatArchivePreview({
              fileName,
              fileType,
              sizeBytes: Buffer.byteLength(text, 'utf-8'),
              inlineMaxBytes: settings.inlineTextMaxBytes,
              previewChars: settings.archivePreviewChars,
              manifest,
              fullText: text
            })
          };
        } catch (e) {
          return { ok: false as const, reason: e instanceof Error ? e.message : String(e) };
        }
      }
    });

    const result = await runIngestion({ files: [file], ports });
    const resolved = result.resolved[0];
    const status = result.statuses[0];
    const emitText = result.contentParts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n');

    let localRelPath: string | undefined;
    let sizeBytes = 0;
    if (resolved?.fetched.buffer) {
      sizeBytes = resolved.fetched.buffer.length;
      if (resolved.route.mode === 'workspace') {
        localRelPath = resolved.route.relPath;
      } else if (resolved.kind !== 'image') {
        const id = createId('att');
        localRelPath = `attachments/${sessionId}/${id}_${(file.fileName || 'file').replace(/[\\/]/g, '_')}`;
        const abs = join(this.ctx.stateDir, localRelPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, resolved.fetched.buffer);
      }
    }

    const artifactHandle =
      resolved?.route.mode === 'archive' ? resolved.route.handle : undefined;
    const imageAssetId =
      resolved?.route.mode === 'inline-image' ? resolved.route.imageAssetId : result.imageAssetIds[0];

    const attachment: AttachmentRecord = {
      id: createId('att'),
      sessionId,
      fileName: file.fileName || 'file',
      mimeType: file.mimeType ?? resolved?.fetched.mimeType,
      kind: resolved?.kind ?? 'unsupported',
      sourceType: file.base64 ? 'upload' : 'url',
      sourceUrl: file.url,
      localRelPath,
      sizeBytes,
      status: status?.state ?? 'failed',
      statusReason: status?.reason,
      encoding: resolved?.encoding,
      imageAssetId,
      artifactHandle,
      emitText: fenceAttachmentEmit(file.fileName, emitText),
      createdAt: nowIso()
    };
    this.ctx.store.createAttachment(attachment);
    const imageAsset = imageAssetId ? this.ctx.store.getImageAsset(imageAssetId) : undefined;
    return { attachment, imageAsset, statuses: result.statuses };
  }
}
