import { TOOL_RESULT_STUB_MARK } from './tool-result-stub';
import type { ChatMessage, MessagePart } from './types';

export function msgPartsToText(parts: MessagePart[] | undefined): string {
  if (!parts) return '';
  return parts
    .map((p) => {
      if (p.type === 'text') return p.text ?? '';
      if (p.type === 'reasoning') return p.text ?? '';
      if (p.type === 'image') return `[image ${p.assetId}${p.mimeType ? ` ${p.mimeType}` : ''}]`;
      if (p.type === 'tool_call') return `[${p.name}] ${JSON.stringify(p.input ?? {})}`;
      if (p.type === 'tool_result') return `[result ${p.name}] ${p.content ?? ''}`;
      if (p.type === 'surface_update') return `[a2ui surface ${p.surfaceId}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function messageHasToolParts(parts: MessagePart[] | undefined): boolean {
  return Array.isArray(parts) && parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result');
}

/** Assistant bubbles that need structured blocks (thinking fold, tools, surfaces, etc.). */
export function messageHasStructuredParts(parts: MessagePart[] | undefined): boolean {
  return (
    Array.isArray(parts) &&
    parts.some(
      (p) =>
        p.type === 'tool_call' ||
        p.type === 'tool_result' ||
        p.type === 'reasoning' ||
        p.type === 'surface_update'
    )
  );
}

export function userPreviewText(text: string, imageAssetIds: string[]): string {
  const ids = imageAssetIds ?? [];
  const parts: string[] = [];
  const t = (text ?? '').trim();
  if (t && t !== '(image)') parts.push(t);
  else if (ids.length) parts.push(`（${ids.length} 张图片）`);
  else if (t === '(image)') parts.push('（图片）');
  for (const id of ids) {
    const short = id.length > 14 ? `${id.slice(0, 14)}…` : id;
    parts.push(`[image ${short}]`);
  }
  return parts.filter(Boolean).join('\n') || '…';
}

export function isToolResultStub(content: string): boolean {
  return content.includes(TOOL_RESULT_STUB_MARK);
}

export function isToolResultTrimmed(content: string): boolean {
  return content.includes('output trimmed from') || content.includes('chars truncated');
}

export function normalizedRole(m: ChatMessage): 'user' | 'assistant' | 'tool' | 'system' {
  const r = m.role;
  if (r === 'user' || r === 'assistant' || r === 'tool' || r === 'system') return r;
  return 'assistant';
}
