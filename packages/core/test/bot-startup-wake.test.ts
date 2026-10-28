import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

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

const SECRET = 'PLANTED_WAKE_BODY_ac7_not_for_logs';

test('wake records queue wait and room context without the message body [AC:bot-startup-trace#AC-7]', async () => {
  // Static import is translated before registerHooks can erase parameter properties.
  const { SqliteStateStore } = await import('../src/storage.ts');
  const { createBot } = await import('../src/bots/bot-facade.ts');
  const { createChatSession } = await import('../src/runtime/session-facade.ts');
  const { enqueueBotMessage, drainBotSession, resolveBotPrincipal } = await import('../src/bots/bot-work.ts');
  const { BotRoomService } = await import('../src/rooms/index.ts');
  const { setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');

  const dir = mkdtempSync(join(tmpdir(), 'bot-startup-wake-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const events: Array<{ sessionId: string; payload: { phase?: string; scope?: string; durationMs?: number } }> = [];
  setStartupPhaseEmitter((sessionId, event) => {
    events.push({ sessionId, payload: event.payload });
  });
  try {
    const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions() {}, wakeAgentSessions() {} };
    const sender = createBot(facade, { name: 'Wake Sender' });
    const target = createBot(facade, { name: 'Wake Target' });
    const principal = resolveBotPrincipal(store);
    const opened = store.getSession(target.canonicalSessionId);
    store.updateSession(target.canonicalSessionId, { status: 'running', metadata: { ...opened?.metadata, ...principal } });
    const queued = enqueueBotMessage(facade as never, {
      principal,
      senderBotId: sender.id,
      targetBotId: target.id,
      message: SECRET
    });
    const waitedMs = 2_500;
    store.db.prepare('UPDATE bot_work_messages SET created_at=? WHERE id=?').run(new Date(Date.now() - waitedMs).toISOString(), queued.messageId);
    store.updateSession(queued.sessionId, { status: 'idle' });
    const host = {
      store,
      log: { warn() {}, info() {}, debug() {}, error() {} },
      runSession: async () => store.getSession(queued.sessionId)
    };
    assert.equal(drainBotSession(host, queued.sessionId), true);
    const queue = events.find(entry => entry.payload.phase === 'queue_wait');
    assert.ok(queue, 'queue_wait is recorded');
    assert.equal(queue.payload.scope, 'wake');
    assert.equal(queue.sessionId, queued.sessionId);
    assert.ok(queue.payload.durationMs !== undefined && queue.payload.durationMs >= waitedMs - 50, `queue_wait duration ${queue.payload.durationMs}`);

    const roomHost = {
      store,
      createChatSession: (input: { title?: string; agentId?: string; metadata?: Record<string, unknown> }) => createChatSession(facade, input),
      cancelSession() {},
      async runSession() { return undefined; }
    };
    const rooms = new BotRoomService(roomHost);
    const room = rooms.create(principal, { title: 'Wake room', botIds: [sender.id, target.id], hostBotId: sender.id });
    rooms.send(principal, room.id, { text: SECRET, mentions: [target.id] });
    const before = events.length;
    await rooms.tick();
    const roomPhase = events.slice(before).find(entry => entry.payload.phase === 'room_context');
    assert.ok(roomPhase, 'room_context is recorded');
    assert.equal(roomPhase.payload.scope, 'wake');
    assert.equal(typeof roomPhase.sessionId, 'string');
    assert.equal(typeof roomPhase.payload.durationMs, 'number');
    assert.ok(roomPhase.payload.durationMs >= 0);
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  } finally {
    setStartupPhaseEmitter(undefined);
    store.db.close();
  }
});

test('per-turn startup phases stay off the console [AC:bot-startup-trace#AC-8]', async () => {
  const { logStartupPhase, setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');
  const logs: unknown[][] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args); };
  const traced: string[] = [];
  setStartupPhaseEmitter((_sessionId, event) => { traced.push(event.payload.phase); });
  try {
    logStartupPhase('s1', { phase: 'goal_intake', scope: 'admit', durationMs: 11_000 });
    logStartupPhase('s1', { phase: 'ready', scope: 'kernel', durationMs: 780, slowest: 'goal_intake', slowestMs: 11_000 });
    logStartupPhase(undefined, { phase: 'sqlite_open', scope: 'boot', durationMs: 2 });
    assert.equal(logs.some(entry => JSON.stringify(entry).includes('goal_intake')), false);
    assert.equal(logs.some(entry => JSON.stringify(entry).includes('ready')), false);
    assert.equal(logs.some(entry => JSON.stringify(entry).includes('sqlite_open')), true);
    assert.deepEqual(traced, []);
  } finally {
    console.log = original;
    setStartupPhaseEmitter(undefined);
  }
});
