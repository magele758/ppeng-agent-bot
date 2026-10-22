import assert from 'node:assert/strict';
import test from 'node:test';
import { lastCompletedTurn } from '../lib/composer-next-hint.ts';

function msg(role: 'user' | 'assistant', text: string) {
  return { role, parts: [{ type: 'text', text }] };
}

test('uses the latest user turn that already has a reply', () => {
  assert.deepEqual(
    lastCompletedTurn([
      msg('user', '先看登录'),
      msg('assistant', '登录页在 auth 目录'),
      msg('user', '再看会话列表'),
      msg('assistant', '会话列表在 sessions 页')
    ]),
    { userText: '再看会话列表', assistantText: '会话列表在 sessions 页' }
  );
});

test('ignores a user draft that has not been answered yet', () => {
  assert.deepEqual(
    lastCompletedTurn([
      msg('user', '先看登录'),
      msg('assistant', '登录页在 auth 目录'),
      msg('user', '正在输入但还没回复')
    ]),
    { userText: '先看登录', assistantText: '登录页在 auth 目录' }
  );
});

test('returns null before any completed turn', () => {
  assert.equal(lastCompletedTurn([msg('user', '你好')]), null);
  assert.equal(lastCompletedTurn([]), null);
});
