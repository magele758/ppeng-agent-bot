/**
 * Normal sessions: the request actually sent stays at or below 20% of the
 * context window. Canonical bot chats keep the 50% / 85% compact path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { SqliteStateStore } from '../dist/storage.js';
import {
  BOT_HYGIENE_COMPACT_RATIO,
  BOT_STRUCTURED_COMPACT_RATIO,
  botCompactTokenThresholds
} from '../dist/session/bot-compact-policy.js';
import { resolveMaxContextTokens } from '../dist/session/session-budget.js';
import {
  NORMAL_SESSION_REQUEST_RATIO,
  estimateNormalRequestTokens,
  fitNormalSessionRequest,
  normalRequestCapTokens
} from '../dist/session/normal-request-budget.js';
import { applyNormalSessionRequestBudget } from '../dist/runtime/normal-request-guard.js';

const QUESTION = 'LATEST_QUESTION';
const APPENDIX = 'MEMORY_APPENDIX';
const SYS = 'LEADING_SYSTEM';

function msg(role, parts, extra = {}) {
  return {
    id: extra.id ?? `${role}-${parts[0]?.toolCallId ?? parts[0]?.text?.slice(0, 12) ?? 'x'}`,
    sessionId: extra.sessionId ?? 's',
    role,
    parts,
    createdAt: '2026-10-13T00:00:00.000Z',
    seq: extra.seq,
    ...extra
  };
}

function text(role, body, extra) {
  return msg(role, [{ type: 'text', text: body }], extra);
}

function wave(id, content) {
  return [
    msg(
      'assistant',
      [{ type: 'tool_call', toolCallId: id, name: 'bash', input: { id } }],
      { id: `a-${id}` }
    ),
    msg(
      'tool',
      [{ type: 'tool_result', toolCallId: id, name: 'bash', ok: true, content }],
      { id: `t-${id}` }
    )
  ];
}

function latestUser(extra) {
  return text('user', `${APPENDIX}\n\n${QUESTION}`, { id: 'latest-user', ...extra });
}

function requestOf(messages, extra = {}) {
  return {
    systemPrompt: extra.systemPrompt ?? 'sys',
    tools: extra.tools ?? [],
    messages,
    sessionId: 's',
    ...extra
  };
}

function tokens(input) {
  return estimateNormalRequestTokens(input);
}

function hasOrphan(messages) {
  const open = new Set();
  for (const message of messages) {
    const calls = [];
    const results = [];
    for (const part of message.parts) {
      if (part.type === 'tool_call') calls.push(part.toolCallId);
      if (part.type === 'tool_result') results.push(part.toolCallId);
    }
    for (const id of results) {
      if (!open.has(id)) return true;
    }
    for (const id of calls) open.add(id);
    for (const id of results) open.delete(id);
  }
  return false;
}

function joined(messages) {
  return messages
    .flatMap((message) =>
      message.parts.map((part) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'tool_result') return part.content;
        return '';
      })
    )
    .join('\n');
}

test('default cap is 20% of the resolved window and ignores a new env name [AC:normal-session-request-budget#AC-7]', () => {
  const previousWindow = process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
  const previousFake = process.env.RAW_AGENT_NORMAL_REQUEST_RATIO;
  delete process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
  process.env.RAW_AGENT_NORMAL_REQUEST_RATIO = '0.9';
  try {
    assert.equal(NORMAL_SESSION_REQUEST_RATIO, 0.2);
    assert.equal(resolveMaxContextTokens(process.env), 131072);
    assert.equal(normalRequestCapTokens(131072), 26214);
    assert.equal(normalRequestCapTokens(resolveMaxContextTokens(process.env)), 26214);
    assert.equal(normalRequestCapTokens(200000), 40000);
    assert.equal(normalRequestCapTokens(1000), 200);
  } finally {
    if (previousWindow === undefined) delete process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
    else process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS = previousWindow;
    if (previousFake === undefined) delete process.env.RAW_AGENT_NORMAL_REQUEST_RATIO;
    else process.env.RAW_AGENT_NORMAL_REQUEST_RATIO = previousFake;
  }
});

test('under the cap the request is sent unchanged and keeps the latest question [AC:normal-session-request-budget#AC-1]', () => {
  const messages = [
    text('system', SYS, { id: 'sys' }),
    latestUser()
  ];
  const input = requestOf(messages, { maxContextTokens: 131072 });
  const fit = fitNormalSessionRequest(input);
  assert.equal(fit.messages, messages);
  assert.equal(fit.pinnedOverBudget, false);
  assert.equal(fit.summarizePrefix, null);
  assert.ok(fit.requestTokens <= fit.capTokens);
  assert.ok(joined(fit.messages).includes(QUESTION));
});

test('over the cap, older closed tool waves drop and the appendix stays [AC:normal-session-request-budget#AC-2]', () => {
  const windowTokens = 1000;
  const cap = normalRequestCapTokens(windowTokens);
  const messages = [
    text('system', SYS, { id: 'sys' }),
    ...wave('old', `OLD_WAVE ${'o'.repeat(800)}`),
    ...wave('mid', `MID_WAVE ${'m'.repeat(800)}`),
    ...wave('new', `NEW_WAVE ${'n'.repeat(200)}`),
    latestUser()
  ];
  const input = requestOf(messages, { systemPrompt: 'prompt', maxContextTokens: windowTokens });
  assert.ok(tokens(input) > cap);
  const pinned = requestOf(
    [messages[0], messages[messages.length - 1]],
    { systemPrompt: 'prompt', maxContextTokens: windowTokens }
  );
  assert.ok(tokens(pinned) <= cap);

  const fit = fitNormalSessionRequest(input);
  assert.equal(fit.summarizePrefix, null);
  assert.equal(fit.pinnedOverBudget, false);
  assert.ok(fit.requestTokens <= cap);
  assert.equal(fit.messages[0].id, 'sys');
  const body = joined(fit.messages);
  assert.equal(body.includes('OLD_WAVE'), false);
  assert.ok(body.includes(APPENDIX));
  assert.ok(body.includes(QUESTION));
  assert.equal(fit.messages.find((message) => message.id === 'latest-user').parts[0].text.includes(APPENDIX), true);
  assert.equal(hasOrphan(fit.messages), false);
  assert.notDeepEqual(fit.messages, messages.slice(-24));
});

test('still over after wave drops, the prefix is summarized and the question stays [AC:normal-session-request-budget#AC-3]', async () => {
  const windowTokens = 1000;
  const messages = [
    text('system', SYS, { id: 'sys', seq: 1 }),
    text('user', `OLD_PREFIX ${'p'.repeat(4000)}`, { id: 'old', seq: 2 }),
    text('assistant', 'noted', { id: 'note', seq: 3 }),
    latestUser({ seq: 4 })
  ];
  const input = requestOf(messages, { systemPrompt: 'prompt', maxContextTokens: windowTokens });
  assert.ok(tokens(input) > normalRequestCapTokens(windowTokens));
  const calls = [];
  const traces = [];
  const sent = await applyNormalSessionRequestBudget(input, {
    session: { id: 's', metadata: {} },
    maxContextTokens: windowTokens,
    emitTrace: (event) => traces.push(event),
    summarize: async (prefix) => {
      calls.push(prefix);
      return 'SUMMARY_OF_PREFIX';
    }
  });
  assert.equal(calls.length, 1);
  assert.ok(joined(calls[0]).includes('OLD_PREFIX'));
  const body = joined(sent.messages);
  assert.ok(body.includes('SUMMARY_OF_PREFIX'));
  assert.ok(body.includes(QUESTION));
  assert.ok(body.includes(APPENDIX));
  assert.equal(body.includes('OLD_PREFIX'), false);
  assert.equal(sent.messages[0].id, 'sys');
  assert.ok(tokens(sent) <= normalRequestCapTokens(windowTokens));
  assert.equal(traces.some((event) => event.kind === 'request_over_budget'), false);
});

test('summary failure does not fall back to a 24-slice [AC:normal-session-request-budget#AC-4]', async () => {
  const windowTokens = 800;
  const messages = [
    text('system', SYS, { id: 'sys' }),
    ...Array.from({ length: 30 }, (_, i) => text('user', `filler-${i} ${'f'.repeat(80)}`, { id: `f-${i}` })),
    latestUser()
  ];
  assert.ok(messages.length > 24);
  const input = requestOf(messages, { systemPrompt: 'prompt', maxContextTokens: windowTokens });
  assert.ok(tokens(input) > normalRequestCapTokens(windowTokens));
  const blind = messages.slice(-24);
  assert.equal(blind.some((message) => message.id === 'sys'), false);
  const sent = await applyNormalSessionRequestBudget(input, {
    session: { id: 's', metadata: {} },
    maxContextTokens: windowTokens,
    summarize: async () => {
      throw new Error('summarizer down');
    }
  });
  assert.equal(sent.messages[0].id, 'sys');
  assert.ok(joined(sent.messages).includes(QUESTION));
  assert.ok(joined(sent.messages).includes(APPENDIX));
  assert.notDeepEqual(sent.messages, blind);
  assert.ok(sent.messages.length > 24);
  assert.equal(sent.messages.some((message) => message.id === 'f-0'), true);
});

test('pinned system prompt and latest question over the cap are sent with a trace [AC:normal-session-request-budget#AC-5]', async () => {
  const windowTokens = 1000;
  const cap = normalRequestCapTokens(windowTokens);
  const messages = [
    text('system', SYS, { id: 'sys' }),
    ...wave('old', 'OLD_WAVE'),
    latestUser()
  ];
  const input = requestOf(messages, {
    systemPrompt: 'S'.repeat(cap * 8),
    maxContextTokens: windowTokens
  });
  const pinnedTokens = tokens(requestOf([messages[0], messages[messages.length - 1]], {
    systemPrompt: input.systemPrompt,
    maxContextTokens: windowTokens
  }));
  assert.ok(pinnedTokens > cap);
  const traces = [];
  let summarized = 0;
  const sent = await applyNormalSessionRequestBudget(input, {
    session: { id: 's', metadata: {} },
    maxContextTokens: windowTokens,
    emitTrace: (event) => traces.push(event),
    summarize: async () => {
      summarized += 1;
      return 'NO';
    }
  });
  assert.equal(summarized, 0);
  assert.equal(sent.messages, messages);
  assert.ok(joined(sent.messages).includes(QUESTION));
  assert.ok(joined(sent.messages).includes('OLD_WAVE'));
  assert.equal(traces.filter((event) => event.kind === 'request_over_budget').length, 1);
});

test('a canonical bot over 20% and under 50% is not shrunk by this rule [AC:normal-session-request-budget#AC-6]', async () => {
  assert.equal(BOT_STRUCTURED_COMPACT_RATIO, 0.5);
  assert.equal(BOT_HYGIENE_COMPACT_RATIO, 0.85);
  const thresholds = botCompactTokenThresholds(131072);
  assert.equal(thresholds.structuredTokens, 65536);
  assert.equal(thresholds.hygieneTokens, 111411);

  const windowTokens = 131072;
  const messages = [
    text('system', SYS, { id: 'sys' }),
    text('user', `BOT_PAD ${'b'.repeat(120000)}`, { id: 'pad' }),
    latestUser()
  ];
  const input = requestOf(messages, { systemPrompt: 'prompt', maxContextTokens: windowTokens });
  assert.ok(tokens(input) > normalRequestCapTokens(windowTokens));
  assert.ok(tokens(input) < thresholds.structuredTokens);
  let summarized = 0;
  const sent = await applyNormalSessionRequestBudget(input, {
    session: { id: 's', metadata: { canonicalBotChat: true, botId: 'bot-a' } },
    maxContextTokens: windowTokens,
    summarize: async () => {
      summarized += 1;
      return 'BOT_SUMMARY';
    }
  });
  assert.equal(summarized, 0);
  assert.equal(sent.messages, messages);
  assert.ok(joined(sent.messages).includes('BOT_PAD'));
  assert.ok(joined(sent.messages).includes(QUESTION));
});

test('a summarized prefix is stored with the existing compact replacement [AC:normal-session-request-budget#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'normal-budget-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({
    title: 'plain',
    mode: 'chat',
    agentId: 'general',
    metadata: {}
  });
  store.appendMessage(session.id, 'system', [{ type: 'text', text: SYS }]);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: `OLD_PREFIX ${'p'.repeat(4000)}` }]);
  store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'noted' }]);
  store.appendMessage(session.id, 'user', [{ type: 'text', text: `${APPENDIX}\n\n${QUESTION}` }]);
  const folded = store.foldMessages(session.id);
  const input = requestOf(folded, { systemPrompt: 'prompt', maxContextTokens: 1000, sessionId: session.id });
  const sent = await applyNormalSessionRequestBudget(input, {
    session: store.getSession(session.id),
    store,
    stateDir: dir,
    maxContextTokens: 1000,
    summarize: async () => 'STORED_SUMMARY'
  });
  assert.ok(joined(sent.messages).includes('STORED_SUMMARY'));
  assert.ok(joined(sent.messages).includes(QUESTION));
  const after = store.foldMessages(session.id);
  assert.ok(joined(after).includes('STORED_SUMMARY'));
  assert.ok(joined(after).includes(QUESTION));
  assert.equal(joined(after).includes('OLD_PREFIX'), false);
  store.db.close();
});

test('parallel tool calls in one wave stay paired [AC:normal-session-request-budget#AC-2]', () => {
  const windowTokens = 1000;
  const messages = [
    text('system', SYS, { id: 'sys' }),
    msg(
      'assistant',
      [
        { type: 'tool_call', toolCallId: 'a', name: 'bash', input: {} },
        { type: 'tool_call', toolCallId: 'b', name: 'bash', input: {} }
      ],
      { id: 'calls' }
    ),
    msg('tool', [{ type: 'tool_result', toolCallId: 'a', name: 'bash', ok: true, content: `A ${'a'.repeat(900)}` }], { id: 'ra' }),
    msg('tool', [{ type: 'tool_result', toolCallId: 'b', name: 'bash', ok: true, content: `B ${'b'.repeat(900)}` }], { id: 'rb' }),
    latestUser()
  ];
  const input = requestOf(messages, { systemPrompt: 'prompt', maxContextTokens: windowTokens });
  assert.ok(tokens(input) > normalRequestCapTokens(windowTokens));
  const fit = fitNormalSessionRequest(input);
  assert.equal(hasOrphan(fit.messages), false);
  const body = joined(fit.messages);
  assert.ok(body.includes(QUESTION));
  if (body.includes('A ')) assert.ok(body.includes('B ') || fit.messages.some((message) => message.id === 'calls') === false);
  const keptCalls = fit.messages.filter((message) => message.id === 'calls');
  if (keptCalls.length === 1) {
    assert.ok(fit.messages.some((message) => message.id === 'ra'));
    assert.ok(fit.messages.some((message) => message.id === 'rb'));
  } else {
    assert.equal(fit.messages.some((message) => message.id === 'ra'), false);
    assert.equal(fit.messages.some((message) => message.id === 'rb'), false);
  }
});

class RecordingAdapter {
  constructor(summarize) {
    this.name = 'recording';
    // This fixture models the 131072-token window used by the canonical Bot
    // criterion; production adapters without a known window use a safe fallback.
    this.contextWindow = 131072;
    this.inputs = [];
    this.summarize = summarize;
  }
  async runTurn(input) {
    this.inputs.push(input);
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  }
  async summarizeMessages(input) {
    return this.summarize(input);
  }
}

test('a live normal turn keeps the latest question inside the 20% request [AC:normal-session-request-budget#AC-1] [AC:normal-session-request-budget#AC-3]', async () => {
  const adapter = new RecordingAdapter(() => 'LIVE_SUMMARY');
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'state-')),
    modelAdapter: adapter
  });
  const session = runtime.createChatSession({ title: 'normal', message: 'seed' });
  runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: `OLD_PREFIX ${'p'.repeat(160000)}` }]);
  runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: QUESTION }]);
  await runtime.runSession(session.id);
  assert.ok(adapter.inputs.length >= 1);
  const sent = adapter.inputs[0];
  const cap = normalRequestCapTokens(resolveMaxContextTokens(process.env));
  const sentTokens = estimateNormalRequestTokens(sent);
  const body = joined(sent.messages);
  assert.ok(body.includes(QUESTION));
  const latest = [...sent.messages].reverse().find((message) => message.role === 'user');
  const leading = [];
  for (const message of sent.messages) {
    if (message.role !== 'system') break;
    leading.push(message);
  }
  const pinnedTokens = estimateNormalRequestTokens({
    systemPrompt: sent.systemPrompt,
    tools: sent.tools,
    messages: latest ? [...leading, latest] : leading
  });
  if (pinnedTokens <= cap) {
    assert.ok(sentTokens <= cap);
    assert.equal(body.includes('OLD_PREFIX'), false);
  } else {
    const events = await runtime.listTraceEvents(session.id);
    assert.ok(events.some((event) => event.kind === 'request_over_budget'));
  }
});

test('a live canonical bot over 20% and under 50% still receives the old prefix [AC:normal-session-request-budget#AC-6]', async () => {
  const adapter = new RecordingAdapter(() => 'BOT_SHOULD_NOT_RUN');
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'state-')),
    modelAdapter: adapter
  });
  const session = runtime.createChatSession({ title: 'bot', message: 'seed' });
  const current = runtime.store.getSession(session.id);
  runtime.store.updateSession(session.id, {
    metadata: { ...current.metadata, canonicalBotChat: true, botId: 'bot-a' }
  });
  runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: `BOT_PAD ${'b'.repeat(160000)}` }]);
  runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: QUESTION }]);
  await runtime.runSession(session.id);
  const sent = adapter.inputs[0];
  const body = joined(sent.messages);
  assert.ok(body.includes(QUESTION));
  assert.ok(body.includes('BOT_PAD'));
  const events = await runtime.listTraceEvents(session.id);
  assert.equal(events.some((event) => event.kind === 'request_over_budget'), false);
});
