import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyContextSources,
  contextSourceModelText,
  normalizeContextSources,
  CONTEXT_SOURCE_LIMIT,
  CONTEXT_TEXT_CHAR_LIMIT
} from '../dist/ingestion/context-sources.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/index.js';
import { createChatSession, enqueueSteer } from '../dist/runtime/session-facade.js';
import { BotRoomService } from '../dist/rooms/index.js';

class StubAdapter {
  constructor() {
    this.name = 'stub';
    this.lastInput = undefined;
  }
  async runTurn(input) {
    this.lastInput = input;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  }
  async summarizeMessages() {
    return 'summary';
  }
}

function makeRuntime() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ctx-src-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'ctx-src-state-'));
  const adapter = new StubAdapter();
  const rt = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
  return { rt, adapter };
}

test('normalizeContextSources drops unnamed sources and enforces limits', () => {
  const emptyName = normalizeContextSources([{ kind: 'file', name: '  ', text: 'skip' }]);
  assert.equal(emptyName.length, 0);

  const many = Array.from({ length: CONTEXT_SOURCE_LIMIT + 5 }, (_, i) => ({
    kind: 'file',
    name: `f${i}.txt`,
    text: 'x'
  }));
  assert.equal(normalizeContextSources(many).length, CONTEXT_SOURCE_LIMIT);

  const overBudget = normalizeContextSources([
    { kind: 'file', name: 'big.txt', text: 'a'.repeat(CONTEXT_TEXT_CHAR_LIMIT + 50) }
  ]);
  assert.equal(overBudget[0].name, 'big.txt');
  assert.equal(overBudget[0].text.length, CONTEXT_TEXT_CHAR_LIMIT);

  const folder = normalizeContextSources([
    {
      kind: 'folder',
      name: 'pack',
      entries: [{ path: 'inner.txt', text: 'nested unique phrase ctx-folder-7' }]
    }
  ]);
  assert.equal(folder[0].kind, 'folder');
  assert.equal(folder[0].entries[0].path, 'inner.txt');
});

test('chat send persists contextSources and model text after reload', () => {
  const { rt } = makeRuntime();
  const session = rt.createChatSession({ title: 'drag ctx' });
  const filePhrase = 'unique-drag-file-phrase-ac3';
  const folderPhrase = 'unique-drag-folder-phrase-ac3';
  rt.sendUserMessage(session.id, 'please read', {
    contextSources: [
      { kind: 'file', name: 'note.txt', text: filePhrase },
      {
        kind: 'folder',
        name: 'docs',
        entries: [{ path: 'readme.txt', text: folderPhrase }]
      }
    ]
  });

  const msgs = rt.getSessionMessages(session.id);
  const user = msgs.find((m) => m.role === 'user');
  assert.ok(user);
  const carrier = user.parts.find((p) => p.type === 'text' && p.contextSources?.length);
  assert.ok(carrier, 'user text part should carry contextSources');
  assert.deepEqual(
    carrier.contextSources.map((s) => s.name),
    ['note.txt', 'docs']
  );

  const reloaded = new RawAgentRuntime({
    repoRoot: rt.repoRoot,
    stateDir: rt.stateDir,
    modelAdapter: new StubAdapter()
  });
  const again = reloaded.getSessionMessages(session.id).find((m) => m.role === 'user');
  assert.deepEqual(again.parts.find((p) => p.contextSources)?.contextSources?.map((s) => s.name), [
    'note.txt',
    'docs'
  ]);

  const modelBlob = user.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  assert.ok(modelBlob.includes(filePhrase));
  assert.ok(modelBlob.includes(folderPhrase));
  assert.ok(contextSourceModelText(carrier.contextSources).includes(filePhrase));
});

test('contextSources stay on the sending session only', () => {
  const { rt } = makeRuntime();
  const a = rt.createChatSession({ title: 'A' });
  const b = rt.createChatSession({ title: 'B' });
  rt.sendUserMessage(a.id, 'with ctx', {
    contextSources: [{ kind: 'file', name: 'only-a.txt', text: 'secret-a' }]
  });
  const aPart = rt.getSessionMessages(a.id).find((m) => m.role === 'user')?.parts.find((p) => p.contextSources);
  const bMsgs = rt.getSessionMessages(b.id);
  assert.ok(aPart?.contextSources?.[0]?.name === 'only-a.txt');
  assert.ok(!JSON.stringify(bMsgs).includes('only-a.txt'));
  assert.ok(!JSON.stringify(bMsgs).includes('secret-a'));
});

