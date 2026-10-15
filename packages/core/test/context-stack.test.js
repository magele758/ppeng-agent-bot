import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { writeCompactSettings } from '../dist/session/compact-settings.js';
import {
  assembleContextStack,
  describeContextBudget,
  previewSessionContextStack
} from '../dist/session/context-stack.js';

const STUB = '[previous: used bash — earlier tool output was omitted to save space] msg=m1 part=0 seq=4';

function msg(id, role, parts, extra = {}) {
  return {
    id,
    sessionId: 's',
    role,
    parts,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra
  };
}

function budgetShape(extra = {}) {
  return {
    mode: 'normal',
    windowTokens: 1000,
    capTokens: 200,
    requestTokens: 40,
    pinnedTokens: 10,
    pinnedOverBudget: false,
    wouldSummarize: false,
    wouldCompact: false,
    ratio: 0.2,
    structuredTokens: null,
    hygieneTokens: null,
    historyTokens: null,
    messageTokens: 30,
    ...extra
  };
}

test('prepared context payload keeps full text in order [AC:play-context-stack#AC-3]', () => {
  const appendixText = [
    '本轮相关记忆与用户背景（仅供参考；如与用户最新指令冲突，以最新指令为准）：',
    '用户喜欢深色主题',
    '',
    '昨天修过支付'
  ].join('\n');
  const userLine = '请原样保留 USER-LINE-9f3a';
  const user = msg('u', 'user', [
    { type: 'text', text: `${appendixText}\n\n` },
    { type: 'text', text: userLine }
  ]);
  const tool = msg('t', 'tool', [
    { type: 'tool_result', toolCallId: 'c', name: 'bash', ok: true, content: STUB }
  ]);
  const summary = msg('sum', 'system', [{ type: 'text', text: 'rolled summary text that stays readable' }], {
    key: 'compact-summary'
  });
  const logText = '[working log — durable trail across compaction; full transcripts at the referenced paths]\nline one of the log';
  const logged = msg('u2', 'user', [
    { type: 'text', text: `${logText}\n\n` },
    { type: 'text', text: 'follow-up' }
  ]);

  const payload = assembleContextStack({
    sessionId: 's',
    systemPrompt: 'SYSTEM-PROMPT-FULL',
    tools: [{ name: 'bash', description: 'run the shell UNIQUE-TOOL-DESC', inputSchema: { type: 'object' } }],
    messages: [summary, user, tool],
    appendix: {
      messageId: 'u',
      text: appendixText,
      sections: [
        { id: 'core', title: '用户背景（语义 core）', text: '用户喜欢深色主题' },
        { id: 'workingFile', title: '工作日志 / 日文件', text: '昨天修过支付' }
      ]
    },
    budget: budgetShape(),
    dispositionById: { sum: 'keep', u: 'keep', t: 'keep' },
    pinnedIds: new Set(['u'])
  });

  assert.equal(payload.sessionId, 's');
  assert.deepEqual(payload.blocks.map((block) => block.kind), [
    'system',
    'tools',
    'summary',
    'memory',
    'memory',
    'working-log',
    'user',
    'tool-stub'
  ]);
  for (const block of payload.blocks) {
    assert.equal(typeof block.kind, 'string');
    assert.equal(typeof block.label, 'string');
    assert.equal(typeof block.text, 'string');
    assert.equal(typeof block.tokens, 'number');
    assert.equal(typeof block.chars, 'number');
    assert.equal(block.chars, block.text.length);
    assert.equal(typeof block.pinned, 'boolean');
    assert.ok(['keep', 'summarize', 'dropped'].includes(block.disposition));
  }
  assert.equal(payload.blocks[0].text, 'SYSTEM-PROMPT-FULL');
  assert.match(payload.blocks[1].text, /UNIQUE-TOOL-DESC/);
  assert.equal(payload.blocks.find((block) => block.kind === 'summary').text, 'rolled summary text that stays readable');
  assert.equal(payload.blocks.find((block) => block.kind === 'summary').pinned, false);
  assert.equal(payload.blocks.find((block) => block.text === '用户喜欢深色主题').kind, 'memory');
  assert.equal(payload.blocks.find((block) => block.kind === 'working-log').text, '昨天修过支付');
  assert.equal(payload.blocks.find((block) => block.kind === 'user').text, userLine);
  assert.equal(payload.blocks.find((block) => block.kind === 'user').pinned, true);
  assert.equal(payload.blocks.find((block) => block.kind === 'tool-stub').text, STUB);
  assert.ok(payload.blocks.find((block) => block.kind === 'tool-stub').tokens > 0);

  const loggedPayload = assembleContextStack({
    sessionId: 's',
    systemPrompt: 'sys',
    tools: [],
    messages: [logged],
    appendix: { messageId: 'u2', text: logText, workingLog: true },
    budget: budgetShape(),
    dispositionById: { u2: 'keep' },
    pinnedIds: new Set(['u2'])
  });
  assert.equal(loggedPayload.blocks.find((block) => block.kind === 'working-log').text, logText);
  assert.equal(loggedPayload.blocks.find((block) => block.kind === 'user').text, 'follow-up');
});

