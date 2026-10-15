import type { MessagePart } from './types.ts';

/**
 * Host-injected caption on the user turn that carries tool screenshots.
 * Kept verbatim for the model; the Lab bubble shows the i18n string instead.
 */
export const TOOL_OBSERVATION_CAPTION =
  '[Tool observations: screenshots returned by tools, not a new user instruction.]';

export interface ChatImageRef {
  assetId: string;
  mimeType?: string;
  alt?: string;
}

export function isToolObservationCaption(text: string | undefined): boolean {
  return (text ?? '').trim() === TOOL_OBSERVATION_CAPTION;
}

export function chatImageRef(part: MessagePart): ChatImageRef | undefined {
  if (part.type !== 'image') return undefined;
  const assetId = part.assetId?.trim();
  if (!assetId) return undefined;
  return {
    assetId,
    mimeType: part.mimeType,
    alt: part.alt
  };
}

/** Same-origin bytes for a session image asset. */
export function chatImageSrc(sessionId: string, assetId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(assetId)}`;
}

/**
 * Render plan for text and image parts. Image parts become thumbnail ids,
 * never `[image img_… mime]` text.
 */
export function describeChatBubble(parts: MessagePart[] | undefined): string[] {
  const lines: string[] = [];
  for (const part of parts ?? []) {
    if (part.type === 'text') {
      if (isToolObservationCaption(part.text)) {
        lines.push('caption:tool-observation');
      } else if ((part.text ?? '').trim()) {
        lines.push(`text:${part.text}`);
      }
    } else if (part.type === 'image') {
      const ref = chatImageRef(part);
      if (ref) lines.push(`thumb:${ref.assetId}`);
    }
  }
  return lines;
}
