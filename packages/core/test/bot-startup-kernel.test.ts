import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent?.includes('/packages/core/src/') && (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      const candidate = join(dirname(fileURLToPath(parent)), specifier).replace(/\.js$/, '.ts');
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes('/packages/core/src/') && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      const source = ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return next(url, context);
  }
});

const SECRET = 'SECRET_MESSAGE_BODY_9f3a';

const SHARED = [
  'writer_claim',
  'ensure_mcp',
  'resolve_file_policy',
  'ingest_mailbox',
  'auto_claim_task',
  'claim_next_run',
  'ensure_workspace',
  'resolve_workspace',
  'pack_turn',
  'build_system_prompt',
  'before_turn_hook',
  'pick_turn_tools',
  'before_model',
  'ready'
] as const;

async function loadKernel() {
  const [{ createMemorySurfaceStore }, { ExtensionRegistry }, { runSessionKernel }] = await Promise.all([
    import('../src/session/surface-store.ts'),
    import('../src/extensions/extension-registry.ts'),
    import('../src/turn/kernel.ts')
  ]);
  return { createMemorySurfaceStore, ExtensionRegistry, runSessionKernel };
}


function startupEvents(events: Array<{ kind: string; payload?: Record<string, unknown> }>) {
  return events.filter((event) => event.kind === 'startup_phase');
}

