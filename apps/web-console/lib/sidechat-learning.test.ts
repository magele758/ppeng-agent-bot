import assert from 'node:assert/strict';
import test from 'node:test';
import type { SidechatThread } from '@ppeng/api-types';
import { appendCitation, filterThreads, nextTitle, sortThreads, threadsForQuote } from './sidechat-learning.ts';

function thread(id: string, patch: Partial<SidechatThread> = {}): SidechatThread {
  return {
    id,
    sessionId: 's',
    messageId: patch.messageId ?? id,
    agentId: 'general',
    ordinal: patch.ordinal ?? 1,
    title: patch.title ?? id,
    anchor: patch.anchor ?? { kind: 'range', quote: id, start: 0, end: 1 },
    status: 'complete',
    grasp: patch.grasp ?? 'thinking',
    note: patch.note ?? '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z'
  };
}

test('引用接在已有草稿后面，空草稿只放结论 [AC:sidechat-learning#AC-5]', () => {
  const block = appendCitation('已有草稿', '【旁注「缓存」参考结论】', '键值可以复用');
  assert.match(block, /^已有草稿\n\n> 【旁注「缓存」参考结论】/);
  assert.match(block, /> 键值可以复用/);
  assert.equal(appendCitation('  ', '【旁注「缓存」参考结论】', '一句').startsWith('> 【旁注「缓存」参考结论】'), true);
});

test('引用保留长回答尾部并使用当前语言的标题 [AC:sidechat-learning#AC-5]', () => {
  const answer = 'Long explanation. '.repeat(80) + '\nFinal caveat 🧠';
  const result = appendCitation('My draft', 'Annotation “Cache” reference', answer);
  assert.equal(result, 'My draft\n\n> Annotation “Cache” reference\n> ' + answer.replaceAll('\n', '\n> ') + '\n\n');
});

test('列表按掌握、一句话和原文顺序筛选 [AC:sidechat-learning#AC-3]', () => {
  const early = thread('early', {
    messageId: 'm1',
    ordinal: 2,
    updatedAt: '2026-02-01T00:00:00.000Z',
    anchor: { kind: 'range', quote: '后句', start: 4, end: 6 },
    grasp: 'mastered'
  });
  const late = thread('late', {
    messageId: 'm2',
    ordinal: 1,
    updatedAt: '2026-03-01T00:00:00.000Z',
    anchor: { kind: 'range', quote: '前句', start: 0, end: 2 },
    note: '一句话'
  });
  assert.deepEqual(filterThreads([early, late], 'mastered').map((item) => item.id), ['early']);
  assert.deepEqual(filterThreads([early, late], 'noted').map((item) => item.id), ['late']);
  assert.deepEqual(filterThreads([early, late], 'thinking').map((item) => item.id), ['late']);
  assert.deepEqual(
    sortThreads([early, late], 'source', ['m2', 'm1']).map((item) => item.id),
    ['late', 'early']
  );
  assert.deepEqual(sortThreads([early, late], 'recent', ['m2', 'm1']).map((item) => item.id), ['late', 'early']);
  assert.deepEqual(threadsForQuote([early, late], 'm1', '后句').map((item) => item.id), ['early']);
  assert.equal(nextTitle('  新标题  ', '旧标题'), '新标题');
  assert.equal(nextTitle(null, '旧标题'), '');
  assert.equal(nextTitle('旧标题', '旧标题'), '');
});
