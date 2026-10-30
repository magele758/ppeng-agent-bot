import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaPart } from '../types.js';
import { MediaInputError, validateMediaMime } from './media-content.js';

export interface ReadMediaFileOptions {
  mimeType?: string;
  /** Default 6 MiB raw; provider limits still apply to the entire request. */
  maxBytes?: number;
  assetId?: string;
  signal?: AbortSignal;
}
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.amr': 'audio/amr', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mpeg': 'video/mpeg', '.avi': 'video/x-msvideo',
};
function mediaFileType(path: string, override?: string): { type: MediaPart['type']; mimeType: string } {
  const mimeType = override ?? MIME_TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new MediaInputError('Unknown media file type; supply mimeType explicitly.');
  const type = mimeType.split('/')[0];
  if (type !== 'image' && type !== 'audio' && type !== 'video') throw new MediaInputError('Only image, audio and video files are supported.');
  validateMediaMime({ type, mimeType });
  return { type, mimeType };
}
/** Explicit host-authorized file read. Never interprets paths supplied inside messages. */
export async function readMediaFile(path: string, options: ReadMediaFileOptions = {}): Promise<MediaPart> {
  options.signal?.throwIfAborted();
  const kind = mediaFileType(path, options.mimeType);
  const limit = options.maxBytes ?? 6 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new MediaInputError('Media byte limit must be a positive safe integer.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new MediaInputError('Media path must be a regular file.');
    if (stat.size > limit) throw new MediaInputError('Media file exceeds byte limit. Use a provider-accessible URL or raise maxBytes.');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ signal: options.signal, autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new MediaInputError('Media file exceeds byte limit.');
      chunks.push(chunk as Buffer);
    }
    options.signal?.throwIfAborted();
    if (size === 0) throw new MediaInputError('Media file is empty.');
    return { ...kind, assetId: options.assetId ?? randomUUID(), source: { type: 'base64', data: Buffer.concat(chunks).toString('base64') } };
  } finally { await handle.close(); }
}
