import type { MediaPart, MessagePart, ModelTurnInput, SessionMessage } from '../types.js';

/** Wire dialect, not a claim that all models support all modalities. */
export type MediaProfile = 'openai' | 'qwen-omni';
type MediaProtocol = 'chat_completions' | 'responses' | 'anthropic';
interface MediaContentOptions {
  protocol: MediaProtocol;
  profile?: MediaProfile;
  resolveImage?: ModelTurnInput['resolveImageDataUrl'];
  resolveMedia?: ModelTurnInput['resolveMediaDataUrl'];
  signal?: AbortSignal;
}
export class MediaInputError extends Error {
  readonly status = 400;
  readonly code = 'invalid_media_input';
  constructor(message: string) { super(message); this.name = 'MediaInputError'; }
}
export function isMediaPart(part: { type: string }): part is MediaPart {
  return part.type === 'image' || part.type === 'audio' || part.type === 'video';
}
export function assertMediaProtocol(messages: SessionMessage[], protocol: MediaProtocol, profile: MediaProfile = 'openai'): void {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'audio' && part.type !== 'video') continue;
      assertAudioVideoProtocol(part, message.role, protocol, profile);
    }
  }
}
function assertAudioVideoProtocol(part: MediaPart, role: string, protocol: MediaProtocol, profile: MediaProfile): void {
  if (role !== 'user') throw new MediaInputError('Audio/video input must be in a user observation message.');
  if (protocol !== 'chat_completions') throw new MediaInputError(`${protocol} does not support native ${part.type} input in this SDK. Use a compatible Chat Completions model.`);
  if (part.type === 'video' && profile !== 'qwen-omni') throw new MediaInputError('Native video requires mediaProfile: qwen-omni and a video-capable endpoint.');
}
export function validateMediaMime(part: Pick<MediaPart, 'type' | 'mimeType'>): void {
  if (!new RegExp(`^${part.type}/[a-zA-Z0-9.+-]+$`).test(part.mimeType)) throw new MediaInputError(`Invalid ${part.type} MIME type.`);
}
function validateBase64(data: string): void {
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new MediaInputError('Media data must be non-empty padded Base64.');
  }
}
function validateMediaUrl(url: string, part: MediaPart): string {
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (!match || match[1] !== part.mimeType) throw new MediaInputError('Media data URL MIME type does not match the part.');
    validateBase64(match[2]!);
    return url;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new MediaInputError('Invalid media URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new MediaInputError('Media URLs must use HTTPS without embedded credentials.');
  return url;
}
async function resolveAsset(part: MediaPart, options: MediaContentOptions): Promise<string | undefined> {
  const url = await options.resolveMedia?.(part, options.signal);
  if (url) return url;
  if (part.type === 'image') return options.resolveImage?.(part.assetId, options.signal);
  return undefined;
}
async function resolveMediaUrl(part: MediaPart, options: MediaContentOptions): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  if (part.type === 'image' && !part.source && !options.resolveMedia) {
    const legacyUrl = await options.resolveImage?.(part.assetId, options.signal);
    options.signal?.throwIfAborted();
    return legacyUrl;
  }
  validateMediaMime(part);
  if (part.source?.type === 'base64') {
    validateBase64(part.source.data);
    return `data:${part.mimeType};base64,${part.source.data}`;
  }
  if (part.source?.type === 'url') return validateMediaUrl(part.source.url, part);
  const url = await resolveAsset(part, options);
  options.signal?.throwIfAborted();
  if (url) return validateMediaUrl(url, part);
  if (part.type !== 'image') throw new MediaInputError(`Missing ${part.type} asset: ${part.assetId}. Provide source or resolveMediaDataUrl.`);
  return undefined;
}
function textBlock(text: string, protocol: MediaProtocol): Record<string, unknown> {
  return { type: protocol === 'responses' ? 'input_text' : 'text', text };
}
function imageBlock(url: string, protocol: MediaProtocol): Record<string, unknown> {
  if (protocol === 'responses') return { type: 'input_image', image_url: url, detail: 'auto' };
  if (protocol === 'chat_completions') return { type: 'image_url', image_url: { url } };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  const source = match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url };
  return { type: 'image', source };
}
const AUDIO_FORMATS: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/aac': 'aac', 'audio/amr': 'amr', 'audio/3gpp': '3gpp',
};
function audioBlock(part: MediaPart, url: string, profile: MediaProfile): Record<string, unknown> {
  const format = AUDIO_FORMATS[part.mimeType];
  if (!format) throw new MediaInputError(`Unsupported audio MIME type: ${part.mimeType}.`);
  if (profile === 'qwen-omni') return { type: 'input_audio', input_audio: { data: url, format } };
  if (format !== 'wav' && format !== 'mp3') throw new MediaInputError('OpenAI audio input requires WAV or MP3.');
  if (!url.startsWith('data:')) throw new MediaInputError('OpenAI audio input requires Base64 data, not a URL.');
  return { type: 'input_audio', input_audio: { data: url.slice(url.indexOf(',') + 1), format } };
}
export async function mediaContentBlock(part: MediaPart, options: MediaContentOptions): Promise<Record<string, unknown>> {
  const url = await resolveMediaUrl(part, options);
  if (!url) return missingImageBlock(part, options);
  if (part.type === 'image') return imageBlock(url, options.protocol);
  if (part.type === 'audio') return audioBlock(part, url, options.profile ?? 'openai');
  return { type: 'video_url', video_url: { url } };
}
export async function buildMediaUserContent(parts: MessagePart[], options: MediaContentOptions): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  let text = '';
  const flush = () => { if (text.trim()) content.push(textBlock(text.trim(), options.protocol)); text = ''; };
  for (const part of parts) {
    if (part.type === 'text') { text += (text ? '\n' : '') + part.text; continue; }
    if (!isMediaPart(part)) continue;
    flush();
    content.push(await mediaContentBlock(part, options));
  }
  flush();
  return content;
}
export function mediaRequestOptions(input: ModelTurnInput): Record<string, unknown> {
  const hasAudioVideo = input.messages.some(m => m.parts.some(p => p.type === 'audio' || p.type === 'video'));
  return hasAudioVideo ? { modalities: ['text'] } : {};
}

function missingImageBlock(part: MediaPart, options: MediaContentOptions): Record<string, unknown> {
  const prefix = options.resolveImage || options.resolveMedia ? 'missing image' : 'image';
  return textBlock(`[${prefix} ${part.assetId}]`, options.protocol);
}
