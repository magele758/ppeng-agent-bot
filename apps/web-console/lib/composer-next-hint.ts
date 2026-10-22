/** Next-line suggestion for the Bot main composer. Shown as a hint until Tab. */

export const COMPOSER_HINT_DELAY_MS = 450;
const HINT_MAX_CHARS = 500;

export type ComposerHintMessage = {
  role?: string;
  parts?: readonly { type?: string; text?: string }[] | null;
};

export function lastCompletedTurn(
  messages: readonly ComposerHintMessage[]
): { userText: string; assistantText: string } | null {
  let assistantText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'assistant' && !assistantText) {
      const text = messageText(message);
      if (text) assistantText = text;
      continue;
    }
    if (message.role === 'user' && assistantText) {
      const userText = messageText(message);
      if (!userText) return null;
      return { userText, assistantText };
    }
  }
  return null;
}

export function isBotMainComposerSession(session: {
  mode?: string;
  parentSessionId?: string | null;
  metadata?: Record<string, unknown> | null;
} | null | undefined): boolean {
  if (!session || session.mode !== 'chat' || session.parentSessionId) return false;
  const meta = session.metadata ?? {};
  if (meta.canonicalBotChat !== true) return false;
  if (typeof meta.botId !== 'string' || meta.botId.trim() === '') return false;
  if (typeof meta.roomId === 'string' && meta.roomId.trim() !== '') return false;
  return true;
}

export function shouldRequestComposerHint(input: {
  surface: 'chat' | 'bot';
  botMain: boolean;
  groupOpen?: boolean;
  draft: string;
  generating: boolean;
  hasAssistantReply: boolean;
}): boolean {
  if (input.surface !== 'bot' || !input.botMain || input.groupOpen) return false;
  if (input.draft.trim() || input.generating || !input.hasAssistantReply) return false;
  return true;
}

export function composerHintRequestBody(sessionId: string): { sessionId: string } {
  return { sessionId };
}

export function readComposerHintBody(status: number, body: unknown): string {
  if (status !== 200 || !body || typeof body !== 'object') return '';
  const hint = (body as { hint?: unknown }).hint;
  if (typeof hint !== 'string') return '';
  return cleanHintLine(hint);
}

export function composerHintPresentation(input: {
  draft: string;
  hint: string;
  idlePlaceholder: string;
  running: boolean;
  runningPlaceholder: string;
}): { value: string; placeholder: string; hintVisible: boolean } {
  const value = input.draft;
  const hint = value.trim() || input.running ? '' : input.hint.trim();
  if (!hint) {
    return {
      value,
      placeholder: input.running ? input.runningPlaceholder : input.idlePlaceholder,
      hintVisible: false,
    };
  }
  return { value, placeholder: hint, hintVisible: true };
}

export function composerHintKey(input: {
  key: string;
  draft: string;
  hint: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): { accept: boolean; draft: string } {
  const hint = input.hint.trim();
  const accept =
    input.key === 'Tab' &&
    !input.shiftKey &&
    !input.altKey &&
    !input.metaKey &&
    !input.ctrlKey &&
    !input.isComposing &&
    !input.draft.trim() &&
    hint.length > 0;
  if (!accept) return { accept: false, draft: input.draft };
  return { accept: true, draft: hint };
}

/** Keystrokes replace the draft. The suggestion is not appended. */
export function composerDraftFromTyping(typed: string, hint: string): { draft: string; hintVisible: boolean } {
  return { draft: typed, hintVisible: typed.trim() ? false : hint.trim().length > 0 };
}

/** Only text already in the field can be sent. A visible hint is not a message. */
export function composerMessageToSend(draft: string): string {
  return draft.trim();
}

export function armComposerHint(input: {
  delayMs: number;
  schedule: (fn: () => void, ms: number) => () => void;
  load: () => Promise<string>;
  publish: (hint: string) => void;
}): () => void {
  let cancelled = false;
  const cancelTimer = input.schedule(() => {
    void input.load().then(
      (hint) => {
        if (!cancelled) input.publish(hint);
      },
      () => {
        if (!cancelled) input.publish('');
      }
    );
  }, input.delayMs);
  return () => {
    cancelled = true;
    cancelTimer();
  };
}

export async function loadComposerHint(
  sessionId: string,
  signal?: AbortSignal,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<string> {
  try {
    const response = await fetchImpl('/api/lab/composer-hint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(composerHintRequestBody(sessionId)),
      signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    return readComposerHintBody(response.status, payload);
  } catch {
    return '';
  }
}

function messageText(message: ComposerHintMessage): string {
  const lines: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) lines.push(part.text.trim());
  }
  return lines.join('\n').trim();
}

function cleanHintLine(raw: string): string {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('{') || line.startsWith('[') || line.startsWith('```')) return '';
  const chars = Array.from(line);
  if (chars.length < 2) return '';
  return chars.slice(0, HINT_MAX_CHARS).join('');
}
