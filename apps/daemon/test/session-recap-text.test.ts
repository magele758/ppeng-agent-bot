import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readSessionRecapCache } from '../src/session-recap-text.ts';
import {
  SESSION_RECAP_MAX_CHARS,
  composeSessionRecap,
  type RecapSourceMessage
} from '../src/session-recap-text.ts';

function user(text: string, id: string): RecapSourceMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistant(text: string, id: string, files: string[] = []): RecapSourceMessage {
  const calls = files.map((path, index) => ({
    type: 'tool_call' as const,
    toolCallId: `${id}-f${index}`,
    name: 'edit_file',
    input: { path }
  }));
  return { id, role: 'assistant', parts: [...calls, { type: 'text', text }] };
}

function session(): RecapSourceMessage[] {
  return [
    user('ANCIENT_MARKER_ZX9 很早以前的目录', 'u1'),
    assistant('那时只看了目录。', 'a1', ['src/ancient.ts']),
    {
      id: 'tool-old',
      role: 'tool',
      parts: [{ type: 'tool_result', toolCallId: 'a1-f0', name: 'edit_file', ok: true, text: 'SECRET_TOOL_BODY_QQ' }]
    },
    user('列一下模块', 'u2'),
    assistant('主要是 auth。', 'a2'),
    user('先看一下目录', 'u3'),
    assistant('目录里主要是 auth。', 'a3'),
    user('把 auth 模块迁到 JWT', 'u4'),
    assistant('中间件已经换成 JWT。', 'a4', ['src/auth/middleware.ts']),
    user('补上过期校验', 'u5'),
    {
      id: 'a5',
      role: 'assistant',
      parts: [
        { type: 'tool_call', toolCallId: 'bad-1', name: 'write_file', input: { path: 'src/auth/bad.ts' } },
        { type: 'tool_call', toolCallId: 'ok-1', name: 'edit_file', input: { path: 'src/auth/expiry.ts' } },
        { type: 'text', text: '签名校验写好了，过期测试还没补。' }
      ]
    },
    {
      id: 'tool-bad',
      role: 'tool',
      parts: [{ type: 'tool_result', toolCallId: 'bad-1', name: 'write_file', ok: false }]
    }
  ];
}

test('回顾由模型根据最近几轮写成，失败时不拼用户原话 [AC:session-recap#AC-1]', async () => {
  const messages = session();
  let calls = 0;
  let seenUser = '';
  let jsonMode: boolean | undefined;
  const first = await composeSessionRecap({
    messages,
    locale: 'zh',
    completeText: async (request) => {
      calls += 1;
      seenUser = request.user;
      jsonMode = request.jsonMode;
      return '「刚刚写完签名校验，过期测试还没补。」';
    }
  });
  assert.equal(calls, 1);
  assert.equal(jsonMode, false);
  assert.match(seenUser, /补上过期校验/);
  assert.match(seenUser, /签名校验写好了/);
  assert.match(seenUser, /expiry\.ts/);
  assert.equal(seenUser.includes('ANCIENT_MARKER_ZX9'), false);
  assert.equal(seenUser.includes('ancient.ts'), false);
  assert.equal(seenUser.includes('SECRET_TOOL_BODY_QQ'), false);
  assert.equal(seenUser.includes('bad.ts'), false);
  assert.equal(first.anchorId, 'a5');
  assert.equal(first.text, '刚刚写完签名校验，过期测试还没补。');
  assert.equal(first.text?.startsWith('回顾：你在'), false);
  assert.equal(first.text?.includes('\n'), false);
  assert.ok(Array.from(first.text ?? '').length <= SESSION_RECAP_MAX_CHARS);

  const again = await composeSessionRecap({
    messages,
    locale: 'zh',
    cached: first.cache,
    completeText: async () => {
      calls += 1;
      return '不该再调用';
    }
  });
  assert.equal(calls, 1);
  assert.equal(again.text, first.text);

  const failed = await composeSessionRecap({
    messages,
    locale: 'zh',
    completeText: async () => {
      throw new Error('model down');
    }
  });
  assert.equal(failed.text, null);
  assert.equal(failed.cache, null);

  const empty = await composeSessionRecap({
    messages,
    locale: 'en',
    completeText: async () => '   \n'
  });
  assert.equal(empty.text, null);
  assert.equal(empty.cache, null);

  const long = await composeSessionRecap({
    messages,
    locale: 'zh',
    completeText: async () => `进展${'细节'.repeat(500)}`
  });
  assert.ok(long.text);
  assert.ok(Array.from(long.text).length <= SESSION_RECAP_MAX_CHARS);
  assert.equal(long.text.includes('改了'), false);
  assert.equal(long.text.startsWith('回顾：你在'), false);

  const policy = readFileSync(new URL('../src/access/policy.ts', import.meta.url), 'utf8');
  assert.match(policy, /\['POST \/api\/sessions\/:id\/recap', session\]/);
  const route = readFileSync(new URL('../src/routes/session-recap.ts', import.meta.url), 'utf8');
  assert.match(route, /composeSessionRecap/);
  assert.match(route, /foldMessages/);
});

