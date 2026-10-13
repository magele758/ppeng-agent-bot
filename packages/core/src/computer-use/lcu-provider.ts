import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import type { ImagePart, RunContext, ToolContract, ToolExecutionResult } from '../types.js';

export type LcuContent = { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown };
export type LcuApproval = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
export interface LcuClient {
  instructions: string;
  connect(): Promise<unknown>;
  publicTools(): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>, context: { sessionId: string; turnId: string; signal?: AbortSignal }): Promise<{ content?: LcuContent[]; isError?: boolean }>;
  turnEnded(context: { sessionId: string; turnId: string; event: string }): Promise<unknown>;
  close(): Promise<void>;
}
export const defaultLcuCommand = () => join(homedir(), '.local/share/lcu/current/bin/lcu');
export interface LcuDeps {
  enabled: () => boolean;
  command?: () => string;
  clientFactory?: (options: { onElicitation: (params: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<LcuApproval> }) => Promise<LcuClient>;
  requestApproval: (sessionId: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<LcuApproval>;
  saveImage: (sessionId: string, image: LcuContent) => Promise<ImagePart>;
}
interface Turn { client: LcuClient; turnId: string; controller: AbortController; active: Set<Promise<unknown>>; tail: Promise<unknown>; ending: boolean }
/** Local desktop ownership is held across a complete host turn, not just one click. */
export class LcuComputerUseProvider {
  private readonly turns = new Map<string, Turn>();
  private surface: ReturnType<LcuClient['publicTools']> = [];
  private owner?: string;
  private waiters: Array<{ sessionId: string; resolve: () => void; reject: (error: Error) => void; signal: AbortSignal }> = [];
  private cleanupFailure?: Error;
  private blockAfterCleanupFailure(error: unknown): Error {
    this.cleanupFailure = new Error(`LCU cleanup failed; desktop actions blocked until runtime restart: ${error instanceof Error ? error.message : error}`);
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.cleanupFailure);
    return this.cleanupFailure;
  }
  constructor(private readonly deps: LcuDeps) {}
  async beginTurn(sessionId: string, turnId: string): Promise<void> {
    if (!this.deps.enabled()) return;
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.turns.has(sessionId)) throw new Error('LCU session already has an active turn');
    const controller = new AbortController();
    const onElicitation = (params: Record<string, unknown>, extra: { signal: AbortSignal }) => this.deps.requestApproval(sessionId, params, AbortSignal.any([controller.signal, extra.signal]));
    let client: LcuClient;
    if (this.deps.clientFactory) client = await this.deps.clientFactory({ onElicitation });
    else {
      const command = this.deps.command?.() || defaultLcuCommand();
      if (!isAbsolute(command)) throw new Error('LCU command must be an absolute executable path');
      const module = await import(pathToFileURL(join(dirname(command), '../adapters/client.mjs')).href);
      client = module.createCuaClient({ command: [command], env: sanitizeSpawnEnv({ stripCredentials: true }), adapter: 'ppeng', onElicitation });
    }
    try { await client.connect(); this.surface = client.publicTools(); }
    catch (error) { await client.close().catch(() => {}); throw error; }
    this.turns.set(sessionId, { client, turnId, controller, active: new Set(), tail: Promise.resolve(), ending: false });
  }
  instructionsForSession(sessionId: string): string { return this.turns.get(sessionId)?.client.instructions ?? ''; }
  tools(): ToolContract[] {
    if (!this.deps.enabled()) return [];
    return this.surface.filter(tool => ['js','js_reset'].includes(tool.name)).map(tool => ({
      name: `lcu_${tool.name}`, description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: 'object' }, approvalMode: 'auto' as const, sideEffectLevel: 'system' as const,
      execute: (ctx: RunContext, args: Record<string, unknown>) => this.execute(ctx.session.id, tool.name, args, ctx.abortSignal),
    }));
  }
  private acquire(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('LCU operation aborted'));
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (!this.owner || this.owner === sessionId) { this.owner = sessionId; return Promise.resolve(); }
    return new Promise((resolve,reject) => {
      const entry = { sessionId, signal, resolve: () => { signal.removeEventListener('abort', abort); resolve(); }, reject: (error: Error) => { signal.removeEventListener('abort', abort); reject(error); } };
      const abort = () => { this.waiters = this.waiters.filter(item => item !== entry); entry.reject(new Error('LCU queued operation aborted')); };
      signal.addEventListener('abort', abort, { once: true }); this.waiters.push(entry);
    });
  }
  async execute(sessionId: string, name: string, args: Record<string, unknown>, externalSignal?: AbortSignal): Promise<ToolExecutionResult> {
    if (!this.deps.enabled()) throw new Error('LCU computer use is disabled');
    if (!['js','js_reset'].includes(name)) throw new Error('LCU host-only tool is not model-callable');
    const turn = this.turns.get(sessionId);
    if (!turn || turn.ending) throw new Error('LCU requires an active host turn');
    const signal = externalSignal ? AbortSignal.any([turn.controller.signal, externalSignal]) : turn.controller.signal;
    const previous = turn.tail;
    const operation = (async () => {
      await previous;
      await this.acquire(sessionId, signal);
      if (signal.aborted || turn.ending || !this.deps.enabled()) throw new Error('LCU operation aborted');
      const result = await turn.client.call(name, args, { sessionId, turnId: turn.turnId, signal });
      const images: ImagePart[] = [];
      for (const block of result.content ?? []) if (block.type === 'image') images.push(await this.deps.saveImage(sessionId, block));
      return { ok: !result.isError, content: (result.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'), images,
        metadata: { mcpContent: result.content ?? [], mcpIsError: Boolean(result.isError), source: 'lcu', sessionId, turnId: turn.turnId } };
    })();
    turn.tail = operation.catch(() => undefined);
    turn.active.add(operation);
    try { return await operation; } finally { turn.active.delete(operation); }
  }
  async endTurn(sessionId: string, event = 'Stop'): Promise<void> {
    const turn = this.turns.get(sessionId); if (!turn) return;
    turn.ending = true;
    if (event !== 'Stop') turn.controller.abort();
    await Promise.allSettled([...turn.active]);
    try { await turn.client.turnEnded({ sessionId, turnId: turn.turnId, event }); }
    catch (error) {
      throw this.blockAfterCleanupFailure(error);
    } finally {
      try { await turn.client.close(); }
      catch (error) { throw this.blockAfterCleanupFailure(error); }
      finally { this.turns.delete(sessionId); }
    }
    if (this.owner === sessionId) {
      this.owner = undefined;
      const next = this.waiters.shift();
      if (next) { this.owner = next.sessionId; next.resolve(); }
    }
  }
  async close(): Promise<void> { await Promise.all([...this.turns.keys()].map(id => this.endTurn(id,'Interrupt'))); }
}
