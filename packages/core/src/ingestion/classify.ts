import { extname } from 'node:path';
import { looksBinary } from './encoding-policy.js';
import type { AttachmentKind, ClassifiedAttachment, FetchedAttachment, RawAttachment } from './types.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm', '.xml', '.log', '.tsv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.sh', '.yaml', '.yml', '.toml', '.css', '.sql', '.c', '.cpp', '.h']);
const WORKSPACE_EXT = new Set(['.xlsx', '.xlsm', '.xls', '.docx', '.doc', '.pptx', '.ppt', '.pdf']);

export function extOf(fileName: string): string {
  return extname(fileName || '').toLowerCase();
}

export function isImageFileName(fileName: string, mimeType?: string): boolean {
  if (mimeType && mimeType.toLowerCase().startsWith('image/')) return true;
  return IMAGE_EXT.has(extOf(fileName));
}

export function isTextFileName(fileName: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  return TEXT_EXT.has(extOf(fileName));
}

export function isWorkspaceFileName(fileName: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase() ?? '';
  if (
    mime.includes('officedocument') ||
    mime === 'application/pdf' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/msword'
  ) {
    return true;
  }
  return WORKSPACE_EXT.has(extOf(fileName));
}

/** Expected kind from name/mime only — fetch uses this to decide what to download. */
export function preClassifyKind(raw: RawAttachment): AttachmentKind {
  const mime = raw.mimeType ?? (raw.spec.via !== 'none' ? raw.spec.mimeType : undefined);
  if (isImageFileName(raw.fileName, mime)) return 'image';
  if (isTextFileName(raw.fileName, mime)) return 'rawtext';
  if (isWorkspaceFileName(raw.fileName, mime)) return 'workspace';
  return 'unsupported';
}

export function classify(raw: RawAttachment, fetched: FetchedAttachment['fetched']): ClassifiedAttachment {
  const pre = preClassifyKind(raw);
  if (fetched.skip) {
    return { ...raw, fetched, kind: pre };
  }
  if (fetched.error) {
    return { ...raw, fetched, kind: 'unsupported', reason: fetched.error };
  }
  if (pre === 'rawtext' && fetched.buffer && looksBinary(fetched.buffer)) {
    return { ...raw, fetched, kind: 'unsupported', reason: '文件内容疑似二进制，无法按文本读取' };
  }
  return { ...raw, fetched, kind: pre };
}