test('回顾带写下日期，隔日不复用缓存，也不要求存当前时钟 [AC:conversation-date-clock#AC-7]', async () => {
  const clock = { nowMs: Date.parse('2026-10-26T16:30:00.000Z'), timezone: 'Asia/Shanghai' };
  const messages: RecapSourceMessage[] = [
    { id: 'u1', role: 'user', createdAt: '2026-10-20T01:14:00.000Z', parts: [{ type: 'text', text: '今天改了支付' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '支付改动已提交' }] }
  ];
  let seen = '';
  const first = await composeSessionRecap({
    messages,
    locale: 'zh',
    clock,
    completeText: async (request) => {
      seen = `${request.system}\n${request.user}`;
      return '10月20日改了支付，还没上线。';
    }
  });
  assert.match(seen, /2026-10-20/);
  assert.match(seen, /2026-10-27/);
  assert.equal(seen.includes('[conversation-clock]'), false);
  assert.equal(first.cache?.asOfDate, '2026-10-27');
  assert.equal(JSON.stringify(first.cache).includes('[conversation-clock]'), false);

  let calls = 0;
  const stale = await composeSessionRecap({
    messages,
    locale: 'zh',
    clock,
    cached: { anchorId: 'a1', locale: 'zh', text: '旧日回顾', asOfDate: '2026-10-20' },
    completeText: async () => {
      calls += 1;
      return '隔日重写';
    }
  });
  assert.equal(calls, 1);
  assert.equal(stale.text, '隔日重写');
  assert.equal(stale.cache?.asOfDate, '2026-10-27');

  const sameDay = await composeSessionRecap({
    messages,
    locale: 'zh',
    clock,
    cached: first.cache,
    completeText: async () => {
      calls += 1;
      return '不该再写';
    }
  });
  assert.equal(calls, 1);
  assert.equal(sameDay.text, first.text);

  assert.equal(readSessionRecapCache({ sessionRecap: { anchorId: 'a1', locale: 'zh', text: '旧缓存' } }), null);
});

test('一次模型调用同时给出回顾和下一步，缓存不再打第二次 [AC:recap-next-action#AC-1] [AC:recap-next-action#AC-2]', async () => {
  const messages: RecapSourceMessage[] = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: '紫藤花蜜怎么保存' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '要放在阴凉处' }] }
  ];
  let calls = 0;
  const first = await composeSessionRecap({
    messages,
    locale: 'zh',
    completeText: async () => {
      calls += 1;
      return '刚刚说到紫藤花蜜要放阴凉处，瓶身日期还没写\n把紫藤花蜜的开封日期写在瓶身';
    }
  });
  assert.equal(calls, 1);
  assert.equal(first.text, '刚刚说到紫藤花蜜要放阴凉处，瓶身日期还没写');
  assert.equal(first.hint, '把紫藤花蜜的开封日期写在瓶身');
  assert.equal(first.cache?.hint, first.hint);
  const again = await composeSessionRecap({
    messages,
    locale: 'zh',
    cached: first.cache,
    completeText: async () => {
      calls += 1;
      return '不该再调用';
    }
  });
  assert.equal(calls, 1);
  assert.equal(again.hint, first.hint);
  const emptyAction = await composeSessionRecap({
    messages,
    locale: 'en',
    completeText: async () => 'Left the honey in the shade.\n继续'
  });
  assert.equal(emptyAction.text, 'Left the honey in the shade.');
  assert.equal(emptyAction.hint, '');
});