async function createHost(opts?: { throwTrace?: boolean; abort?: boolean; slowPrompt?: boolean }) {
  const { createMemorySurfaceStore, ExtensionRegistry } = await loadKernel();
  const surface = createMemorySurfaceStore();
  const agent = {
    id: 'agent-1',
    name: 'Test',
    role: 'assistant',
    instructions: 'test',
    capabilities: [] as string[]
  };
  const session = surface.createSession({ title: 'startup', mode: 'chat', agentId: agent.id });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: SECRET }]);
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  let modelCalls = 0;
  const controller = new AbortController();
  if (opts?.abort) controller.abort();
  const host = {
    store: {
      getSession: (id: string) => surface.getSession(id),
      updateSession: (id: string, patch: Parameters<typeof surface.updateSession>[1]) =>
        surface.updateSession(id, patch),
      foldMessages: (id: string) => surface.foldMessages(id),
      appendMessage: surface.appendMessage.bind(surface),
      appendReplacement: surface.appendReplacement.bind(surface),
      hideByKey: surface.hideByKey.bind(surface),
      hideRange: surface.hideRange.bind(surface),
      listSurfaceNodes: surface.listSurfaceNodes.bind(surface),
      claimInbox: surface.claimInbox.bind(surface),
      enqueueSteer: surface.enqueueSteer.bind(surface),
      claimWriter: surface.claimWriter.bind(surface),
      releaseWriter: surface.releaseWriter.bind(surface),
      getAgent: (id: string) => (id === agent.id ? agent : undefined),
      getTask: () => undefined,
      listApprovals: () => [],
      getDaemonControl: () => undefined
    },
    repoRoot: mkdtempSync(join(tmpdir(), 'startup-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'startup-state-')),
    tools: [],
    modelAdapter: { name: 'stub', runTurn: async () => ({ stopReason: 'end' as const, assistantParts: [] }) },
    promptBuilder: {
      lastCognitivePhaseBySession: new Map(),
      getRouting: () => undefined,
      buildMemoryAppendix: async () => '',
      buildStablePrefix: () => 'stable',
      buildSystemPrompt: async () => {
        if (opts?.slowPrompt) await delay(40);
        return 'system';
      }
    },
    mcpManager: { ensureLoaded: async () => undefined },
    extensionRegistry: new ExtensionRegistry(),
    maxTurnsPerRun: 2,
    turnShapeBySession: new Map(),
    cumulativeInputTokensBySession: new Map(),
    sessionAbortControllers: new Map([[session.id, controller]]),
    emitTrace: (_sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) => {
      events.push(event);
      if (opts?.throwTrace && event.kind === 'startup_phase') throw new Error('trace failed');
    },
    mergeSessionMetadata: (id: string, patch: Record<string, unknown>) => {
      const current = surface.getSession(id)!;
      return surface.updateSession(id, { metadata: { ...current.metadata, ...patch } });
    },
    ensureWorkspaceRoot: async () => undefined,
    ingestMailbox: async () => undefined,
    autoClaimTask: async () => undefined,
    mergedFilePolicy: async () => undefined,
    autoCompact: async () => ({}),
    prepareMessagesForModel: async (_session: unknown, messages: unknown) => messages,
    applyOptionalFoldBudget: (_session: unknown, folded: unknown) => folded,
    resolveImageDataUrl: async () => undefined,
    runTurnWithRetries: async () => {
      modelCalls += 1;
      return { stopReason: 'end' as const, assistantParts: [{ type: 'text' as const, text: 'done' }] };
    },
    filterValidToolCalls: () => [],
    checkToolApprovals: async () => 'proceed' as const,
    executeToolCalls: async () => [],
    processToolResults: () => undefined,
    handleTurnCompletion: async (current: { id: string }) => surface.updateSession(current.id, { status: 'idle' })
  };
  return { host, session, events, modelCalls: () => modelCalls };
}

test('kernel records shared startup phases without message text [AC:bot-startup-trace#AC-1] [AC:bot-startup-trace#AC-5]', async () => {
  const { runSessionKernel } = await loadKernel();
  const { host, session, events } = await createHost({ slowPrompt: true });
  await runSessionKernel(host, session.id);
  const phases = startupEvents(events);
  const names = phases.map((event) => event.payload?.phase);
  for (const name of SHARED) assert.ok(names.includes(name), `missing ${name}`);
  const ready = phases.filter((event) => event.payload?.phase === 'ready');
  assert.equal(ready.length, 1);
  const summary = ready[0]!.payload!;
  assert.equal(summary.scope, 'kernel');
  assert.equal(summary.slowest, 'build_system_prompt');
  assert.equal((summary.phases as Record<string, number>).writer_claim >= 0, true);
  assert.equal(typeof (summary.phases as Record<string, number>).before_model, 'number');
  const beforeModel = phases.find((event) => event.payload?.phase === 'before_model');
  assert.equal(typeof beforeModel?.payload?.durationMs, 'number');
  assert.ok((beforeModel?.payload?.durationMs as number) >= 0);
  const blob = JSON.stringify(phases);
  assert.equal(blob.includes(SECRET), false);
  assert.equal(blob.includes('http'), false);
});

test('abandoned start emits exactly one ready summary [AC:bot-startup-trace#AC-2]', async () => {
  const { runSessionKernel } = await loadKernel();
  const { host, session, events, modelCalls } = await createHost({ abort: true });
  const ended = await runSessionKernel(host, session.id);
  assert.equal(modelCalls(), 0);
  assert.equal(ended.status, 'failed');
  const ready = startupEvents(events).filter((event) => event.payload?.phase === 'ready');
  assert.equal(ready.length, 1);
  const summary = ready[0]!.payload!;
  assert.equal(typeof summary.durationMs, 'number');
  assert.equal(typeof summary.slowest, 'string');
  assert.equal(typeof summary.slowestMs, 'number');
  assert.equal(typeof (summary.phases as Record<string, number>).writer_claim, 'number');
  assert.equal(JSON.stringify(ready).includes(SECRET), false);
});

test('throwing startup trace does not fail the turn [AC:bot-startup-trace#AC-6]', async () => {
  const { runSessionKernel } = await loadKernel();
  const { host, session, events, modelCalls } = await createHost({ throwTrace: true, slowPrompt: true });
  const ended = await runSessionKernel(host, session.id);
  assert.equal(ended.status, 'idle');
  assert.equal(modelCalls(), 1);
  const ready = startupEvents(events).filter((event) => event.payload?.phase === 'ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0]!.payload?.slowest, 'build_system_prompt');
  const beforeModel = startupEvents(events).find((event) => event.payload?.phase === 'before_model');
  assert.equal(beforeModel?.payload?.durationMs, 0);
});
