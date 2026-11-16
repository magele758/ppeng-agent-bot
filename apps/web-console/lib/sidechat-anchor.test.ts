import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteAnchor, resolveQuoteAnchor } from './sidechat-anchor.ts';

test('重访第二处同词、原文前插后用相邻文字重定位 [AC:sidechat#AC-4]', () => {
  const text = '上次讨论了 KV cache。今天再谈 KV cache 的显存。';
  const start = text.lastIndexOf('KV cache');
  const anchor = createQuoteAnchor(text, start, start + 8);
  assert.deepEqual(resolveQuoteAnchor(text, anchor), [start, start + 8]);
  assert.deepEqual(resolveQuoteAnchor('新增。' + text, anchor), [start + 3, start + 11]);
});

test('多处不确定或选词删除时降级到来源回答 [AC:sidechat#AC-4]', () => {
  const anchor = createQuoteAnchor('以前的例子：缓存。', 6, 8);
  assert.equal(resolveQuoteAnchor('缓存价格和缓存时间', anchor), null);
  assert.equal(resolveQuoteAnchor('段落已重写', anchor), null);
  assert.equal(resolveQuoteAnchor('全文', { kind: 'message', quote: '全文' }), null);
});
