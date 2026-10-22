import type { RawAgentRuntime, SessionMessage } from '@ppeng/agent-core';

const HINT_MAX_CHARS = 500;
const MODEL_WAIT_MS = 4000;
const SYSTEM =
  '你在替用户起草下一步要发出去的行动指南。只能依据下面已经说过的内容，用刚出现的具体事物说明下一步做什么。不超过500字。禁止「继续」「好的」「那…呢」，禁止把助手上一句改写成问句。不要 JSON，不要 Markdown。如果没有可执行的下一步，只回复空行。';
const GENERIC_HINT = /^(继续|继续吧|好的|好|嗯+|然后呢|接下来呢|还有呢|还有吗|那呢|下一步|下一步呢|然后|接着)[。！？!?]?$/;
const REWRITE_HINT = /^那.+呢[？?]?$/;

type HintTurn = { userText: string; assistantText: string };

export async function composerHintHttpResult(
  runtime: RawAgentRuntime,
  body: unknown
): Promise<{ status: 200; body: { hint: string } }> {
  try {
    return { status: 200, body: { hint: await suggestComposerHint(runtime, body) } };
  } catch {
    return { status: 200, body: { hint: '' } };
  }
}

export async function suggestComposerHint(runtime: RawAgentRuntime, body: unknown): Promise<string> {
  try {
    const sessionId = readSessionId(body);
    if (!sessionId) return '';
    const session = runtime.getSession(sessionId);
    if (!session || !isCanonicalBotMainChat(session) || assistantStillReplying(session.status)) return '';
    const turn = completedTurnText(runtime.store.listMessages(sessionId));
    if (!turn) return '';
    const asked = await askModel(runtime.modelAdapter, turn);
    if (!asked.ok) return '';
    const line = modelNextAction(asked.text);
    if (!usableModelAction(line, turn)) return '';
    return line;
  } catch {
    return '';
  }
}

export function isCanonicalBotMainChat(session: {
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

function assistantStillReplying(status: string | undefined): boolean {
  return status === 'running' || status === 'waiting_approval';
}

function readSessionId(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function completedTurnText(messages: readonly SessionMessage[]): HintTurn | null {
  let assistantText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const text = messageText(message);
    if (message.role === 'assistant' && !assistantText) {
      if (text) assistantText = text;
      continue;
    }
    if (message.role === 'user' && assistantText) {
      if (!text) return null;
      return { userText: text, assistantText };
    }
  }
  return null;
}

function messageText(message: SessionMessage): string {
  const lines: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim()) lines.push(part.text.trim());
  }
  return lines.join('\n').trim();
}

function textFromModelJson(raw: string): string | null {
  if (!raw.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ['hint', 'text', 'action', 'next']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    return null;
  }
  return null;
}

/** Model prose, clipped at 500 characters. JSON without an action field is dropped. */
function modelNextAction(raw: string): string {
  let line = (textFromModelJson(raw.trim()) ?? raw).trim();
  if (
    (line.startsWith('"') && line.endsWith('"') && line.length >= 2) ||
    (line.startsWith('「') && line.endsWith('」') && Array.from(line).length >= 2)
  ) {
    line = line.slice(1, -1).trim();
  }
  line = line.replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('{') || line.startsWith('[') || line.startsWith('```')) return '';
  const chars = Array.from(line);
  if (chars.length < 2) return '';
  return chars.slice(0, HINT_MAX_CHARS).join('');
}

function usableModelAction(hint: string, turn: HintTurn): boolean {
  const compact = hint.replace(/\s+/g, '');
  if (!compact || GENERIC_HINT.test(compact) || REWRITE_HINT.test(compact)) return false;
  if (isAssistantRestatement(compact, turn.assistantText)) return false;
  return true;
}

function firstSentence(text: string): string {
  return (text.replace(/\s+/g, ' ').trim().split(/[。！？!?]/)[0] ?? '').trim();
}

function isAssistantRestatement(hint: string, assistantText: string): boolean {
  const sentence = firstSentence(assistantText).replace(/\s+/g, '');
  if (Array.from(sentence).length < 2) return false;
  const core = hint.replace(/[？?呢吗啊呀！!。，,]/g, '').replace(/^(那|那么|所以|请问)/, '');
  return core === sentence || hint === sentence;
}

async function askModel(
  adapter: RawAgentRuntime['modelAdapter'],
  turn: HintTurn
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (typeof adapter.completeText !== 'function') return { ok: true, text: '' };
  const user = `user: ${clip(turn.userText, 2000)}\nassistant: ${clip(turn.assistantText, 2000)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_WAIT_MS);
  // Swallow a late model rejection. The race may already have settled on timeout,
  // and an unhandled rejection here would take down the daemon.
  const pending = adapter
    .completeText({ system: SYSTEM, user, signal: controller.signal, jsonMode: false })
    .then(
      (text) => (typeof text === 'string' ? text : ''),
      () => ''
    );
  try {
    const text = await Promise.race([
      pending,
      new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('composer-hint-timeout')), { once: true });
      }),
    ]);
    return { ok: true, text };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function clip(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}
