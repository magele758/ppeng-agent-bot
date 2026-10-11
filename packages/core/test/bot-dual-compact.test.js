/**
 * Canonical bot chats compact at 50% / 85% of the model window.
 * Ordinary chats keep the derived history budget (~109k on the default window).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { autoCompactSession } from '../dist/runtime/compact-host.js';
import { createExtensionRegistry } from '../dist/extensions/extension-registry.js';
import { estimateMessageTokens } from '../dist/model/token-estimate.js';
import { resolveHistoryTokenBudget, resolveMaxContextTokens } from '../dist/session/session-budget.js';
import { filterSessionsByQuery } from '../dist/session-query.js';
import { unmatchedToolCallIds } from '../dist/session/surface-invariants.js';

const STRUCTURED_SECTIONS = ['Goal', 'Constraints', 'Progress', 'Decisions', 'Files', 'Next steps'];

function thresholds() {
  const windowTokens = resolveMaxContextTokens(process.env);
  const plainThreshold = resolveHistoryTokenBudget('RAW_AGENT_COMPACT_TOKEN_THRESHOLD', {}, process.env);
  return {
    windowTokens,
    plainThreshold,
    structuredTokens: Math.floor(windowTokens * 0.5),
    hygieneTokens: Math.floor(windowTokens * 0.85)
  };
}

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-compact-'));
  return { dir, store: new SqliteStateStore(join(dir, 'state.db')) };
}

function compactHost(store, dir, adapter) {
  return {
    store,
    stateDir: dir,
    modelAdapter: adapter,
    extensionRegistry: createExtensionRegistry(),
    turnShapeBySession: new Map(),
    emitTrace() {},
    prepareMessagesForModel: async (_session, messages) => messages
  };
}

function runContext(dir, session) {
  return {
    repoRoot: '/repo',
    stateDir: dir,
    session,
    agent: {
      id: session.agentId,
      name: session.agentId,
      role: 'assistant',
      instructions: '',
      capabilities: []
    }
  };
}

function scripted(summarize) {
  const calls = [];
  return {
    calls,
    adapter: {
      name: 'scripted',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages(input) {
        calls.push(input);
        return summarize(input, calls.length);
      }
    }
  };
}

function messageText(messages) {
  return messages
    .map((message) =>
      message.parts
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'tool_result') return part.content;
          return '';
        })
        .join('\n')
    )
    .join('\n');
}

function foldText(store, sessionId) {
  return messageText(store.foldMessages(sessionId));
}

function createSession(store, kind) {
  const metadata =
    kind === 'canonical'
      ? { canonicalBotChat: true, botId: 'bot-a' }
      : kind === 'bot-other'
        ? { botId: 'bot-a' }
        : {};
  return store.createSession({
    title: kind === 'plain' ? 'plain chat' : 'bot chat',
    mode: 'chat',
    agentId: kind === 'plain' ? 'general' : 'bot-a',
    metadata
  });
}

/** Oldest pad, then labeled turns, sized so the fold lands on `target` tokens. */
function seedTurns(store, kind, target, turns = 40) {
  const session = createSession(store, kind);
  const turnMessages = Array.from({ length: turns }, (_, i) => ({
    role: 'user',
    parts: [{ type: 'text', text: `turn-${i}` }]
  }));
  const turnTokens = estimateMessageTokens(turnMessages);
  const textTokens = Math.max(1, target - turnTokens - 4);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'P'.repeat(textTokens * 4) }]);
  for (const message of turnMessages) {
    store.appendMessage(session.id, message.role, message.parts);
  }
  return session;
}

function archiveText(dir, sessionId) {
  const folder = join(dir, 'transcripts', sessionId);
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return '';
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readFileSync(join(folder, name), 'utf8'))
    .join('\n');
}

