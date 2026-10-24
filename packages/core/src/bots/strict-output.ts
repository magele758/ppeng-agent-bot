import type { SqliteStateStore } from '../storage.js';
import type { SessionMessage } from '../types.js';

type OutputFormat = 'path' | 'number' | 'version' | 'json';

/** Recognize only explicit, unconditional output-only directives, not quoted examples. */
export function strictOutputFormat(request: string): OutputFormat | undefined {
  const text = request.replace(/```[\s\S]*?```/g, '').replace(/^\s*>.*$/gm, '');
  if (/如果|否则|\b(?:if|unless|otherwise)\b/i.test(text)) return undefined;
  const directive = text.match(/(?:^|[。；;.!?，,\n])\s*(?:请)?(?:只|仅)(?:输出|返回|回复)\s*(路径|数字|数值|版本号|JSON)(?=$|[\s。；;.!?，,])/i)
    ?? text.match(/(?:^|[.;!?\n])\s*(?:please\s+)?only\s+(?:output|return|reply with)\s+(?:the\s+)?(path|number|version|JSON)(?=$|[\s.;!?])/i);
  const value = directive?.[1]?.toLowerCase();
  if (value === '路径' || value === 'path') return 'path';
  if (value === '数字' || value === '数值' || value === 'number') return 'number';
  if (value === '版本号' || value === 'version') return 'version';
  if (value === 'json') return 'json';
  return undefined;
}

export function matchesStrictOutput(format: OutputFormat, response: string): boolean {
  const text = response.trim();
  if (!text) return false;
  if (format === 'json') { try { JSON.parse(text); return true; } catch { return false; } }
  if (format === 'number') return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text);
  if (format === 'version') return /^[^\s`]+$/.test(text);
  // Paths can contain spaces and need not be absolute. Reject narration blocks,
  // not legitimate filenames. Evidence validation remains independent.
  return !/[\r\n`]/.test(text);
}

const attempts = new WeakMap<object, Map<string, string>>();

export function clearQueryOutputReview(store: object, sessionId: string): void {
  attempts.get(store)?.delete(sessionId);
}

/** A send-only view: keep private reasoning out of strict answers and make
 * correction a fresh request even when an adapter hoists system notices. */
export function completionModelView(messages: SessionMessage[]): SessionMessage[] {
  const text = (message: SessionMessage) => message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const user = messages.findLast(message => message.role === 'user');
  const feedbackIndex = messages.findLastIndex(message => message.role === 'system' && /^\[(?:output format|completion review)\]/.test(text(message)));
  const feedback = feedbackIndex >= 0 && !messages.slice(feedbackIndex + 1).some(message => message.role !== 'system') ? messages[feedbackIndex] : undefined;
  if (!feedback && (!user || !strictOutputFormat(text(user)))) return messages;
  const view = messages.flatMap(message => {
    if (message.role !== 'assistant') return [message];
    const parts = message.parts.filter(part => part.type !== 'reasoning');
    return parts.length ? [{...message, parts}] : [];
  });
  if (feedback) view.push({
    id: `completion-continuation-${feedback.id}`, sessionId: feedback.sessionId,
    createdAt: feedback.createdAt, role: 'user',
    parts: [{type: 'text', text: '[runtime continuation of the same request] Answer the latest user request again using existing observations and the completion feedback in system instructions. Produce a fresh final answer, not a continuation of prior assistant text. Do not repeat completed actions.'}]
  });
  return view;
}

/** One repair per user request; no answer rewriting and no extra tool authority. */
export function reviewQueryOutput(store: Pick<SqliteStateStore, 'foldMessages' | 'getSession'>, sessionId: string, signal?: AbortSignal) {
  if (signal?.aborted || store.getSession(sessionId)?.status === 'waiting_approval') return undefined;
  const messages = store.foldMessages(sessionId);
  const userIndex = messages.findLastIndex(message => message.role === 'user');
  const user = messages[userIndex];
  const assistant = messages.slice(userIndex + 1).findLast(message => message.role === 'assistant');
  if (!user || !assistant) return undefined;
  const text = (message: typeof user) => message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const format = strictOutputFormat(text(user));
  if (!format || matchesStrictOutput(format, text(assistant))) return undefined;
  let seen = attempts.get(store);
  if (!seen) { seen = new Map(); attempts.set(store, seen); }
  if (seen.get(sessionId) === user.id) return undefined;
  if (seen.size >= 512 && !seen.has(sessionId)) return undefined;
  seen.set(sessionId, user.id);
  return {
    met: false, action: 'continue' as const,
    systemMessage: `[output format] Your last reply did not follow the current user's output-only format (${format}). Re-answer once using the already observed result, in exactly that format. Return only the requested value, without narration, Markdown or a verification report. Do not repeat completed tool actions or invent a value. If evidence does not establish the answer, follow the user's failure instructions instead.`
  };
}
