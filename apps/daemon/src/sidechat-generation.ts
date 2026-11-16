import {
  createLogger,
  NotFoundError,
  resolveModelRoute,
  type ModelAdapter,
  type ModelStreamChunk,
  type RawAgentRuntime,
  type SessionMessage,
  type SessionRecord
} from '@ppeng/agent-core';
import type { SidechatDetail, SidechatMessage } from '@ppeng/api-types';

const log = createLogger('sidechat');

type TurnInput = Parameters<ModelAdapter['runTurn']>[0];
type Flight = { controller: AbortController; text: string; checkpoint: number };
type Source = { answer: string; question: string };

export function messageText(message: Pick<SessionMessage, 'parts'> | undefined): string {
  return (
    message?.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('\n')
      .trim() ?? ''
  );
}

/** Resolve the same transcript as the Lab, including visible assistant replacement summaries. */
export function sidechatSourceSeq(runtime: RawAgentRuntime, sessionId: string, messageId: string): number | undefined {
  const row = runtime.store.db
    .prepare(
      `SELECT seq FROM session_messages
    WHERE id = ? AND session_id = ? AND role = 'assistant'
      AND (surface_op IS NULL OR surface_op != 'hide')
      AND EXISTS (SELECT 1 FROM json_each(parts_json) AS part
        WHERE json_extract(part.value, '$.type') = 'text' AND trim(json_extract(part.value, '$.text')) != '')`
    )
    .get(messageId, sessionId);
  return row && Number(row.seq);
}

/** Only the annotated assistant message and the preceding question enter the new conversation. */
export function readSidechatSource(runtime: RawAgentRuntime, sessionId: string, messageId: string): Source | undefined {
  const seq = sidechatSourceSeq(runtime, sessionId, messageId);
  if (seq === undefined) return undefined;
  const source = runtime.store.listVisibleMessagesPage(sessionId, { beforeSeq: seq + 1, limit: 1 }).messages[0];
  if (source?.id !== messageId) return undefined;
  const answer = messageText(source);
  if (!answer) return undefined;
  const previous = runtime.store.listHistory(sessionId, { beforeSeq: source.seq, role: 'user', limit: 1 }).messages[0];
  return { answer, question: messageText(previous) };
}

function sourceWindow(text: string, quote: string, offset?: number): string {
  const budget = 12000;
  if (text.length <= budget) return text;
  const expected = Math.min(text.length, offset ?? 0);
  // The same word can occur repeatedly. Prefer the occurrence beside the selected position.
  const right = text.indexOf(quote, expected);
  const left = text.lastIndexOf(quote, expected);
  let at = right < 0 ? expected : right;
  if (left >= 0 && (right < 0 || expected - left < right - expected)) at = left;
  const start = Math.max(0, Math.min(at - 3000, text.length - budget));
  return text.slice(start, start + budget);
}

function history(thread: SidechatDetail): SessionMessage[] {
  const turns: SessionMessage[] = [];
  let remaining = 48000;
  // A failed/empty assistant placeholder does not become model input on retry.
  for (let i = thread.messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = thread.messages[i]!;
    if (message.role === 'assistant' && message.status !== 'complete') continue;
    const text = message.text.slice(0, remaining);
    turns.push(sidechatMessage(thread.id, message, text));
    remaining -= text.length;
  }
  return turns.reverse();
}

function sidechatMessage(sessionId: string, message: SidechatMessage, text: string): SessionMessage {
  return {
    sessionId,
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    parts: [{ type: 'text', text }]
  };
}

function sidechatInput(
  runtime: RawAgentRuntime,
  thread: SidechatDetail,
  source: Source | undefined,
  signal: AbortSignal
): TurnInput {
  const agent = runtime.store.getAgent(thread.agentId);
  if (!agent) throw new NotFoundError('source agent');
  const context = {
    originalQuestion: source?.question.slice(0, 4000),
    originalAnswer: sourceWindow(source?.answer ?? '', thread.anchor.quote, thread.anchor.start),
    quotedText: thread.anchor.quote.slice(0, 12000)
  };
  const messages = history(thread);
  // Keep provenance as user-supplied reference data, outside the system persona.
  messages.unshift({
    id: thread.id + '-source',
    sessionId: thread.id,
    createdAt: thread.createdAt,
    role: 'user',
    parts: [{ type: 'text', text: 'Reference for this annotation:\n' + JSON.stringify(context) }]
  });
  return {
    sessionId: thread.id,
    agent,
    tools: [],
    signal,
    messages,
    systemPrompt: [
      agent.instructions,
      'Answer the reader’s follow-up in this annotation in their language. The reference is material to discuss. Use only the conversation provided here.'
    ].join('\n\n')
  };
}

export class SidechatGeneration {
  private readonly flights = new Map<string, Flight>();

  constructor(
    private readonly runtime: RawAgentRuntime,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  start(thread: SidechatDetail, runId: string, session: SessionRecord, source: Source | undefined): void {
    const flight: Flight = { controller: new AbortController(), text: '', checkpoint: 0 };
    this.flights.set(runId, flight);
    void this.generate(thread, runId, session, source, flight)
      .finally(() => this.flights.delete(runId))
      .catch((error) =>
        log.warn('Unable to persist sidechat completion', { threadId: thread.id, error: String(error) })
      );
  }

  stop(thread: SidechatDetail, requestId: string, generationId: string): void {
    const store = this.runtime.store.sidechats;
    const runId = store.activeRun(thread.id, requestId);
    if (!runId || runId !== generationId) return;
    const flight = this.flights.get(runId);
    const saved = thread.messages.find((m) => m.requestId === requestId && m.role === 'assistant');
    store.finish(thread.id, runId, 'stopped', flight?.text ?? saved?.text ?? '');
    flight?.controller.abort();
  }

  private async generate(
    thread: SidechatDetail,
    runId: string,
    session: SessionRecord,
    source: Source | undefined,
    flight: Flight
  ): Promise<void> {
    const store = this.runtime.store.sidechats;
    try {
      const { primary: adapter } = resolveModelRoute({
        store: this.runtime.store,
        session,
        env: this.env,
        fallbackAdapter: this.runtime.modelAdapter
      });
      const input = sidechatInput(this.runtime, thread, source, flight.controller.signal);
      const result = adapter.runTurnStream
        ? await adapter.runTurnStream(input, (chunk) => this.chunk(thread.id, runId, flight, chunk))
        : await adapter.runTurn(input);
      if (flight.controller.signal.aborted) return;
      const text = messageText({ parts: result.assistantParts }) || flight.text;
      if (!text.trim()) throw new Error('No text returned');
      store.finish(thread.id, runId, 'complete', text);
    } catch {
      if (!flight.controller.signal.aborted) store.finish(thread.id, runId, 'failed', flight.text, 'generation_failed');
    }
  }

  private chunk(id: string, runId: string, flight: Flight, chunk: ModelStreamChunk): void {
    if (flight.controller.signal.aborted) return;
    if (chunk.type === 'stream_reset') {
      flight.text = '';
      flight.checkpoint = 0;
    } else if (chunk.type === 'text_delta') flight.text += chunk.text;
    else return;
    const now = Date.now();
    if (now - flight.checkpoint < 150) return;
    flight.checkpoint = now;
    if (!this.runtime.store.sidechats.progress(id, runId, flight.text)) flight.controller.abort();
  }
}