test('default window fractions sit below the old compact budget [AC:bot-dual-compact#AC-1]', () => {
  assert.equal(process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS, undefined);
  assert.equal(process.env.RAW_AGENT_COMPACT_TOKEN_THRESHOLD, undefined);
  assert.equal(process.env.RAW_AGENT_OUTPUT_RESERVE_TOKENS, undefined);
  const { windowTokens, structuredTokens, hygieneTokens, plainThreshold } = thresholds();
  assert.equal(windowTokens, 131072);
  assert.equal(structuredTokens, 65536);
  assert.equal(hygieneTokens, 111411);
  assert.equal(plainThreshold, 109072);
  assert.ok(structuredTokens < plainThreshold);
  assert.ok(plainThreshold < hygieneTokens);
});

test('canonical bot at half the window gets a structured summary; a plain chat does not [AC:bot-dual-compact#AC-1]', async () => {
  const { structuredTokens, hygieneTokens } = thresholds();
  const { dir, store } = tmpStore();
  const bot = seedTurns(store, 'canonical', structuredTokens);
  const plain = seedTurns(store, 'plain', structuredTokens);
  const botTokens = estimateMessageTokens(store.foldMessages(bot.id));
  const plainTokens = estimateMessageTokens(store.foldMessages(plain.id));
  assert.ok(botTokens >= structuredTokens && botTokens < hygieneTokens);
  assert.ok(plainTokens >= structuredTokens && plainTokens < hygieneTokens);

  const botModel = scripted(() =>
    ['Goal: ship', 'Constraints: none', 'Progress: started', 'Decisions: sqlite', 'Files: a.ts', 'Next steps: test'].join('\n')
  );
  const plainModel = scripted(() => 'PLAIN');
  const botResult = await autoCompactSession(
    compactHost(store, dir, botModel.adapter),
    runContext(dir, store.getSession(bot.id))
  );
  const plainResult = await autoCompactSession(
    compactHost(store, dir, plainModel.adapter),
    runContext(dir, store.getSession(plain.id))
  );

  assert.ok(botResult.replaced);
  assert.equal(plainResult.replaced, undefined);
  assert.equal(plainModel.calls.length, 0);
  assert.equal(botModel.calls.length, 1);
  const asked = messageText(botModel.calls[0].messages);
  for (const section of STRUCTURED_SECTIONS) assert.match(asked, new RegExp(section));
  const visible = foldText(store, bot.id);
  for (const section of STRUCTURED_SECTIONS) assert.match(visible, new RegExp(section));
  assert.equal(foldText(store, plain.id).includes('PLAIN'), false);
  assert.equal(store.foldMessages(plain.id).length, store.listMessages(plain.id).length);
  store.db.close();
});

test('a second half-window compact updates the existing summary [AC:bot-dual-compact#AC-2]', async () => {
  const { structuredTokens, hygieneTokens } = thresholds();
  const { dir, store } = tmpStore();
  const session = seedTurns(store, 'canonical', structuredTokens);
  const first = 'Goal: ship\nConstraints: none\nProgress: started\nDecisions: sqlite\nFiles: a.ts\nNext steps: test';
  const second = 'Goal: ship\nConstraints: none\nProgress: second pass\nDecisions: sqlite\nFiles: a.ts\nNext steps: done';
  const model = scripted((input, n) => {
    const asked = messageText(input.messages);
    if (n === 1) {
      assert.equal(asked.includes('Existing summary'), false);
      return first;
    }
    assert.match(asked, /incrementally/i);
    assert.match(asked, /Existing summary/);
    assert.match(asked, /Goal: ship/);
    assert.equal(asked.includes(second), false);
    return second;
  });
  const host = compactHost(store, dir, model.adapter);
  const firstResult = await autoCompactSession(host, runContext(dir, store.getSession(session.id)));
  assert.ok(firstResult.replaced);
  assert.equal(store.getSession(session.id).summary, first);

  seedTurnsOnto(store, session.id, structuredTokens);
  const again = estimateMessageTokens(store.foldMessages(session.id));
  assert.ok(again >= structuredTokens && again < hygieneTokens);
  const secondResult = await autoCompactSession(host, runContext(dir, store.getSession(session.id)));
  assert.ok(secondResult.replaced);
  assert.equal(model.calls.length, 2);
  assert.equal(store.getSession(session.id).summary, second);
  assert.equal(store.getSession(session.id).summary.includes('SUMMARY stacked'), false);
  assert.equal((store.getSession(session.id).summary.match(/Goal: ship/g) ?? []).length, 1);
  store.db.close();
});

