import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SESSION_RECAP_AWAY_MS,
  SESSION_RECAP_MAX_CHARS,
  armAutomaticRecap,
  buildSessionRecap,
  parseActivityRecord,
  presentSessionRecap,
  recapCommandShouldSend,
  resolveLastActivityMs,
  resolveSeenAnchor,
  type RecapMessage
} from './session-recap.ts';

const AWAY = SESSION_RECAP_AWAY_MS;
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const OLD = new Date(NOW - AWAY - 1000).toISOString();

function user(text: string, id = ''): RecapMessage {
  return { id, role: 'user', createdAt: OLD, parts: [{ type: 'text', text }] };
}

function assistant(text: string, id: string, files: string[] = [], at = OLD): RecapMessage[] {
  const calls = files.map((path, index) => ({
    type: 'tool_call' as const,
    toolCallId: `${id}-f${index}`,
    name: index % 2 === 0 ? 'write_file' : 'edit_file',
    input: { path }
  }));
  return [
    {
      id,
      role: 'assistant',
      createdAt: at,
      parts: [...calls, { type: 'text', text }]
    }
  ];
}

function session(): RecapMessage[] {
  return [
    user('先看一下目录', 'u1'),
    ...assistant('目录里主要是 auth。', 'a1'),
    user('把 auth 模块迁到 JWT', 'u2'),
    ...assistant('中间件已经换成 JWT。', 'a2', ['src/auth/middleware.ts', 'src/auth/token.ts']),
    user('补上过期校验', 'u3'),
    ...assistant('签名校验写好了，过期测试还没补。', 'a3', ['src/auth/expiry.ts', 'src/auth/expiry.test.ts'])
  ];
}

test('回到会话时一行回顾写出在做什么、改过的文件和还缺什么，且不写入对话 [AC:session-recap#AC-1]', () => {
  const messages = session();
  const before = messages.length;
  const recap = buildSessionRecap(messages, 'zh');
  assert.ok(recap);
  assert.equal(messages.length, before);
  assert.equal(messages.some((message) => message.role === 'recap'), false);
  assert.match(recap.text, /^回顾：/);
  assert.match(recap.text, /补上过期校验/);
  assert.match(recap.text, /改了 4 个文件/);
  assert.match(recap.text, /过期测试还没补/);
  assert.ok(Array.from(recap.text).length <= SESSION_RECAP_MAX_CHARS);
  assert.equal(recap.text.includes('\n'), false);
  assert.deepEqual(recap.files, [
    'src/auth/middleware.ts',
    'src/auth/token.ts',
    'src/auth/expiry.ts',
    'src/auth/expiry.test.ts'
  ]);

  const huge = '过期测试还没补。' + '细节'.repeat(500);
  const long = buildSessionRecap(
    [user('迁移认证'), ...assistant(huge, 'a-long', ['src/' + 'p'.repeat(500) + '.ts'])],
    'zh'
  );
  assert.ok(long);
  assert.ok(Array.from(long.text).length <= SESSION_RECAP_MAX_CHARS);
  assert.match(long.text, /改了 1 个文件/);
});

test('不满三轮、已经回顾过、正在打字或还在生成时不自动回顾 [AC:session-recap#AC-2]', () => {
  const recap = buildSessionRecap(session(), 'zh');
  assert.ok(recap);
  const ready = {
    enabled: true,
    completedTurns: recap.completedTurns,
    seenAnchorId: null as string | null,
    anchorId: recap.anchorId,
    now: NOW,
    lastActivityMs: NOW - AWAY - 1000,
    awayStartedMs: NOW - AWAY - 1000,
    arriving: false
  };
  assert.equal(armAutomaticRecap(ready), true);
  assert.equal(armAutomaticRecap({ ...ready, completedTurns: 2 }), false);
  assert.equal(armAutomaticRecap({ ...ready, seenAnchorId: recap.anchorId }), false);
  assert.equal(armAutomaticRecap({ ...ready, lastActivityMs: NOW - 1000 }), false);
  assert.equal(armAutomaticRecap({ ...ready, awayStartedMs: NOW - 1000, arriving: false }), false);
  assert.equal(armAutomaticRecap({ ...ready, awayStartedMs: null, arriving: true }), true);

  const shown = presentSessionRecap({
    enabled: true,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null
  });
  assert.equal(shown.show, true);
  assert.equal(shown.markSeen, true);
  assert.equal(
    presentSessionRecap({
      enabled: true,
      recap,
      armed: true,
      manual: false,
      generating: false,
      draft: '还没发送',
      seenAnchorId: null
    }).show,
    false
  );
  assert.equal(
    presentSessionRecap({
      enabled: true,
      recap,
      armed: true,
      manual: false,
      generating: true,
      draft: '',
      seenAnchorId: null
    }).show,
    false
  );
  assert.equal(
    presentSessionRecap({
      enabled: true,
      recap,
      armed: false,
      manual: false,
      generating: false,
      draft: '',
      seenAnchorId: recap.anchorId
    }).show,
    false
  );
  assert.equal(armAutomaticRecap({ ...ready, seenAnchorId: recap.anchorId }), false);
  assert.equal(
    armAutomaticRecap({ ...ready, seenAnchorId: resolveSeenAnchor(recap.anchorId, null) }),
    false
  );
});