test('each message part kind keeps its own text [AC:play-context-stack#AC-3]', () => {
  const message = msg('mix', 'assistant', [
    { type: 'reasoning', text: 'thinking about the dump' },
    { type: 'text', text: 'assistant says hello' },
    { type: 'image', mimeType: 'image/png', assetId: 'asset-1', alt: 'a chart', sourceUrl: 'https://example.test/chart.png' },
    { type: 'tool_call', toolCallId: 'c1', name: 'bash', input: { command: 'echo hi' } },
    {
      type: 'surface_update',
      surfaceId: 'surf-1',
      catalogId: 'catalog-1',
      messages: [{ type: 'update' }]
    }
  ]);
  const system = msg('sysm', 'system', [{ type: 'text', text: 'a system note' }], { key: 'note' });
  const toolRole = msg('toolmsg', 'tool', [{ type: 'text', text: 'tool role text' }]);
  const sources = msg('src', 'system', [{ type: 'text', text: 'history lives at /tmp/log' }], {
    key: 'context-history-sources'
  });
  const bareImage = msg('img2', 'user', [{ type: 'image', mimeType: 'image/jpeg', assetId: 'asset-2' }]);
  const payload = assembleContextStack({
    sessionId: 's',
    systemPrompt: '',
    tools: [],
    messages: [system, message, toolRole, sources, bareImage],
    budget: budgetShape(),
    dispositionById: { mix: 'keep', sysm: 'keep', toolmsg: 'keep', src: 'keep', img2: 'keep' },
    pinnedIds: new Set()
  });
  const byKind = Object.fromEntries(payload.blocks.map((block) => [block.kind + ':' + block.id, block]));
  assert.equal(payload.blocks.find((block) => block.kind === 'reasoning').text, 'thinking about the dump');
  assert.equal(payload.blocks.find((block) => block.kind === 'assistant').text, 'assistant says hello');
  const image = payload.blocks.find((block) => block.kind === 'image' && block.text.includes('asset-1'));
  assert.match(image.text, /a chart/);
  assert.match(image.text, /https:\/\/example.test\/chart.png/);
  assert.equal(image.tokens, 1200);
  const bare = payload.blocks.find((block) => block.kind === 'image' && block.text.includes('asset-2'));
  assert.equal(bare.text.includes('http'), false);
  const call = payload.blocks.find((block) => block.kind === 'tool-call');
  assert.match(call.text, /echo hi/);
  assert.equal(call.label, 'bash');
  const surface = payload.blocks.find((block) => block.kind === 'surface');
  assert.match(surface.text, /surf-1/);
  assert.equal(payload.blocks.find((block) => block.kind === 'system-message').text, 'a system note');
  assert.equal(payload.blocks.find((block) => block.id.startsWith('toolmsg')).text, 'tool role text');
  assert.equal(payload.blocks.find((block) => block.kind === 'history-sources').text, 'history lives at /tmp/log');
  assert.equal(payload.blocks.some((block) => block.kind === 'system'), false);
  assert.equal(payload.blocks.some((block) => block.kind === 'tools'), false);
  void byKind;
});