test('at 85% a canonical bot runs hygiene and keeps less recent text [AC:bot-dual-compact#AC-3]', async () => {
  const { structuredTokens, hygieneTokens } = thresholds();
  const { dir, store } = tmpStore();
  const structured = seedTurns(store, 'canonical', structuredTokens);
  const hygiene = seedTurns(store, 'canonical', hygieneTokens);
  assert.ok(estimateMessageTokens(store.foldMessages(structured.id)) < hygieneTokens);
  assert.ok(estimateMessageTokens(store.foldMessages(hygiene.id)) >= hygieneTokens);

  const structuredModel = scripted(() => 'structured-summary');
  const hygieneModel = scripted((input) => {
    const asked = messageText(input.messages);
    assert.match(asked, /hygiene/i);
    assert.equal(asked.includes('exactly these sections'), false);
    return 'hygiene-summary';
  });
  await autoCompactSession(
    compactHost(store, dir, structuredModel.adapter),
    runContext(dir, store.getSession(structured.id))
  );
  await autoCompactSession(
    compactHost(store, dir, hygieneModel.adapter),
    runContext(dir, store.getSession(hygiene.id))
  );

  const structuredFold = foldText(store, structured.id);
  const hygieneFold = foldText(store, hygiene.id);
  assert.match(structuredFold, /turn-16/);
  assert.match(structuredFold, /turn-39/);
  assert.equal(structuredFold.includes('turn-0'), false);
  assert.match(hygieneFold, /turn-39/);
  assert.equal(hygieneFold.includes('turn-16'), false);
  assert.match(hygieneFold, /hygiene-summary/);
  store.db.close();
});

test('open tool waves are not cut, and a boundary pair stays together [AC:bot-dual-compact#AC-4]', async () => {
  const { structuredTokens } = thresholds();
  const { dir, store } = tmpStore();
  const open = createSession(store, 'canonical');
  store.appendMessage(open.id, 'user', [{ type: 'text', text: 'P'.repeat(structuredTokens * 4) }]);
  store.appendMessage(open.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'open-1', name: 'bash', input: { command: 'ls' } }
  ]);
  const openModel = scripted(() => 'should-not-run');
  const openResult = await autoCompactSession(
    compactHost(store, dir, openModel.adapter),
    runContext(dir, store.getSession(open.id))
  );
  assert.equal(openResult.replaced, undefined);
  assert.equal(openModel.calls.length, 0);
  assert.equal(archiveText(dir, open.id), '');
  assert.equal(store.foldMessages(open.id).length, 2);

  const paired = createSession(store, 'canonical');
  const tail = Array.from({ length: 23 }, (_, i) => ({
    role: 'user',
    parts: [{ type: 'text', text: `tail-${i}` }]
  }));
  const head = Array.from({ length: 14 }, (_, i) => ({
    role: 'user',
    parts: [{ type: 'text', text: `head-${i}` }]
  }));
  const planned = [
    { role: 'user', parts: [{ type: 'text', text: 'P'.repeat(8) }] },
    ...head,
    { role: 'assistant', parts: [{ type: 'tool_call', toolCallId: 'boundary', name: 'bash', input: { command: 'pwd' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'boundary', name: 'bash', ok: true, content: 'paired-result' }] },
    ...tail
  ];
  const plannedTokens = estimateMessageTokens(planned);
  const textTokens = Math.max(1, structuredTokens - plannedTokens + estimateMessageTokens([planned[0]]) - 4);
  planned[0] = { role: 'user', parts: [{ type: 'text', text: 'P'.repeat(textTokens * 4) }] };
  assert.equal(planned.length, 40);
  for (const message of planned) store.appendMessage(paired.id, message.role, message.parts);
  assert.ok(estimateMessageTokens(store.foldMessages(paired.id)) >= structuredTokens);
  const pairedModel = scripted(() => 'boundary-summary');
  const pairedResult = await autoCompactSession(
    compactHost(store, dir, pairedModel.adapter),
    runContext(dir, store.getSession(paired.id))
  );
  assert.ok(pairedResult.replaced);
  const folded = store.foldMessages(paired.id);
  assert.deepEqual(unmatchedToolCallIds(folded), []);
  const parts = folded.flatMap((message) => message.parts);
  const calls = parts.filter((part) => part.type === 'tool_call' && part.toolCallId === 'boundary');
  const results = parts.filter((part) => part.type === 'tool_result' && part.toolCallId === 'boundary');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].content, 'paired-result');
  store.db.close();
});