test('发送 /recap 或 /回顾会立刻回顾，并且不会把这句话发给助手 [AC:session-recap#AC-3]', () => {
  const oneTurn = [user('解释这个函数'), ...assistant('它按过期时间淘汰。', 'only')];
  const recap = buildSessionRecap(oneTurn, 'zh');
  assert.ok(recap);
  assert.equal(recap.completedTurns, 1);
  assert.equal(armAutomaticRecap({
    enabled: true,
    completedTurns: 1,
    seenAnchorId: null,
    anchorId: recap.anchorId,
    now: NOW,
    lastActivityMs: NOW - AWAY - 1,
    awayStartedMs: null,
    arriving: true
  }), false);

  const manual = presentSessionRecap({
    enabled: false,
    recap,
    armed: false,
    manual: true,
    generating: false,
    draft: '',
    seenAnchorId: null
  });
  assert.equal(manual.show, true);
  assert.match(manual.text, /解释这个函数/);
  assert.equal(recapCommandShouldSend('/recap', false), false);
  assert.equal(recapCommandShouldSend('  /回顾  ', false), false);
  assert.equal(recapCommandShouldSend('/RECAP', false), false);
  assert.equal(recapCommandShouldSend('/recap 一下', false), true);
  assert.equal(recapCommandShouldSend('/recap', true), true);
  assert.equal(recapCommandShouldSend('继续写测试', false), true);
  assert.equal(buildSessionRecap([], 'zh'), null);
  assert.equal(
    presentSessionRecap({
      enabled: true,
      recap: null,
      armed: false,
      manual: true,
      generating: false,
      draft: '',
      seenAnchorId: null
    }).show,
    false
  );
});

test('关掉自动回顾后回来不出现，当场回顾仍可用，没保存过则默认开 [AC:session-recap#AC-4]', () => {
  const recap = buildSessionRecap(session(), 'en');
  assert.ok(recap);
  assert.match(recap.text, /^Recap:/);
  assert.match(recap.text, /Edited 4 files/);
  const hidden = presentSessionRecap({
    enabled: false,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null
  });
  assert.equal(hidden.show, false);
  const manual = presentSessionRecap({
    enabled: false,
    recap,
    armed: false,
    manual: true,
    generating: false,
    draft: '',
    seenAnchorId: null
  });
  assert.equal(manual.show, true);
  assert.equal(
    armAutomaticRecap({
      enabled: false,
      completedTurns: 3,
      seenAnchorId: null,
      anchorId: recap.anchorId,
      now: NOW,
      lastActivityMs: NOW - AWAY - 1,
      awayStartedMs: null,
      arriving: true
    }),
    false
  );
  assert.equal(resolveLastActivityMs({ messageAt: OLD, sessionUpdatedAt: new Date(NOW).toISOString(), observedAt: NOW }), Date.parse(OLD));
  assert.equal(resolveLastActivityMs({ sessionUpdatedAt: OLD }), Date.parse(OLD));
  assert.equal(parseActivityRecord(JSON.stringify({ anchorId: 'a3', at: NOW - AWAY }), 'a3'), NOW - AWAY);
  assert.equal(parseActivityRecord(JSON.stringify({ anchorId: 'other', at: NOW }), 'a3'), null);
});