test('ordinary 20% cap marks summarize or drop; bot 50/85 keeps the text [AC:play-context-stack#AC-4]', () => {
  const oldHuge = msg('old', 'user', [{ type: 'text', text: 'H'.repeat(60000) }]);
  const latest = msg('latest', 'user', [{ type: 'text', text: 'latest line' }]);
  const normal = describeContextBudget({
    mode: 'normal',
    systemPrompt: 's',
    tools: [],
    messages: [oldHuge, latest],
    maxContextTokens: 20000
  });
  assert.equal(normal.budget.mode, 'normal');
  assert.equal(normal.budget.ratio, 0.2);
  assert.equal(normal.budget.capTokens, 4000);
  assert.equal(normal.budget.windowTokens, 20000);
  assert.equal(normal.budget.wouldSummarize, true);
  assert.equal(normal.dispositionById.old, 'summarize');
  assert.equal(normal.dispositionById.latest, 'keep');
  assert.ok(normal.pinnedIds.includes('latest'));
  assert.equal(normal.pinnedIds.includes('old'), false);

  const call = msg('call', 'assistant', [
    { type: 'tool_call', toolCallId: 'c1', name: 'bash', input: { command: 'echo hi' } }
  ]);
  const dumped = 'DUMP-'.repeat(2000);
  const result = msg('result', 'tool', [
    { type: 'tool_result', toolCallId: 'c1', name: 'bash', ok: true, content: dumped }
  ]);
  const done = msg('done', 'assistant', [{ type: 'text', text: 'done' }]);
  const start = msg('start', 'user', [{ type: 'text', text: 'start' }]);
  const dropped = describeContextBudget({
    mode: 'normal',
    systemPrompt: 's',
    tools: [],
    messages: [start, call, result, done, latest],
    maxContextTokens: 2000
  });
  assert.equal(dropped.budget.capTokens, 400);
  assert.equal(dropped.dispositionById.result, 'dropped');
  assert.equal(dropped.dispositionById.latest, 'keep');
  const droppedPayload = assembleContextStack({
    sessionId: 's',
    systemPrompt: dropped.systemPrompt,
    tools: [],
    messages: [start, call, result, done, latest],
    budget: dropped.budget,
    dispositionById: dropped.dispositionById,
    pinnedIds: new Set(dropped.pinnedIds)
  });
  assert.equal(droppedPayload.blocks.find((block) => block.kind === 'tool-result').text, dumped);

  const bot = describeContextBudget({
    mode: 'canonical-bot',
    systemPrompt: 's',
    tools: [],
    messages: [oldHuge, latest],
    maxContextTokens: 20000,
    botWindow: {
      contextTokens: 20000,
      historyTokens: 8000,
      structuredTokens: 10000,
      hygieneTokens: 17000
    }
  });
  assert.equal(bot.budget.mode, 'canonical-bot');
  assert.equal(bot.budget.ratio, null);
  assert.equal(bot.budget.structuredTokens, 10000);
  assert.equal(bot.budget.hygieneTokens, 17000);
  assert.equal(bot.budget.historyTokens, 8000);
  assert.equal(bot.budget.wouldCompact, true);
  assert.equal(bot.dispositionById.old, 'keep');
  assert.equal(bot.dispositionById.latest, 'keep');
});

