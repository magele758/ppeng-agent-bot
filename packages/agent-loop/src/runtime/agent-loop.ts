/**
 * L4: Explicit step-level control for the agent loop.
 *
 * AgentLoopHandle wraps a host + parking latch and exposes
 * step() / run() / steer() / abort() / fold(). The latch implements the
 * kernel's `{ emit }` port so it can be attached to `runSessionKernel`.
 */

import type { SessionMessage, SessionRecord } from '../types.js';
import type { EnqueueSteerOptions, InboxItem } from '../session/step-inbox.js';
import { decideSteerAdmission, sessionSteersImmediately, type SteerAck } from '../session/steer-ack.js';
import { closeOpenToolWave, type ToolWaveCloseStore } from '../session/tool-wave-close.js';
import type { TurnKernelHost, AgentStepEvent } from '../turn/host.js';
import type { AgentLoopLatch as KernelLatch } from '../turn/kernel.js';
import { runSessionKernel } from '../turn/kernel.js';

export type { AgentStepEvent };

// ============================================================================
// AgentLoopHost — minimal interface for session management
// ============================================================================

export interface AgentLoopHost {
  getSession(sessionId: string): SessionRecord | undefined;
  foldMessages(sessionId: string): SessionMessage[];
  enqueueSteer(sessionId: string, text: string, opts?: EnqueueSteerOptions): SteerAck;
  abortSession(sessionId: string): void;
  startRun(
    sessionId: string,
    latch: AgentLoopLatch,
    options?: { signal?: AbortSignal }
  ): Promise<unknown>;
}

export type AgentLoopAttachHost = {
  store: ToolWaveCloseStore & {
    getSession(id: string): SessionRecord | undefined;
    enqueueSteer?(sessionId: string, text: string, opts?: EnqueueSteerOptions): InboxItem;
  };
  sessionAbortControllers?: Map<string, AbortController>;
};

type SteerCapableStore = AgentLoopAttachHost['store'];

// ============================================================================
// AgentLoopLatch — single-step vs continuous-run control (kernel-attachable)
// ============================================================================

function isLatchTerminal(ev: AgentStepEvent): boolean {
  switch (ev.type) {
    case 'ended':
    case 'waiting_approval':
    case 'abort':
      return true;
    case 'turn_prepared':
    case 'model_done':
    case 'tools_done':
    case 'compacted':
      return false;
    default: {
      const _never: never = ev;
      return _never;
    }
  }
}

export class AgentLoopLatch implements KernelLatch {
  mode: 'run' | 'step';
  private queue: AgentStepEvent[] = [];
  private eventWaiters: Array<(ev: AgentStepEvent) => void> = [];
  private resumeResolver: (() => void) | null = null;
  closed = false;
  private terminalEmitted = false;

  constructor(mode: 'run' | 'step') {
    this.mode = mode;
  }

