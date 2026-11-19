import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeSpawnEnv } from '../sandbox/env-sanitizer.js';
import type { ImagePart, RunContext, ToolContract, ToolExecutionResult } from '../types.js';

export type LcuContent = { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown };
export type LcuApproval = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown>; _meta?: { persist: 'session' } };
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
const desktopToolNames = new Set(['js', 'js_reset']);
const registeredDesktopNames = new Set(Array.from(desktopToolNames, name => 'lcu_' + name));
interface Installation { key: string; command: string; adapterUrl?: string }
interface Surface { instructions: string; tools: ReturnType<LcuClient['publicTools']> }
interface Turn {
  installation: Installation;
  surface?: Surface;
  client?: LcuClient;
  connecting?: Promise<LcuClient>;
  turnId: string;
  controller: AbortController;
  active: Set<Promise<unknown>>;
  tail: Promise<unknown>;
  ending: boolean;
  cleanup?: Promise<void>;
}

async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    cancel = () => reject(new Error('LCU operation aborted'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([work, interrupted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

function stamp(path: string): string {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':') : '';
}

function resolveInstallation(deps: LcuDeps): Installation {
  const configured = deps.command?.() || defaultLcuCommand();
  if (deps.clientFactory) return { key: configured, command: configured };
  if (!isAbsolute(configured)) throw new Error('LCU command must be an absolute executable path');
  const command = realpathSync(configured);
  const root = realpathSync(join(dirname(configured), '..'));
  const adapter = realpathSync(join(root, 'adapters', 'client.mjs'));
  const app = join(root, 'app');
  // Packaged LCU borrows the installed ChatGPT app's runtime through this symlink.
  const appPath = stamp(app) ? realpathSync(app) : '';
  const key = JSON.stringify([
    configured, command, stamp(command), adapter, stamp(adapter),
    stamp(join(root, 'installation.json')), stamp(join(root, 'bundle.json')),
    appPath, stamp(join(app, 'Contents', 'Info.plist')), stamp(join(app, 'Contents', '_CodeSignature', 'CodeResources')),
  ]);
  const url = pathToFileURL(adapter);
  url.searchParams.set('installation', key);
  return { key, command, adapterUrl: url.href };
}

/** Local desktop ownership is held across a complete host turn, not just one click. */
export class LcuComputerUseProvider {
  private readonly turns = new Map<string, Turn>();
  private discovery?: { key: string; result: Promise<Surface> };
  private surface?: Surface;
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
    const installation = resolveInstallation(this.deps);
    const turn: Turn = { installation, turnId, controller: new AbortController(), active: new Set(), tail: Promise.resolve(), ending: false };
    this.turns.set(sessionId, turn);
    try {
      const result = this.discoverSurface(sessionId, turn);
      turn.active.add(result);
      try { turn.surface = await result; }
      finally { turn.active.delete(result); }
    } catch (error) {
      await turn.client?.close().catch(() => {});
      this.turns.delete(sessionId);
      throw error;
    }
  }

  private discoverSurface(sessionId: string, turn: Turn): Promise<Surface> {
    const { key } = turn.installation;
    if (this.discovery?.key === key) return this.discovery.result;
    this.surface = undefined;
    const result = this.connectTurn(sessionId, turn).then(client => ({
      instructions: client.instructions, tools: client.publicTools(),
    }));
    this.discovery = { key, result };
    void result.then(surface => {
      if (this.discovery?.result === result) this.surface = surface;
    }, () => {
      if (this.discovery?.result === result) this.discovery = undefined;
    });
    return result;
  }

  private async connectTurn(sessionId: string, turn: Turn, signal?: AbortSignal): Promise<LcuClient> {
    const { command, adapterUrl } = turn.installation;
    const onElicitation = (params: Record<string, unknown>, extra: { signal: AbortSignal }) =>
      this.deps.requestApproval(sessionId, params, AbortSignal.any([turn.controller.signal, extra.signal]));
    let client: LcuClient;
    if (this.deps.clientFactory) client = await this.deps.clientFactory({ onElicitation });
    else {
      const module = await import(adapterUrl!);
      client = module.createCuaClient({ command: [command], env: sanitizeSpawnEnv({ stripCredentials: true }), adapter: 'ppeng', onElicitation });
    }
    try {
      if (signal?.aborted) throw new Error('LCU operation aborted');
      const handshake = client.connect();
      if (signal) await untilAbort(handshake, signal);
      else await handshake;
    }
    catch (error) { await client.close().catch(() => {}); throw error; }
    turn.client = client;
    return client;
  }

  private async clientForDesktopAction(sessionId: string, turn: Turn, signal: AbortSignal): Promise<LcuClient> {
    if (signal.aborted) throw new Error('LCU operation aborted');
    if (turn.client) return turn.client;
    if (!turn.connecting) {
      if (resolveInstallation(this.deps).key !== turn.installation.key) {
        throw new Error('LCU installation changed since this turn began');
      }
      const connection = this.connectTurn(sessionId, turn, turn.controller.signal);
      turn.connecting = connection;
      turn.active.add(connection);
      const settled = () => { turn.active.delete(connection); turn.connecting = undefined; };
      void connection.then(settled, settled);
    }
    // A call can be cancelled while another call from the same turn still needs the client.
    return untilAbort(turn.connecting, signal);
  }

  instructionsForSession(sessionId: string): string { return this.turns.get(sessionId)?.surface?.instructions ?? ''; }
  tools(sessionId?: string): ToolContract[] {
    const surface = sessionId === undefined ? this.surface : this.turns.get(sessionId)?.surface;
    if (!this.deps.enabled() || !surface) return [];
    return surface.tools.filter(tool => desktopToolNames.has(tool.name)).map(tool => ({
      name: `lcu_${tool.name}`, description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema ?? { type: 'object' }, approvalMode: 'auto' as const, sideEffectLevel: 'system' as const,
      execute: (ctx: RunContext, args: Record<string, unknown>) => this.execute(ctx.session.id, tool.name, args, ctx.abortSignal),
    }));
  }
  /** Keep the runtime catalog in sync if a replacement installation removes a tool. */
  registerTools(catalog: ToolContract[], sessionId?: string): void {
    const tools = this.tools(sessionId);
    const replacements = new Map(tools.map(tool => [tool.name, tool]));
    for (let i = catalog.length - 1; i >= 0; i--) {
      const name = catalog[i]!.name;
      if (!registeredDesktopNames.has(name)) continue;
      const replacement = replacements.get(name);
      if (replacement) catalog[i] = replacement;
      else catalog.splice(i, 1);
      replacements.delete(name);
    }
    catalog.push(...replacements.values());
  }
  /** Active turns retain the declarations from their own installation when settings change. */
  toolsForSession(catalog: ToolContract[], sessionId: string): ToolContract[] {
    const scoped = [...catalog];
    this.registerTools(scoped, sessionId);
    return scoped;
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
    if (!desktopToolNames.has(name)) throw new Error('LCU host-only tool is not model-callable');
    const turn = this.turns.get(sessionId);
    if (!turn || turn.ending) throw new Error('LCU requires an active host turn');
    if (!turn.surface?.tools.some(tool => tool.name === name)) throw new Error('LCU tool not available in this installation');
    const signal = externalSignal ? AbortSignal.any([turn.controller.signal, externalSignal]) : turn.controller.signal;
    const previous = turn.tail;
    const operation = (async () => {
      // A cancelled or failed connection must still settle behind the preceding desktop action.
      const client = await this.clientForDesktopAction(sessionId, turn, signal).finally(() => previous);
      await this.acquire(sessionId, signal);
      if (signal.aborted || turn.ending || !this.deps.enabled()) throw new Error('LCU operation aborted');
      const result = await client.call(name, args, { sessionId, turnId: turn.turnId, signal });
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
    if (event !== 'Stop' || turn.connecting) turn.controller.abort();
    turn.cleanup ??= this.cleanupTurn(sessionId, turn, event);
    return turn.cleanup;
  }

  private async cleanupTurn(sessionId: string, turn: Turn, event: string): Promise<void> {
    await Promise.allSettled([...turn.active]);
    try { await turn.client?.turnEnded({ sessionId, turnId: turn.turnId, event }); }
    catch (error) {
      throw this.blockAfterCleanupFailure(error);
    } finally {
      try { await turn.client?.close(); }
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
