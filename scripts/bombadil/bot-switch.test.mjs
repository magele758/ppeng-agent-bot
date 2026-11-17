import assert from 'node:assert/strict';
import test from 'node:test';
import { botNames, historyMarker, sendMarker, transcriptIsIsolated, verifyDelivery } from './scenario.mjs';

test('检查两个方向的历史和迟到消息归属 [AC:bombadil-bot-stability#AC-1]', () => {
  for (const name of botNames) {
    const other = botNames.find(candidate => candidate !== name);
    const clean = historyMarker(name) + sendMarker(name);
    assert.equal(transcriptIsIsolated(name, clean), true);
    assert.equal(transcriptIsIsolated(name, clean + sendMarker(other)), false);
    assert.equal(transcriptIsIsolated(name, historyMarker(other)), false);
  }
});

const user = text => ({ role: 'user', parts: [{ type: 'text', text }] });
test('校验实际投递，空跑、只测一个 Bot 和错投均失败 [AC:bombadil-bot-stability#AC-2]', () => {
  const [a, b] = botNames;
  const own = name => [user(historyMarker(name)), user(sendMarker(name))];
  assert.deepEqual(verifyDelivery(a, own(a)), { name: a, delivered: 1 });
  assert.deepEqual(verifyDelivery(b, own(b)), { name: b, delivered: 1 });
  assert.throws(() => verifyDelivery(b, []), /coverage/i);
  assert.throws(() => verifyDelivery(b, [user(historyMarker(b)), { ...user(sendMarker(b)), role: 'assistant' }]), /coverage/i);
  assert.throws(() => verifyDelivery(a, [...own(a), user(sendMarker(b))]), /wrong bot/i);
});

test('报告探索动作并只接受指定串线违规作为校准证据 [AC:bombadil-bot-stability#AC-1]', async () => {
  const { summarizeTrace, canaryDetected } = await import('./trace.mjs');
  const lines = [
    { action: { Custom: { name: 'selectBot' } }, violations: [] },
    { action: 'Reload', violations: [] },
    { action: { Custom: { name: 'sendProbe' } }, violations: [] },
    { action: null, violations: [{ name: 'transcriptOwnership' }] }
  ].map(row => JSON.stringify(row));
  const summary = await summarizeTrace(lines);
  assert.deepEqual(summary, { states: 4, selections: 1, sends: 1, reloads: 1, violations: ['transcriptOwnership'] });
  assert.equal(canaryDetected(2, summary), true);
  assert.equal(canaryDetected(1, summary), false);
  const unrelated = await summarizeTrace([JSON.stringify({ violations: [{ name: 'other' }] })]);
  assert.equal(canaryDetected(2, unrelated), false);
});