test('bot room message persists contextSources for members', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-room-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const facade = { store, runImageRetention: async () => {}, wakeAllAutonomousSessions: () => {}, wakeAgentSessions: () => {} };
  const bot = createBot(facade, { name: 'RoomBot' });
  const principal = { userId: 'owner', tenantId: 'team' };
  store.updateSession(bot.canonicalSessionId, {
    metadata: { ...store.getSession(bot.canonicalSessionId).metadata, ...principal }
  });
  const host = {
    store,
    createChatSession: (input) => createChatSession(facade, input),
    runSession: async () => {},
    cancelSession: () => {}
  };
  const rooms = new BotRoomService(host);
  const room = rooms.create(principal, { title: 'Ctx', botIds: [bot.id], hostBotId: bot.id });
  const phrase = 'room-unique-phrase-ac5';
  const sent = rooms.send(principal, room.id, {
    text: 'discuss',
    contextSources: [
      { kind: 'file', name: 'brief.txt', text: phrase },
      {
        kind: 'folder',
        name: 'bundle',
        entries: [{ path: 'x.txt', text: 'nested in room' }]
      }
    ]
  });
  const saved = rooms.messages(principal, room.id).messages.find((m) => m.sender.type === 'user');
  assert.deepEqual(saved.contextSources?.map((s) => s.name), ['brief.txt', 'bundle']);
  assert.ok(JSON.stringify(saved.contextSources).includes(phrase));

  const reopened = new BotRoomService(host);
  const again = reopened.messages(principal, room.id).messages.find((m) => m.sender.type === 'user');
  assert.deepEqual(again.contextSources?.map((s) => s.name), ['brief.txt', 'bundle']);
  assert.equal(store.listMessages(bot.canonicalSessionId).length, 0);
  const session = store.getSession(bot.canonicalSessionId);
  const prompt = rooms.historyForTurn(room, sent.turn, session).parts.map(part => part.text ?? '').join('\n');
  assert.equal(prompt.split(phrase).length - 1, 1, 'file body is included only once, inside its external fence');
});

test('applyContextSources skips empty model bodies but keeps names on carrier', () => {
  const sources = normalizeContextSources([
    { kind: 'file', name: 'empty.txt', text: '' },
    { kind: 'file', name: 'real.txt', text: 'body' }
  ]);
  const parts = applyContextSources([{ type: 'text', text: 'hi' }], sources);
  const texts = parts.filter((p) => p.type === 'text');
  assert.equal(texts[0].text, 'hi');
  assert.deepEqual(texts[0].contextSources.map((s) => s.name), ['empty.txt', 'real.txt']);
  assert.ok(texts.some((p) => p.text.includes('body')));
});

test('queued steer context survives reopening and editing before landing', async () => {
  const { applyClaimedInbox } = await import('@ppeng/agent-loop');
  const { rt } = makeRuntime();
  const session = rt.createChatSession({ title: 'queued context' });
  const sources = [{ kind: 'file', name: 'steer.txt', text: 'queued unique sentence' }];
  const contextParts = applyContextSources([], sources);
  const ack = enqueueSteer(rt.store, session.id, 'read this', { target: 'next-run', contextParts });
  assert.notEqual(ack.status, 'not_submitted');
  const reopened = new SqliteStateStore(join(rt.stateDir, 'runtime.sqlite'));
  reopened.updateUnclaimedInbox(session.id, ack.item.id, 'updated request');
  const items = reopened.claimInbox(session.id, 'next-run');
  assert.deepEqual(items[0].contextParts, contextParts);
  applyClaimedInbox(reopened, session.id, items);
  const message = reopened.listMessages(session.id).find(message => message.parts.some(part => part.contextSources));
  assert.equal(message.parts[0].text, 'updated request');
  assert.deepEqual(message.parts[1].contextSources, sources);
  assert.match(message.parts[1].text, /queued unique sentence/);
});
