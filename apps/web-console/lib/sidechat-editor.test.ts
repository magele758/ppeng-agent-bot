import test from 'node:test';
import assert from 'node:assert/strict';
import { SidechatDraftBook, draftAddress } from './sidechat-editor.ts';

const range = { kind: 'range' as const, quote: 'KV cache', start: 15, end: 23 };
const selection = { kind: 'draft' as const, anchor: range, messageId: 'm1' };

test('未发送批注可切换再返回，重复选词的两处、不同会话及已存讨论各自保留草稿 [AC:sidechat#AC-1]', () => {
  const book = new SidechatDraftBook();
  const first = draftAddress('s-a', selection);
  const restored = draftAddress('s-a', { ...selection, anchor: { ...range } });
  const anotherOccurrence = draftAddress('s-a', { ...selection, anchor: { ...range, start: 32, end: 40 } });
  const anotherSession = draftAddress('s-b', selection);
  const savedThread = draftAddress('s-a', { kind: 'thread', threadId: 'discussion-1' });
  book.edit(first, '为什么？');
  book.edit(savedThread, '继续之前的问题');
  assert.equal(book.text(restored), '为什么？');
  assert.equal(book.text(anotherOccurrence), '');
  assert.equal(book.text(anotherSession), '');
  assert.equal(book.text(savedThread), '继续之前的问题');
  assert.equal(book.begin(anotherOccurrence), null);
});

test('首问失败保留相同重试标识，响应返回时不会清除后来编辑的草稿 [AC:sidechat#AC-6]', () => {
  const book = new SidechatDraftBook();
  const key = draftAddress('s-a', selection);
  book.edit(key, ' 第一个问题 ');
  const request = book.begin(key)!;
  assert.equal(request.question, '第一个问题');
  assert.ok(request.requestId);
  assert.equal(book.begin(key), null);
  book.failed(key, request);
  assert.equal(book.text(key), ' 第一个问题 ');
  assert.deepEqual(book.begin(key), request);
  book.edit(key, '下一条问题');
  book.sent(key, request);
  assert.equal(book.text(key), '下一条问题');
  const next = book.begin(key)!;
  assert.notEqual(next.requestId, request.requestId);
  book.sent(key, next);
  assert.equal(book.text(key), '');
});

test('首次提交尚未返回时输入的追问随新建讨论保留 [AC:sidechat#AC-6]', () => {
  const book = new SidechatDraftBook();
  const draft = draftAddress('s-a', selection);
  const thread = draftAddress('s-a', { kind: 'thread', threadId: 'thread-new' });
  book.edit(draft, '首问');
  const request = book.begin(draft)!;
  book.edit(draft, '继续想问');
  book.sent(draft, request, thread);
  assert.equal(book.text(thread), '继续想问');
  assert.equal(book.text(draft), '');
});
