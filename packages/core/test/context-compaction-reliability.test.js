import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateNormalRequestTokens } from '../dist/session/normal-request-budget.js';
import { runAutoCompact } from '../dist/session/auto-compact.js';
import { applyNormalSessionRequestBudget } from '../dist/runtime/normal-request-guard.js';

const message = (seq, role, parts) => ({ id: `m${seq}`, sessionId: 's', seq, role, parts, createdAt: '2026-10-13T00:00:00Z' });
const text = (seq, role, text) => message(seq, role, [{ type: 'text', text }]);
function harness(messages, summary = '') {
  const replacements = [];
  const updates = [];
  return { replacements, updates, input: {
    session: { id: 's', summary }, agent: {}, tokenThreshold: 1, keepRecent: 2,
    store: { foldMessages: () => messages, appendReplacement: (_id, x) => replacements.push(x), updateSession: (_id, x) => updates.push(x) },
    summarize: async () => 'updated conclusion',
  } };
}

test('latest question survives a long sequence of tools [AC:context-reliability#AC-4]', async () => {
  const messages = [text(1, 'user', 'ONLY use staging')];
  for (let i = 0; i < 6; i++) {
    messages.push(message(i * 2 + 2, 'assistant', [{ type: 'tool_call', toolCallId: `t${i}`, name: 'bash', input: {} }]));
    messages.push(message(i * 2 + 3, 'tool', [{ type: 'tool_result', toolCallId: `t${i}`, name: 'bash', ok: true, content: 'small' }]));
  }
  const short = harness([text(1, 'user', 'latest question'), text(2, 'assistant', 'working')]);
  await runAutoCompact(short.input);
  assert.equal(short.replacements.length, 0, 'short history must not summarize latest question');
  const h = harness(messages);
  await runAutoCompact(h.input);
  assert.ok(h.replacements.every(r => r.startSeq > 1), 'latest user must not be replaced');
});

test('rolling summary is updated once [AC:context-reliability#AC-11]', async () => {
  const h = harness([text(1, 'user', 'old'), text(2, 'assistant', 'done'), text(3, 'user', 'next'), text(4, 'assistant', 'ok')], 'prior conclusion');
  h.input.capSummary = () => 'prior conclusion\nupdated conclusion';
  await runAutoCompact(h.input);
  assert.equal(h.updates[0].summary, 'prior conclusion\nupdated conclusion');
});

test('empty summary keeps the original history with a diagnostic [AC:context-reliability#AC-12]', async () => {
  const h = harness([text(1, 'user', 'old'), text(2, 'assistant', 'done'), text(3, 'user', 'next'), text(4, 'assistant', 'ok')]);
  h.input.summarize = async () => '   ';
  const result = await runAutoCompact(h.input);
  assert.equal(result.skippedReason, 'empty_summary');
  assert.equal(h.replacements.length, 0);
});

test('removed tool waves leave bounded original source navigation [AC:context-reliability#AC-5] [AC:context-reliability#AC-13]', async () => {
  const messages = [text(1, 'user', 'old'), message(2, 'assistant', [{ type: 'tool_call', toolCallId: 't', name: 'bash', input: {} }]), message(3, 'tool', [{ type: 'tool_result', toolCallId: 't', name: 'bash', ok: true, content: 'x'.repeat(10000) }]), text(4, 'user', 'continue')];
  const result = await applyNormalSessionRequestBudget({ systemPrompt: 'sys', tools: [], messages, sessionId: 's' }, { maxContextTokens: 4000 });
  const body = JSON.stringify(result.messages);
  assert.match(body, /history_(search|read)/);
  assert.match(body, /session_id/);
  assert.ok(body.length < 2000);
  assert.ok(body.includes('continue'));
  assert.ok(estimateNormalRequestTokens(result) <= 4000 * 0.2);
});

test('normal repeated compaction sends the updated summary only once [AC:context-reliability#AC-11]', async () => {
  const previous = { ...text(1, 'system', 'OLD_SUMMARY'), key: 'compact-summary' };
  const result = await applyNormalSessionRequestBudget({ systemPrompt: 'sys', tools: [], sessionId: 's', messages: [previous, text(2, 'user', 'old question'), text(3, 'assistant', 'x'.repeat(8000)), text(4, 'user', 'continue')] }, { maxContextTokens: 4000, session: { id: 's', summary: 'OLD_SUMMARY' }, summarize: async () => 'NEW_SUMMARY' });
  const body = JSON.stringify(result.messages);
  assert.equal(body.includes('OLD_SUMMARY'), false);
  assert.equal(result.messages.filter(m => m.key === 'compact-summary').length, 1);
});

test('source references survive a long summary within its limit [AC:context-reliability#AC-5]', async () => {
  const { boundedSourceSummary } = await import('../dist/session/context-sources.js');
  const source = text(2, 'user', 'historical evidence');
  const result = boundedSourceSummary('details '.repeat(1000), [source], 600);
  assert.ok(result.text.length <= 600);
  assert.match(result.text, /history_read\(\{"session_id":"s","seq":2\}\)\./);
  const tiny = boundedSourceSummary('details '.repeat(1000), [source], 30);
  assert.ok(tiny.text.length <= 30);
  assert.equal(tiny.text.includes('history_read'), false, 'omit whole navigation rather than an unusable fragment');
});

test('repeated persisted compaction replaces prior summaries in ordinary and Bot sessions [AC:context-reliability#AC-11] [AC:context-reliability#AC-4]', async t => {
  const { RawAgentRuntime } = await import('../dist/runtime.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const bot of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), 'rolling-summary-review-'));
    let round = 0;
    const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: {
      name: 'scripted', async runTurn() { return { stopReason: 'end', assistantParts: [] }; },
      async summarizeMessages() { return `SUMMARY_ROUND_${++round}`; }
    } });
    t.after(() => { runtime.store.db.close(); rmSync(dir, { recursive: true, force: true }); });
    runtime.emitTrace = async () => {};
    const session = runtime.store.createSession({ title: 'rolling', agentId: 'general', mode: 'chat', metadata: bot ? { canonicalBotChat: true, botId: 'review-bot' } : {} });
    runtime.store.appendMessage(session.id, 'system', [{ type: 'text', text: 'ORIGINAL_SYSTEM_POLICY' }]);
    for (let j = 0; j < 72; j++) runtime.store.appendMessage(session.id, j % 2 ? 'assistant' : 'user', [{ type: 'text', text: `completed ${j}` }]);
    const latest = runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'LATEST_QUESTION' }]);
    for (let i = 0; i < 3; i++) {
      const result = await runtime.compactCanonicalSession(session.id);
      if (i < 2) assert.ok(result.replaced);
      const folded = runtime.store.foldMessages(session.id);
      assert.equal(folded.filter(m => m.key === 'compact-summary').length, 1, `only the updated summary should remain, bot=${bot}, round=${i}`);
      assert.ok(folded.some(m => m.id === latest.id));
      assert.ok(JSON.stringify(folded).includes('ORIGINAL_SYSTEM_POLICY'));
      assert.ok(JSON.stringify(folded).includes(`SUMMARY_ROUND_${round}`));
      if (round > 1) assert.ok(!JSON.stringify(folded).includes(`SUMMARY_ROUND_${round - 1}`));
    }
  }
});
