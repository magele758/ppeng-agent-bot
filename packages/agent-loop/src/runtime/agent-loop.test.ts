import { describe, expect, it } from 'vitest';
import { createMemorySurfaceStore } from '../session/surface-store.js';
import { TOOL_WAVE_INTERRUPTED_CONTENT } from '../session/tool-wave-close.js';
import { unmatchedToolCallIds } from '../session/surface-invariants.js';
import type { SessionRecord } from '../types.js';
import {
  AgentLoopHandle,
  createAgentLoop,
  createAgentLoopFromKernelHost,
  type AgentLoopHost
} from './agent-loop.js';
import { createAgentLoop as exportedCreate, AgentLoopHandle as ExportedHandle } from '../index.js';

function sessionStub(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's-1',
    title: 't',
    mode: 'chat',
    status: 'idle',
    agentId: 'agent-1',
    background: false,
    todo: [],
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function mockHost(
  session: SessionRecord,
  startRun: AgentLoopHost['startRun'],
  extras?: Partial<AgentLoopHost>
): AgentLoopHost {
  const enqueued: string[] = [];
  const host: AgentLoopHost = {
    getSession: () => session,
    foldMessages: () => [],
    enqueueSteer: (_id, text) => {
      enqueued.push(text);
      return {
        status: 'started',
        item: {
          id: 'steer-1',
          sessionId: session.id,
          target: 'next-step',
          role: 'user',
          text,
          createdAt: session.createdAt
        }
      };
    },
    abortSession: () => undefined,
    startRun,
    ...extras
  };
  return Object.assign(host, { enqueued });
}

describe('L4 createAgentLoop exports', () => {
  it('publishes createAgentLoop and AgentLoopHandle from the package index', () => {
    expect(typeof exportedCreate).toBe('function');
    expect(ExportedHandle).toBe(AgentLoopHandle);
    expect(typeof createAgentLoop).toBe('function');
  });
});

describe('L4 step() latch parking', () => {
  it('parks after a non-terminal emit until the next step()', async () => {
    const session = sessionStub();
    let afterModelDone = false;
    const host = mockHost(session, async (_id, latch) => {
      await latch.emit({ type: 'turn_prepared', messageCount: 1 });
      await latch.emit({ type: 'model_done', stopReason: 'end' });
      afterModelDone = true;
      await latch.emit({ type: 'ended', reason: 'end' });
    });

    const loop = createAgentLoop(host, session.id);
    const first = await loop.step();
    expect(first.type).toBe('turn_prepared');
    await Promise.resolve();
    await Promise.resolve();
    expect(afterModelDone).toBe(false);

    const second = await loop.step();
    expect(second.type).toBe('model_done');
    expect(afterModelDone).toBe(true);

    const third = await loop.step();
    expect(third.type).toBe('ended');
  });
});

describe('L4 steer() uses decideSteerAdmission', () => {
  it('rejects empty / ended sessions and admits idle text', async () => {
    const session = sessionStub({ status: 'idle' });
    const enqueued: string[] = [];
    const host = mockHost(session, async () => undefined, {
      enqueueSteer: (_id, text) => {
        enqueued.push(text);
        return {
          status: 'started',
          item: {
            id: 'steer-1',
            sessionId: session.id,
            target: 'next-step',
            role: 'user',
            text,
            createdAt: session.createdAt
          }
        };
      }
    });
    const loop = createAgentLoop(host, session.id);

    const empty = await loop.steer('   ');
    expect(empty).toEqual({ status: 'not_submitted', reason: 'empty' });
    expect(enqueued).toEqual([]);

    session.status = 'completed';
    const ended = await loop.steer('keep going');
    expect(ended).toEqual({ status: 'not_submitted', reason: 'session_ended' });
    expect(enqueued).toEqual([]);

    session.status = 'idle';
    const ok = await loop.steer('keep going');
    expect(ok.status).toBe('started');
    expect(enqueued).toEqual(['keep going']);
  });
});

describe('kernel host enqueueSteer', () => {
  it('puts a running canonical bot on the next shot and leaves ordinary sessions queued [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-2] [AC:bot-immediate-steer#AC-3]', () => {
    const surface = createMemorySurfaceStore();
    const session = surface.createSession({ title: 'bot', mode: 'chat', agentId: 'bot' });
    surface.updateSession(session.id, { status: 'running', metadata: { canonicalBotChat: true } });
    const host = createAgentLoopFromKernelHost({ store: surface }, async () => undefined);

    const steered = host.enqueueSteer(session.id, 'mid', { target: 'next-run' });
    expect(steered.status).toBe('steered');
    if (steered.status !== 'steered') return;
    expect(steered.item.target).toBe('next-step');

    const child = host.enqueueSteer(session.id, 'child', { target: 'next-run', steerMode: 'subagent' });
    expect(child.status).toBe('steered');
    if (child.status !== 'steered') return;
    expect(child.item.target).toBe('next-run');

    surface.updateSession(session.id, { status: 'running', metadata: {} });
    const queued = host.enqueueSteer(session.id, 'later', { target: 'next-run' });
    expect(queued.status).toBe('started');
    if (queued.status !== 'started') return;
    expect(queued.item.target).toBe('next-run');

    expect(host.enqueueSteer(session.id, 'no', { interruptPolicy: 'disabled' })).toEqual({
      status: 'not_submitted',
      reason: 'steer_disabled'
    });
    expect(host.enqueueSteer(session.id, '   ')).toEqual({ status: 'not_submitted', reason: 'empty' });
  });
});

describe('L4 abort closes the open tool wave first', () => {
  it('abort() closes unmatched tool_calls then aborts the round controller', async () => {
    const surface = createMemorySurfaceStore();
    const session = surface.createSession({ title: 'wave', mode: 'chat', agentId: 'agent-1' });
    surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'do' }]);
    surface.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'c1', name: 'echo', input: {} }
    ]);
    expect(unmatchedToolCallIds(surface.foldMessages(session.id))).toEqual(['c1']);

    const order: string[] = [];
    const controllers = new Map<string, AbortController>();
    const round = new AbortController();
    controllers.set(session.id, round);
    round.signal.addEventListener('abort', () => order.push('abort'), { once: true });
    const origAppend = surface.appendMessage.bind(surface);
    surface.appendMessage = ((...args: Parameters<typeof surface.appendMessage>) => {
      order.push('close');
      return origAppend(...args);
    }) as typeof surface.appendMessage;

    const attach = { store: surface, sessionAbortControllers: controllers };
    const host = createAgentLoopFromKernelHost(attach, async () => undefined);
    const loop = createAgentLoop(host, session.id);
    await loop.abort();

    expect(unmatchedToolCallIds(surface.foldMessages(session.id))).toEqual([]);
    const results = surface
      .foldMessages(session.id)
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe(TOOL_WAVE_INTERRUPTED_CONTENT);
    expect(round.signal.aborted).toBe(true);
    expect(order).toEqual(['close', 'abort']);
  });

  it('chains an outer AbortSignal onto this round controller and closes the wave', async () => {
    const surface = createMemorySurfaceStore();
    const session = surface.createSession({ title: 'sig', mode: 'chat', agentId: 'agent-1' });
    surface.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'c2', name: 'echo', input: {} }
    ]);

    const attach = { store: surface, sessionAbortControllers: new Map<string, AbortController>() };
    const outer = new AbortController();
    const host = createAgentLoopFromKernelHost(attach, async (_id, latch) => {
      const round = new AbortController();
      attach.sessionAbortControllers.set(session.id, round);
      await latch.emit({ type: 'turn_prepared' });
      await latch.emit({ type: 'model_done', stopReason: 'end' });
      await latch.emit({ type: 'ended', reason: 'end' });
    });

    const loop = createAgentLoop(host, session.id, { signal: outer.signal });
    expect((await loop.step()).type).toBe('turn_prepared');
    const round = attach.sessionAbortControllers.get(session.id);
    expect(round?.signal.aborted).toBe(false);

    outer.abort();
    expect(round?.signal.aborted).toBe(true);
    expect(unmatchedToolCallIds(surface.foldMessages(session.id))).toEqual([]);
  });
});
