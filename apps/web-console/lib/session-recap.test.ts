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

const MODEL_LINE = '刚刚写完签名校验，过期测试还没补。';

test('回到会话时展示模型写成的一行最近进展，且不写入对话 [AC:session-recap#AC-1]', () => {
  const messages = session();
  const before = messages.length;
  const recap = buildSessionRecap(messages);
  assert.ok(recap);
  assert.equal(messages.length, before);
  assert.equal(messages.some((message) => message.role === 'recap'), false);
  assert.equal('text' in recap, false);

  const shown = presentSessionRecap({
    enabled: true,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: MODEL_LINE
  });
  assert.equal(shown.show, true);
  assert.equal(shown.text, MODEL_LINE);
  assert.equal(shown.text.startsWith('回顾：你在'), false);
  assert.equal(shown.text.includes('改了'), false);
  assert.equal(shown.text.includes('\n'), false);
  assert.ok(Array.from(shown.text).length <= SESSION_RECAP_MAX_CHARS);

  const waiting = presentSessionRecap({
    enabled: true,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: ''
  });
  assert.equal(waiting.show, true);
  assert.equal(waiting.text, '');
  assert.equal(waiting.markSeen, false);

  const long = presentSessionRecap({
    enabled: true,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: `进展${'细节'.repeat(500)}`
  });
  assert.ok(Array.from(long.text).length <= SESSION_RECAP_MAX_CHARS);
  assert.equal(long.text.includes('改了'), false);
  assert.equal(long.text.startsWith('回顾：你在'), false);
});

test('不满三轮、已经回顾过、正在打字或还在生成时不自动回顾 [AC:session-recap#AC-2]', () => {
  const recap = buildSessionRecap(session());
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
    seenAnchorId: null,
    line: MODEL_LINE
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
      seenAnchorId: null,
      line: MODEL_LINE
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
      seenAnchorId: null,
      line: MODEL_LINE
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
      seenAnchorId: recap.anchorId,
      line: MODEL_LINE
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
  const recap = buildSessionRecap(oneTurn);
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
    seenAnchorId: null,
    line: '它按过期时间淘汰。'
  });
  assert.equal(manual.show, true);
  assert.equal(manual.text, '它按过期时间淘汰。');
  assert.equal(manual.text.includes('解释这个函数'), false);
  assert.equal(recapCommandShouldSend('/recap', false), false);
  assert.equal(recapCommandShouldSend('  /回顾  ', false), false);
  assert.equal(recapCommandShouldSend('/RECAP', false), false);
  assert.equal(recapCommandShouldSend('/recap 一下', false), true);
  assert.equal(recapCommandShouldSend('/recap', true), true);
  assert.equal(recapCommandShouldSend('继续写测试', false), true);
  assert.equal(buildSessionRecap([]), null);
  assert.equal(
    presentSessionRecap({
      enabled: true,
      recap: null,
      armed: false,
      manual: true,
      generating: false,
      draft: '',
      seenAnchorId: null,
      line: '它按过期时间淘汰。'
    }).show,
    false
  );
});

test('关掉自动回顾后回来不出现，当场回顾仍可用，没保存过则默认开 [AC:session-recap#AC-4]', () => {
  const recap = buildSessionRecap(session());
  assert.ok(recap);
  const hidden = presentSessionRecap({
    enabled: false,
    recap,
    armed: true,
    manual: false,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: 'Expiration checks are in, and the tests are still open.'
  });
  assert.equal(hidden.show, false);
  const manual = presentSessionRecap({
    enabled: false,
    recap,
    armed: false,
    manual: true,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: 'Expiration checks are in, and the tests are still open.'
  });
  assert.equal(manual.text.startsWith('Recap:'), false);
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

test('关掉整段回顾后不出现，命令会发出去，自动选择还留着 [AC:session-recap#AC-5]', () => {
  const recap = buildSessionRecap(session());
  assert.ok(recap);
  const hidden = presentSessionRecap({
    active: false,
    enabled: true,
    recap,
    armed: true,
    manual: true,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: '刚刚写完签名校验，过期测试还没补。'
  });
  assert.equal(hidden.show, false);
  assert.equal(hidden.text, '');
  assert.equal(hidden.markSeen, false);
  assert.equal(recapCommandShouldSend('/recap', false, false), true);
  assert.equal(recapCommandShouldSend('  /回顾  ', false, false), true);
  assert.equal(recapCommandShouldSend('/recap', false, true), false);

  const manualStill = presentSessionRecap({
    active: true,
    enabled: false,
    recap,
    armed: false,
    manual: true,
    generating: false,
    draft: '',
    seenAnchorId: null,
    line: '刚刚写完签名校验，过期测试还没补。'
  });
  assert.equal(manualStill.show, true);
  assert.equal(manualStill.text, '刚刚写完签名校验，过期测试还没补。');
});