  waitForEvent(): Promise<AgentStepEvent> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!);
    }
    return new Promise((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  resume(): void {
    const r = this.resumeResolver;
    this.resumeResolver = null;
    r?.();
  }

  close(): void {
    this.closed = true;
    this.resume();
    if (this.terminalEmitted) return;
    const end: AgentStepEvent = { type: 'ended', reason: 'closed' };
    this.terminalEmitted = true;
    while (this.eventWaiters.length > 0) {
      this.eventWaiters.shift()!(end);
    }
    if (this.queue.length === 0) this.queue.push(end);
  }

  async emit(ev: AgentStepEvent): Promise<void> {
    if (isLatchTerminal(ev)) {
      this.terminalEmitted = true;
    }
    if (this.eventWaiters.length > 0) {
      const w = this.eventWaiters.shift()!;
      w(ev);
    } else {
      this.queue.push(ev);
    }
    const pause = this.mode === 'step' && !isLatchTerminal(ev) && !this.closed;
    if (pause) {
      await new Promise<void>((resolve) => {
        this.resumeResolver = resolve;
      });
    }
  }
}

// ============================================================================
// AgentLoopHandle — public control surface
// ============================================================================

export class AgentLoopHandle implements AsyncIterable<AgentStepEvent> {
  private latch: AgentLoopLatch | null = null;
  private runPromise: Promise<unknown> | null = null;
  /** Cooperative, one-shot. Consumed by the next `step()` as `{type:'abort'}`. */
  private abortRequested = false;

  constructor(
    private readonly host: AgentLoopHost,
    readonly sessionId: string,
    private readonly loopOptions?: { signal?: AbortSignal }
  ) {}

  /**
   * Run one phase then return control. Non-terminal events park the latch
   * until the next `step()` / `run()` / iterator tick.
   */
  async step(): Promise<AgentStepEvent> {
    if (this.abortRequested) {
      return this.consumeAbort();
    }
    this.ensureStarted('step');
    const latch = this.latch!;
    const eventPromise = latch.waitForEvent();
    latch.resume();
    const ev = await eventPromise;
    if (this.abortRequested) {
      return this.consumeAbort();
    }
    return ev;
  }

  /** Run continuously until end / waiting_approval / abort. */
  async run(): Promise<unknown> {
    if (this.abortRequested) {
      await this.consumeAbort();
      return this.host.getSession(this.sessionId);
    }
    if (this.latch?.mode === 'step' && this.runPromise && !this.latch.closed) {
      this.latch.mode = 'run';
      this.latch.resume();
      return this.runPromise;
    }
    this.ensureStarted('run');
    return this.runPromise!;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentStepEvent> {
    while (true) {
      if (this.abortRequested) {
        yield await this.consumeAbort();
        return;
      }
      this.ensureStarted(this.latch?.mode ?? 'step');
      const latch = this.latch!;
      const eventPromise = latch.waitForEvent();
      latch.resume();
      const ev = await eventPromise;
      if (this.abortRequested) {
        yield await this.consumeAbort();
        return;
      }
      yield ev;
      if (isLatchTerminal(ev)) return;
    }
  }

  async steer(text: string, opts?: EnqueueSteerOptions): Promise<SteerAck> {
    this.abortRequested = false;
    const session = this.host.getSession(this.sessionId);
    const decision = decideSteerAdmission({
      session,
      text,
      interruptPolicy: opts?.interruptPolicy
    });
    if (!decision.admit) {
      return { status: 'not_submitted', reason: decision.reason };
    }
    return this.host.enqueueSteer(this.sessionId, text, opts);
  }

  async abort(): Promise<void> {
    this.abortRequested = true;
    this.host.abortSession(this.sessionId);
    this.latch?.close();
  }

  /** Read-only fold of the current surface. Does not claim inbox. */
  async fold(): Promise<SessionMessage[]> {
    return this.host.foldMessages(this.sessionId);
  }

  private async consumeAbort(): Promise<AgentStepEvent> {
    this.abortRequested = false;
    this.latch?.close();
    const pending = this.runPromise;
    this.latch = null;
    this.runPromise = null;
    if (pending) {
      try {
        await pending;
      } catch {
        /* surfaced as abort */
      }
    }
    return { type: 'abort' };
  }

  private ensureStarted(mode: 'run' | 'step'): void {
    if (this.latch && this.runPromise && !this.latch.closed) return;
    const latch = new AgentLoopLatch(mode);
    this.latch = latch;
    this.runPromise = this.host
      .startRun(this.sessionId, latch, { signal: this.loopOptions?.signal })
      .finally(() => {
        latch.close();
      });
    void this.runPromise.catch(() => {
      /* surfaced via step()/run() */
    });
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createAgentLoop(
  host: AgentLoopHost,
  sessionId: string,
  options?: { signal?: AbortSignal }
): AgentLoopHandle {
  return new AgentLoopHandle(host, sessionId, options);
}

function ensureAbortControllers(host: AgentLoopAttachHost): Map<string, AbortController> {
  if (!host.sessionAbortControllers) {
    host.sessionAbortControllers = new Map();
  }
  return host.sessionAbortControllers;
}

/**
 * Chain an outer AbortSignal onto this round's controller.
 * Abort closes any open tool wave first, then aborts the controller.
 */
function attachOuterAbortSignal(
  signal: AbortSignal | undefined,
  host: AgentLoopAttachHost,
  sessionId: string
): (() => void) | undefined {
  if (!signal) return undefined;

  const abortRound = () => {
    try {
      closeOpenToolWave(host.store, sessionId, 'interrupted');
    } catch {
      /* fold/append must not block abort */
    }
    ensureAbortControllers(host).get(sessionId)?.abort();
  };

  if (signal.aborted) {
    abortRound();
    return undefined;
  }

  signal.addEventListener('abort', abortRound, { once: true });
  return () => signal.removeEventListener('abort', abortRound);
}

function abortAttachedSession(host: AgentLoopAttachHost, sessionId: string): void {
  try {
    closeOpenToolWave(host.store, sessionId, 'interrupted');
  } catch {
    /* fold/append must not block abort */
  }
  const controller = host.sessionAbortControllers?.get(sessionId);
  controller?.abort();
  host.sessionAbortControllers?.delete(sessionId);
}

/**
 * Build an AgentLoopHost from a kernel host so the L4 latch can be attached
 * to `runSessionKernel` without a product runtime / sidecar / IM stack.
 */
export function createAgentLoopFromKernelHost(
  host: AgentLoopAttachHost,
  runKernel?: (
    sessionId: string,
    latch: AgentLoopLatch,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>
): AgentLoopHost {
  ensureAbortControllers(host);
  const start =
    runKernel ??
    ((sessionId, latch) => runSessionKernel(host as TurnKernelHost, sessionId, { latch }));

  return {
    getSession(sessionId) {
      return host.store.getSession(sessionId);
    },
    foldMessages(sessionId) {
      return host.store.foldMessages(sessionId);
    },
    enqueueSteer(sessionId, text, opts) {
      const session = host.store.getSession(sessionId);
      const decision = decideSteerAdmission({
        session,
        text,
        interruptPolicy: opts?.interruptPolicy
      });
      if (!decision.admit) {
        return { status: 'not_submitted', reason: decision.reason };
      }
      const immediate =
        session?.status === 'running' &&
        sessionSteersImmediately(session) &&
        opts?.steerMode !== 'subagent';
      const store = host.store as SteerCapableStore;
      const item = store.enqueueSteer?.(
        sessionId,
        text,
        immediate ? { ...opts, target: 'next-step' } : opts
      );
      if (!item) {
        return { status: 'not_submitted', reason: 'no_session' };
      }
      return { status: decision.status, item };
    },
    abortSession(sessionId) {
      abortAttachedSession(host, sessionId);
    },
    startRun(sessionId, latch, options) {
      const run = start(sessionId, latch, options);
      const detach = attachOuterAbortSignal(options?.signal, host, sessionId);
      return Promise.resolve(run).finally(() => {
        detach?.();
      });
    }
  };
}
