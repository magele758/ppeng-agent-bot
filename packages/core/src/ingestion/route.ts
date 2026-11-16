import { extname } from 'node:path';
import { extractOoxmlText, ooxmlKindOf } from './ooxml-text.js';
import { textFileTypeLabel } from './emit.js';
import { originalPath, type IngestionPorts } from './ports.js';
import type { DecodedAttachment, ResolvedAttachment, StorageRoute } from './types.js';

export interface RouteContext {
  ports: IngestionPorts;
}

function clampToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf-8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function extractWorkspaceText(
  d: DecodedAttachment,
  inlineMax: number
): {
  text?: string;
  truncated?: boolean;
  textUnavailable?: string;
  pdfPlaceholder?: boolean;
  fullText?: string;
} {
  const ext = extname(d.fileName).toLowerCase();
  if (ext === '.pdf') {
    return { pdfPlaceholder: true };
  }
  const kind = ooxmlKindOf(d.fileName);
  if (kind === null) return {};
  const buf = d.fetched.buffer;
  if (!buf) return {};
  const got = extractOoxmlText(buf, kind);
  if (got.kind === 'unreadable') {
    return { textUnavailable: got.reason };
  }
  const bytes = Buffer.byteLength(got.text, 'utf-8');
  if (bytes <= inlineMax) return { text: got.text };
  return { text: clampToBytes(got.text, inlineMax), truncated: true, fullText: got.text };
}

function safeFileName(fileName: string, index: number): string {
  return `${index}_${(fileName || `file_${index}`)
    .replace(/[\\/\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 120)}`;
}

export async function route(d: DecodedAttachment, ctx: RouteContext): Promise<ResolvedAttachment> {
  const decided = await decideRoute(d, ctx);
  return { ...d, route: decided };
}

async function decideRoute(d: DecodedAttachment, ctx: RouteContext): Promise<StorageRoute> {
  if (d.fetched.skip) {
    return { mode: 'skip', reason: d.fetched.skipReason };
  }

  switch (d.kind) {
    case 'unsupported':
      return { mode: 'unsupported', reason: d.reason ?? 'unsupported' };

    case 'image': {
      const buf = d.fetched.buffer;
      if (!buf) return { mode: 'skip', reason: '图片缺少字节' };
      try {
        const asset = await ctx.ports.ingestImage({
          buffer: buf,
          mimeType: d.fetched.mimeType || d.mimeType || 'image/png',
          sourceUrl: d.spec.via === 'url' ? d.spec.url : undefined
        });
        return { mode: 'inline-image', imageAssetId: asset.id };
      } catch (e) {
        return { mode: 'unsupported', reason: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'workspace': {
      const buf = d.fetched.buffer;
      if (!buf) return { mode: 'workspace-failed', reason: '下载结果缺少文件字节' };
      const { sessionId, attachmentId } = ctx.ports;
      const relPath = attachmentId
        ? originalPath(sessionId, attachmentId, d.fileName)
        : `attachments/${sessionId}/${safeFileName(d.fileName, d.index)}`;
      const saved = await ctx.ports.persistWorkspace(relPath, relPath, buf);
      if (saved.ok === false) {
        return { mode: 'workspace-failed', reason: saved.reason };
      }
      const extracted = extractWorkspaceText(d, ctx.ports.settings.inlineTextMaxBytes);
      if (extracted.fullText) {
        const archived = await ctx.ports.archiveText({
          fileName: d.fileName,
          text: extracted.fullText,
          fileType: textFileTypeLabel(d)
        });
        if (archived.ok) {
          return {
            mode: 'workspace',
            relPath: saved.relPath,
            text: archived.preview,
            handle: archived.handle,
            truncated: true
          };
        }
      }
      return {
        mode: 'workspace',
        relPath: saved.relPath,
        text: extracted.text,
        truncated: extracted.truncated,
        textUnavailable: extracted.textUnavailable,
        pdfPlaceholder: extracted.pdfPlaceholder
      };
    }

    case 'rawtext': {
      const text = d.decodedText ?? '';
      const sizeBytes = Buffer.byteLength(text, 'utf-8');
      if (sizeBytes <= ctx.ports.settings.inlineTextMaxBytes) {
        return { mode: 'inline', text };
      }
      const archived = await ctx.ports.archiveText({
        fileName: d.fileName,
        text,
        fileType: textFileTypeLabel(d)
      });
      if (archived.ok === false) {
        return { mode: 'archive-failed', reason: archived.reason };
      }
      return {
        mode: 'archive',
        handle: archived.handle,
        preview: archived.preview,
        pages: archived.pages
      };
    }

    default: {
      const _never: never = d.kind;
      void _never;
      return { mode: 'skip', reason: '无可处理来源' };
    }
  }
}
