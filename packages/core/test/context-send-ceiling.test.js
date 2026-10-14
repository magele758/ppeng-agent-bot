/**
 * Canonical bot send ceiling waits for the 50% compact tier.
 * Task facts cannot blow the ordinary 20% pin. A saved 32768 window is real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { bindTurnKernelHost } from '../dist/runtime/l5-bindings.js';
import { applyNormalSessionRequestBudget } from '../dist/runtime/normal-request-guard.js';
import { buildTaskContext } from '../dist/session/task-context.js';
import { resolveBotContextTokens, resolveBotWindowBudget, readBotContextSettings, writeBotContextSettings } from '../dist/session/history/window.js';
import { estimateMessageTokens, estimateTokensFromText } from '../dist/model/token-estimate.js';
import { resolveMaxContextTokens } from '../dist/session/session-budget.js';
import {
  BOT_HYGIENE_COMPACT_RATIO,
  BOT_STRUCTURED_COMPACT_RATIO,
  botCompactTokenThresholds
} from '../dist/session/bot-compact-policy.js';
import {
  NORMAL_SESSION_REQUEST_RATIO,
  estimateNormalRequestTokens,
  normalRequestCapTokens
} from '../dist/session/normal-request-budget.js';

const LATEST = 'LATEST_USER_QUESTION';

function shapeOf(systemPrompt, tools) {
  const toolSchemaTokens = Math.ceil(JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))).length / 4);
  return { systemPromptChars: systemPrompt.length, toolSchemaTokens };
}

function promptThatBeatsHalf(store, adapter) {
  const tools = [];
  let chars = 4;
  let systemPrompt = 'S'.repeat(chars);
  let budget = resolveBotWindowBudget(store, adapter, shapeOf(systemPrompt, tools));
  for (let i = 0; i < 8 && budget.historyTokens >= budget.structuredTokens - 64; i += 1) {
    const deficit = budget.historyTokens - (budget.structuredTokens - 64);
    chars += deficit * 4 + 8;
    systemPrompt = 'S'.repeat(chars);
    budget = resolveBotWindowBudget(store, adapter, shapeOf(systemPrompt, tools));
  }
  assert.ok(budget.historyTokens < budget.structuredTokens - 64, 'send ceiling must sit under the 50% tier');
  return { systemPrompt, tools, budget };
}

function seedGap(store, sessionId, budget) {
  const low = budget.historyTokens + 8;
  const high = budget.structuredTokens - 8;
  const target = Math.floor((low + high) / 2);
  const latestTokens = 4 + Math.ceil(LATEST.length / 4);
  const ackTokens = 5;
  const padTokens = target - latestTokens - ackTokens - 4;
  assert.ok(padTokens > 0);
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: 'P'.repeat(padTokens * 4) }]);
  store.appendMessage(sessionId, 'assistant', [{ type: 'text', text: 'ack' }]);
  store.appendMessage(sessionId, 'user', [{ type: 'text', text: LATEST }]);
  const tokens = estimateMessageTokens(store.foldMessages(sessionId));
  assert.ok(tokens > budget.historyTokens, `history ${tokens} should exceed ceiling ${budget.historyTokens}`);
  assert.ok(tokens < budget.structuredTokens, `history ${tokens} should be under half ${budget.structuredTokens}`);
}

async function sendCanonicalTurn(contextWindow) {
  let captured;
  let summaries = 0;
  const adapter = {
    name: 'ceiling-probe',
    contextWindow,
    async runTurn(input) {
      captured = input;
      return { assistantParts: [{ type: 'text', text: 'done' }], stopReason: 'end' };
    },
    async summarizeMessages() {
      summaries += 1;
      return 'Goal: keep going\nConstraints: none\nNext steps: unfinished';
    }
  };
  const rt = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'ceiling-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'ceiling-state-')),
    modelAdapter: adapter
  });
  try {
    const bot = rt.createBot({ name: 'Ceiling bot' });
    const session = rt.getSession(rt.openBot(bot.id).sessionId);
    assert.equal(session.metadata.canonicalBotChat, true);
    const fitted = promptThatBeatsHalf(rt.store, adapter);
    seedGap(rt.store, session.id, fitted.budget);
    const host = bindTurnKernelHost(rt.l5());
    await host.runTurnWithRetries({
      sessionId: session.id,
      agent: rt.store.getAgent(bot.agentId),
      systemPrompt: fitted.systemPrompt,
      messages: rt.store.foldMessages(session.id),
      tools: fitted.tools
    });
    assert.ok(captured, 'the turn reached the model');
    assert.ok(summaries >= 1, 'compact ran before the send ceiling');
    assert.ok(estimateMessageTokens(captured.messages) <= fitted.budget.historyTokens);
    const sent = JSON.stringify(captured.messages);
    assert.ok(sent.includes(LATEST));
    const raw = rt.store.listHistory(session.id, { limit: 20 }).messages.map((message) => JSON.stringify(message.parts)).join('\n');
    assert.ok(raw.includes(LATEST));
    return fitted.budget;
  } finally {
    await rt.destroy();
  }
}

test('default 131072 window compacts before the send ceiling [AC:context-send-ceiling#AC-1]', async () => {
  const budget = await sendCanonicalTurn(131072);
  assert.equal(budget.contextTokens, 131072);
  assert.equal(budget.structuredTokens, 65536);
});

test('a small window compacts before the send ceiling [AC:context-send-ceiling#AC-2]', async () => {
  const budget = await sendCanonicalTurn(8000);
  assert.equal(budget.contextTokens, 8000);
  assert.equal(budget.structuredTokens, 4000);
});

function text(role, body, extra = {}) {
  return {
    id: extra.id ?? role,
    sessionId: 's',
    role,
    parts: [{ type: 'text', text: body }],
    createdAt: '2026-10-14T00:00:00.000Z',
    ...extra
  };
}

function wave(id, content) {
  return [
    {
      id: `a-${id}`,
      sessionId: 's',
      role: 'assistant',
      createdAt: '2026-10-14T00:00:00.000Z',
      parts: [{ type: 'tool_call', toolCallId: id, name: 'bash', input: { id } }]
    },
    {
      id: `t-${id}`,
      sessionId: 's',
      role: 'tool',
      createdAt: '2026-10-14T00:00:00.000Z',
      parts: [{ type: 'tool_result', toolCallId: id, name: 'bash', ok: true, content }]
    }
  ];
}

test('task facts cannot by themselves force the whole history through the 20% pin [AC:context-send-ceiling#AC-3]', async () => {
  const windowTokens = 131072;
  const cap = normalRequestCapTokens(windowTokens);
  const factTail = 'KEEP_THIS_CONSTRAINT';
  const huge = `${'必须保留任务事实'.repeat(20000)}${factTail}`;
  const session = {
    id: 's',
    metadata: {
      taskContext: {
        version: 1,
        boundTask: '',
        active: 'conversation',
        tasks: {
          conversation: [{ kind: 'constraint', text: huge, sourceMessageId: 'm1', status: 'active' }]
        }
      }
    }
  };
  const block = buildTaskContext(session);
  assert.ok(block.includes(factTail));
  assert.ok(estimateTokensFromText(block) < cap, 'injected facts alone stay under the 20% pin');
  assert.equal(block.includes(huge), false);

  const messages = [
    ...wave('old', `OLD_WAVE ${'o'.repeat(80_000)}`),
    text('user', LATEST, { id: 'latest-user' })
  ];
  const input = {
    systemPrompt: `You are helper.\n\n${block}`,
    tools: [],
    messages,
    sessionId: 's'
  };
  assert.ok(estimateNormalRequestTokens({ ...input, maxContextTokens: windowTokens }) > cap);
  const sent = await applyNormalSessionRequestBudget(input, {
    session: { id: 's', metadata: {} },
    maxContextTokens: windowTokens,
    summarize: async () => 'SUMMARY'
  });
  const body = sent.messages.flatMap((message) => message.parts.map((part) => part.text ?? part.content ?? '')).join('\n');
  assert.equal(body.includes('OLD_WAVE'), false);
  assert.ok(body.includes(LATEST));
  assert.ok(sent.systemPrompt.includes(factTail));
  assert.equal(sent.systemPrompt.includes(huge), false);
  assert.ok(estimateNormalRequestTokens({ ...sent, maxContextTokens: windowTokens }) <= cap);
});

test('a saved fallback of exactly 32768 is honored [AC:context-send-ceiling#AC-4]', () => {
  const bag = {};
  const store = {
    getDaemonControl: (key) => bag[key],
    setDaemonControl: (key, value) => { bag[key] = value; }
  };
  assert.equal(writeBotContextSettings(store, { fallbackContextTokens: 32768 }).fallbackContextTokens, 32768);
  assert.equal(readBotContextSettings(store).fallbackContextTokens, 32768);
  assert.equal(resolveBotContextTokens(store, {}), 32768);
  assert.equal(resolveBotWindowBudget(store, {}, {}).structuredTokens, 16384);
  assert.equal(resolveBotContextTokens(store, { contextWindow: 64000 }), 64000);
});

test('an unset fallback stays on the default 131072 window [AC:context-send-ceiling#AC-5]', () => {
  const previous = process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
  delete process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
  try {
    const unset = { getDaemonControl: () => undefined };
    assert.equal(resolveMaxContextTokens({}), 131072);
    assert.equal(resolveBotContextTokens(unset, {}), 131072);
    assert.equal(readBotContextSettings(unset).fallbackContextTokens, 131072);
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS;
    else process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS = previous;
  }
});

test('ordinary 20% and bot 50/85 ratios stay unchanged [AC:context-send-ceiling#AC-6]', () => {
  assert.equal(NORMAL_SESSION_REQUEST_RATIO, 0.2);
  assert.equal(BOT_STRUCTURED_COMPACT_RATIO, 0.5);
  assert.equal(BOT_HYGIENE_COMPACT_RATIO, 0.85);
  assert.equal(normalRequestCapTokens(131072), 26214);
  assert.equal(normalRequestCapTokens(8000), 1600);
  assert.deepEqual(botCompactTokenThresholds(131072), { structuredTokens: 65536, hygieneTokens: 111411 });
  assert.deepEqual(botCompactTokenThresholds(8000), { structuredTokens: 4000, hygieneTokens: 6800 });
});
