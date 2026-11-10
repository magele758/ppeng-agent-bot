import test from 'node:test';
import assert from 'node:assert/strict';

const { PromptBuilder } = await import('../dist/model/prompt-builder.js');
const { OpenAICompatibleAdapter } = await import('../dist/model/model-adapters.js');

function message(id, role, text) {
  return { id, sessionId: 'followup', role, parts: [{ type: 'text', text }], createdAt: '2026-11-10T00:00:00.000Z' };
}

test('a follow-up request repeats the system message and the earlier conversation byte for byte [AC:bot-followup-cache-prefix#AC-1] [AC:bot-followup-cache-prefix#AC-2]', async () => {
  const savedAgents = process.env.RAW_AGENT_AGENTS_SKILLS;
  const savedFetch = globalThis.fetch;
  process.env.RAW_AGENT_AGENTS_SKILLS = '0';
  const wire = [];
  globalThis.fetch = async (_url, init) => {
    wire.push(JSON.parse(init.body).messages);
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  };
  try {
    const control = new Map();
    const session = { id: 'followup', mode: 'chat', todo: [], summary: '', metadata: { botId: 'bot-followup' } };
    const builder = new PromptBuilder({
      store: {
        getDaemonControl: (key) => control.get(key),
        setDaemonControl: (key, value) => control.set(key, value),
        listSessionMemory: () => [],
        getSession: () => session
      },
      repoRoot: '/nonexistent-repo-root-followup',
      extraSkills: [
        { id: 'sk-invoice', name: 'Invoice Ledger Audit', description: 'Audit invoice ledgers', content: 'body' },
        { id: 'sk-zebra', name: 'Zebra Migration Census', description: 'Count zebra migration', content: 'body' }
      ]
    });
    const agent = { id: 'general', name: 'Bot', role: 'assistant', instructions: 'Be helpful.', capabilities: [] };
    const adapter = new OpenAICompatibleAdapter({ apiKey: 'fixture', baseUrl: 'https://example.test/v1', model: 'fixture', useJsonMode: false });
    const send = async (messages) => {
      const parts = await builder.buildSystemPromptParts({ agent, session, repoRoot: '/nonexistent-repo-root-followup' }, messages);
      await adapter.runTurn({ agent, systemPrompt: parts.text, cacheStablePrefix: parts.stable, tools: [], messages, sessionId: session.id });
      return parts;
    };

    const history = [message('m1', 'user', 'hello'), message('m2', 'assistant', 'hi there')];
    const firstMessages = [...history, message('m3', 'user', 'audit the invoice ledger')];
    const first = await send(firstMessages);

    // The next request: a todo was written, a goal notice landed, and the user asked something else.
    session.todo = [{ id: 't1', content: 'count the herd', status: 'in_progress' }];
    const second = await send([
      ...firstMessages,
      message('m4', 'assistant', 'the ledger balances'),
      message('m5', 'system', '[goal update] ledger audit finished'),
      message('m6', 'user', 'now run the zebra migration census')
    ]);
    assert.notEqual(second.dynamic, first.dynamic, 'the per-turn context must differ for this test to mean anything');

    const [earlier, later] = wire;
    assert.deepEqual(later[0], earlier[0]);
    assert.equal(later[0].content.includes('count the herd'), false);
    assert.equal(later[0].content.includes('[goal update]'), false);
    // Everything ahead of the earlier request's own user message is the reusable prefix.
    const prefix = JSON.stringify(earlier.slice(0, 1 + history.length)).slice(0, -1);
    assert.equal(JSON.stringify(later).startsWith(prefix), true);
    assert.equal(later[3].content, 'audit the invoice ledger');
    const latest = later.at(-1).content;
    assert.equal(latest.startsWith('<runtime_context>\n'), true);
    assert.equal(latest.includes('count the herd'), true);
    assert.equal(latest.includes('[goal update] ledger audit finished'), true);
    assert.equal(latest.endsWith('now run the zebra migration census'), true);
    // Nothing is lost: the moved text is exactly the per-turn remainder of the system prompt.
    assert.equal(latest.includes(second.dynamic), true);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedAgents === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
    else process.env.RAW_AGENT_AGENTS_SKILLS = savedAgents;
  }
});