test('preview uses the real prompt and does not rewrite stored tool output [AC:play-context-stack#AC-3] [AC:play-context-stack#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-stack-'));
  const store = new SqliteStateStore(join(dir, 'state.sqlite'));
  const saved = {
    RAW_AGENT_MICRO_COMPACT: process.env.RAW_AGENT_MICRO_COMPACT,
    RAW_AGENT_MODEL_CONTEXT_TOKENS: process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS,
    RAW_AGENT_AGENTS_SKILLS: process.env.RAW_AGENT_AGENTS_SKILLS
  };
  process.env.RAW_AGENT_MICRO_COMPACT = '1';
  process.env.RAW_AGENT_MODEL_CONTEXT_TOKENS = '20000';
  process.env.RAW_AGENT_AGENTS_SKILLS = '0';
  try {
    const agent = { id: 'general', name: 'General', role: 'assistant', instructions: 'Be brief.', capabilities: [] };
    store.upsertAgent(agent);
    writeCompactSettings(store, { policy: 'after_text_assistant' });
    const session = store.createSession({ title: 'stack', mode: 'chat', agentId: 'general' });
    const longDump = `MODEL_VIEW_BASH_MARKER-${'x'.repeat(180)}`;
    store.appendMessage(session.id, 'user', [{ type: 'text', text: 'run long bash dump' }]);
    store.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: 'c-bash', name: 'bash', input: { command: 'node -e "console.log(1)"' } }
    ]);
    store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'c-bash', name: 'bash', ok: true, content: longDump }
    ]);
    store.appendMessage(session.id, 'assistant', [{ type: 'text', text: 'done looking at the dump' }]);
    store.appendMessage(session.id, 'user', [{ type: 'text', text: '请原样保留 USER-LINE-9f3a' }]);
    const prompt = new PromptBuilder({ store, repoRoot: dir, stateDir: dir });
    const adapter = { name: 'idle', contextWindow: 20000 };
    const tools = [{
      name: 'bash',
      description: 'run the shell UNIQUE-TOOL-DESC',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      isExternal: false
    }];
    const payload = await previewSessionContextStack({
      store,
      repoRoot: dir,
      stateDir: dir,
      tools,
      promptBuilder: prompt,
      modelAdapter: adapter,
      env: process.env
    }, session.id);

    assert.equal(payload.sessionId, session.id);
    assert.equal(payload.budget.mode, 'normal');
    assert.equal(payload.budget.ratio, 0.2);
    assert.equal(payload.budget.capTokens, 4000);
    assert.equal(payload.budget.structuredTokens, null);
    const system = payload.blocks.find((block) => block.kind === 'system');
    assert.match(system.text, /General/);
    assert.match(system.text, /Be brief/);
    const user = payload.blocks.find((block) => block.kind === 'user' && block.text.includes('USER-LINE-9f3a'));
    assert.equal(user.text, '请原样保留 USER-LINE-9f3a');
    const stub = payload.blocks.find((block) => block.kind === 'tool-stub');
    assert.ok(stub, 'prepared view should stub the consumed tool result');
    assert.match(stub.text, /omitted to save space/);
    assert.equal(stub.text.includes('MODEL_VIEW_BASH_MARKER'), false);
    assert.match(payload.blocks.find((block) => block.kind === 'tools').text, /UNIQUE-TOOL-DESC/);
    const stored = store.listMessages(session.id).find((message) => message.parts.some((part) => part.type === 'tool_result'));
    assert.equal(stored.parts[0].content, longDump);

    const bot = store.createSession({
      title: 'bot-stack',
      mode: 'chat',
      agentId: 'general',
      metadata: { canonicalBotChat: true }
    });
    store.appendMessage(bot.id, 'user', [{ type: 'text', text: 'bot hello' }]);
    const botPayload = await previewSessionContextStack({
      store,
      repoRoot: dir,
      stateDir: dir,
      tools,
      promptBuilder: prompt,
      modelAdapter: adapter,
      env: process.env
    }, bot.id);
    assert.equal(botPayload.budget.mode, 'canonical-bot');
    assert.equal(botPayload.budget.ratio, null);
    assert.equal(botPayload.budget.structuredTokens, 10000);
    assert.equal(botPayload.budget.hygieneTokens, 17000);
    assert.equal(botPayload.blocks.find((block) => block.kind === 'user').text, 'bot hello');
    assert.ok(botPayload.blocks.every((block) => block.disposition === 'keep'));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
