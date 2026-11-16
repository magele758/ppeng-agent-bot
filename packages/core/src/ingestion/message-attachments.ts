import type { MessagePart, SessionMessage } from '../types.js';
import { estimateMessageTokens, estimateTokensFromText } from '../model/token-estimate.js';
import type { AttachmentRecord } from './attachment-ingest-service.js';

type Lookup = { getAttachment?(id: string): AttachmentRecord | undefined };

function describe(row: AttachmentRecord): MessagePart {
  const source = JSON.stringify({
    file: row.fileName,
    version: row.id,
    image: row.imageAssetId,
    archive: row.artifactHandle
  });
  return {
    type: 'text',
    text: `[User attachment ${source}] Use read_chat_attachment to read this version or list earlier sent originals.`
  };
}

/** Keep the stored user turn intact. Only this request receives materialized content. */
export function withAttachmentContent(
  messages: SessionMessage[],
  sessionId: string,
  lookup: Lookup,
  historyTokens: number
): SessionMessage[] {
  const latest = messages.findLast((message) => message.role === 'user');
  let remaining: number | undefined;
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const rows = message.parts
      .flatMap((part) => (part.type === 'text' ? (part.attachmentRefs ?? []) : []))
      .map((ref) => lookup.getAttachment?.(ref.id))
      .filter((row): row is AttachmentRecord => row?.sessionId === sessionId);
    if (!rows.length) return message;
    if (message !== latest) return { ...message, parts: [...message.parts, ...rows.map(describe)] };

    remaining ??= Math.max(0, historyTokens - estimateMessageTokens(messages));
    const linkedImages = new Set(rows.map((row) => row.imageAssetId));
    const parts = message.parts.filter((part) => part.type !== 'image' || !linkedImages.has(part.assetId));
    for (const row of rows) {
      parts.push(describe(row));
      if (row.imageAssetId) {
        parts.push({ type: 'image', assetId: row.imageAssetId, mimeType: row.mimeType ?? 'image/png' });
      }
      if (!row.emitText) continue;
      const cost = estimateTokensFromText(row.emitText);
      if (cost <= remaining) {
        parts.push({ type: 'text', text: row.emitText });
        remaining -= cost;
      }
    }
    return { ...message, parts };
  });
}
