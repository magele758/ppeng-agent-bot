/** Rough token estimate (~4 chars per token) for context budgeting. */
export function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Rough fixed cost per image part for context budgeting (VL tiles are expensive). */
const IMAGE_PART_TOKEN_ESTIMATE = 1200;

export function estimateMessageTokens(messages: Array<{ role: string; parts: Array<{ type: string; text?: string; content?: string }> }>): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        total += estimateTokensFromText(part.text);
      }
      if (part.type === 'reasoning' && typeof (part as { text?: string }).text === 'string') {
        total += estimateTokensFromText((part as { text: string }).text);
      }
      if (part.type === 'image') {
        total += IMAGE_PART_TOKEN_ESTIMATE;
      }
      if (part.type === 'audio') total += 3000;
      if (part.type === 'video') total += 10000;
      if (part.type === 'tool_call') {
        const input = (part as { input?: unknown }).input;
        const s = input !== undefined ? JSON.stringify(input) : '';
        total += estimateTokensFromText(s);
      }
      if (part.type === 'tool_result' && typeof (part as { content?: string }).content === 'string') {
        total += estimateTokensFromText((part as { content: string }).content);
      }
    }
  }
  return total;
}