test('large old tool output is pruned before the summary, archived, and the summary stays searchable [AC:bot-dual-compact#AC-5]', async () => {
  const { structuredTokens, hygieneTokens } = thresholds();
  const { dir, store } = tmpStore();
  const session = createSession(store, 'canonical');
  const oldDump = `${'h'.repeat(400)}UNIQUE_OLD_TOOL_DUMP_${'Z'.repeat(800)}`;
  const recentDump = `RECENT_TOOL_FULL_${'Q'.repeat(800)}`;
  const turns = Array.from({ length: 24 }, (_, i) => ({
    role: 'user',
    parts: [{ type: 'text', text: `mid-${i}` }]
  }));
  const planned = [
    { role: 'user', parts: [{ type: 'text', text: 'pad' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', toolCallId: 'old', name: 'bash', input: { command: 'old' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'old', name: 'bash', ok: true, content: oldDump }] },
    ...turns,
    { role: 'assistant', parts: [{ type: 'tool_call', toolCallId: 'new', name: 'bash', input: { command: 'new' } }] },
    { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'new', name: 'bash', ok: true, content: recentDump }] }
  ];
  const withoutPad = estimateMessageTokens(planned.slice(1));
  const textTokens = Math.max(1, structuredTokens - withoutPad - 4);
  planned[0] = { role: 'user', parts: [{ type: 'text', text: 'P'.repeat(textTokens * 4) }] };
  for (const message of planned) store.appendMessage(session.id, message.role, message.parts);
  const tokens = estimateMessageTokens(store.foldMessages(session.id));
  assert.ok(tokens >= structuredTokens && tokens < hygieneTokens);

  const model = scripted((input) => {
    const asked = messageText(input.messages);
    assert.equal(asked.includes('UNIQUE_OLD_TOOL_DUMP'), false);
    assert.match(asked, /pruned/);
    return 'Goal: ship\nDecisions: decision-token-orchid';
  });
  const result = await autoCompactSession(
    compactHost(store, dir, model.adapter),
    runContext(dir, store.getSession(session.id))
  );
  assert.ok(result.replaced);
  const visible = foldText(store, session.id);
  assert.match(visible, /decision-token-orchid/);
  assert.match(visible, /RECENT_TOOL_FULL_/);
  assert.equal(visible.includes('UNIQUE_OLD_TOOL_DUMP'), false);
  const wal = store.listMessages(session.id).map((message) => messageText([message])).join('\n');
  assert.match(wal, /UNIQUE_OLD_TOOL_DUMP/);
  assert.match(archiveText(dir, session.id), /UNIQUE_OLD_TOOL_DUMP/);
  const found = filterSessionsByQuery([store.getSession(session.id)], 'decision-token-orchid');
  assert.equal(found.length, 1);
  store.db.close();
});

test('non-canonical chats keep the old compact point [AC:bot-dual-compact#AC-6]', async () => {
  const { structuredTokens, plainThreshold, hygieneTokens } = thresholds();
  assert.ok(structuredTokens < plainThreshold);
  const { dir, store } = tmpStore();
  const plain = seedTurns(store, 'plain', structuredTokens);
  const other = seedTurns(store, 'bot-other', structuredTokens);
  const plainModel = scripted(() => 'PLAIN');
  const otherModel = scripted(() => 'OTHER');
  assert.equal(
    (await autoCompactSession(compactHost(store, dir, plainModel.adapter), runContext(dir, store.getSession(plain.id))))
      .replaced,
    undefined
  );
  assert.equal(
    (await autoCompactSession(compactHost(store, dir, otherModel.adapter), runContext(dir, store.getSession(other.id))))
      .replaced,
    undefined
  );
  assert.equal(plainModel.calls.length, 0);
  assert.equal(otherModel.calls.length, 0);

  const over = seedTurns(store, 'plain', plainThreshold);
  assert.ok(estimateMessageTokens(store.foldMessages(over.id)) >= plainThreshold);
  assert.ok(estimateMessageTokens(store.foldMessages(over.id)) < hygieneTokens + 5000);
  const overModel = scripted((input) => {
    const asked = messageText(input.messages);
    assert.equal(asked.includes('Structured compaction'), false);
    assert.equal(asked.includes('Session hygiene'), false);
    return 'old-path-summary';
  });
  const overResult = await autoCompactSession(
    compactHost(store, dir, overModel.adapter),
    runContext(dir, store.getSession(over.id))
  );
  assert.ok(overResult.replaced);
  assert.equal(overModel.calls.length, 1);
  assert.match(foldText(store, over.id), /old-path-summary/);
  store.db.close();
});

test('overflow force still compacts a short canonical bot with the structured template', async () => {
  const { dir, store } = tmpStore();
  const session = createSession(store, 'canonical');
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'remember the ledger' }]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'noted' }]);
  const model = scripted((input) => {
    const asked = messageText(input.messages);
    for (const section of STRUCTURED_SECTIONS) assert.match(asked, new RegExp(section));
    assert.equal(/hygiene/i.test(asked), false);
    return 'Goal: ledger';
  });
  const result = await autoCompactSession(
    compactHost(store, dir, model.adapter),
    runContext(dir, store.getSession(session.id)),
    { force: true }
  );
  assert.ok(result.replaced);
  assert.match(foldText(store, session.id), /Goal: ledger/);
  assert.match(archiveText(dir, session.id), /remember the ledger/);
  store.db.close();
});

test('a canonical bot under half the window is left alone [AC:bot-dual-compact#AC-7]', async () => {
  const { structuredTokens } = thresholds();
  const { dir, store } = tmpStore();
  const session = seedTurns(store, 'canonical', structuredTokens - 200);
  assert.ok(estimateMessageTokens(store.foldMessages(session.id)) < structuredTokens);
  const model = scripted(() => 'nope');
  const result = await autoCompactSession(
    compactHost(store, dir, model.adapter),
    runContext(dir, store.getSession(session.id))
  );
  assert.equal(result.replaced, undefined);
  assert.equal(model.calls.length, 0);
  store.db.close();
});

function seedTurnsOnto(store, sessionId, target) {
  const turnMessages = Array.from({ length: 8 }, (_, i) => ({
    role: 'user',
    parts: [{ type: 'text', text: `again-${i}` }]
  }));
  const have = estimateMessageTokens(store.foldMessages(sessionId));
  const turnTokens = estimateMessageTokens(turnMessages);
  const textTokens = Math.max(1, target - have - turnTokens - 4);
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Q'.repeat(textTokens * 4) }]);
  for (const message of turnMessages) {
    store.appendMessage(sessionId, message.role, message.parts);
  }
}
