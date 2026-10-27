import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  armComposerHint,
  COMPOSER_HINT_DELAY_MS,
  composerDraftFromTyping,
  composerHintAfterRecap,
  composerHintKey,
  composerHintPresentation,
  composerHintRequestBody,
  composerMessageToSend,
  isBotMainComposerSession,
  loadComposerHint,
  readComposerHintBody,
  shouldRequestComposerHint,
} from './composer-next-hint.ts';

const idle = '发消息给 Bot…';
const runningPlaceholder = '运行中：回车立即转向（下一枪生效）…';
const suggestion = '那紫藤花蜜呢';

function view(draft: string, hint: string, running = false) {
  return composerHintPresentation({
    draft,
    hint,
    idlePlaceholder: idle,
    running,
    runningPlaceholder,
  });
}

const ready = {
  surface: 'bot' as const,
  botMain: true,
  draft: '',
  generating: false,
  hasAssistantReply: true,
};

test('Bot 主对话空输入在助手回复后过一会儿才出现下一句建议，建议不是输入值 [AC:bot-composer-next-hint#AC-1]', async () => {
  let published = '';
  let run: (() => void) | undefined;
  const cancel = armComposerHint({
    delayMs: COMPOSER_HINT_DELAY_MS,
    schedule(fn, ms) {
      assert.ok(ms >= 300);
      run = fn;
      return () => {
        run = undefined;
      };
    },
    load: async () => suggestion,
    publish: (hint) => {
      published = hint;
    },
  });
  const before = view('', published);
  assert.equal(published, '');
  assert.equal(before.value, '');
  assert.equal(before.hintVisible, false);
  assert.equal(before.placeholder, idle);
  assert.ok(run);
  run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shown = view('', published);
  assert.equal(shown.value, '');
  assert.equal(shown.placeholder, suggestion);
  assert.equal(shown.hintVisible, true);
  assert.notEqual(shown.value, shown.placeholder);
  const hook = readFileSync(new URL('../components/usePlayComposerHint.ts', import.meta.url), 'utf8');
  assert.match(hook, /armComposerHint/);
  assert.match(hook, /COMPOSER_HINT_DELAY_MS/);
  assert.match(hook, /loadComposerHint/);
  cancel();
});

test('建议请求只带会话编号，半句草稿不会成为建议 [AC:bot-composer-next-hint#AC-2]', async () => {
  const half = '半句还没打完';
  let sent = '';
  const hint = await loadComposerHint('sess-bot', undefined, async (_url, init) => {
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify({ hint: suggestion }), { status: 200 });
  });
  assert.deepEqual(JSON.parse(sent), { sessionId: 'sess-bot' });
  assert.deepEqual(composerHintRequestBody('sess-bot'), { sessionId: 'sess-bot' });
  assert.equal(sent.includes(half), false);
  assert.equal(hint, suggestion);
  const shown = view(half, hint);
  assert.equal(shown.hintVisible, false);
  assert.equal(shown.value, half);
  assert.equal(shown.value.includes('紫藤'), false);
});

test('按 Tab 才把建议写进输入框，提示随后消失 [AC:bot-composer-next-hint#AC-3]', () => {
  const accepted = composerHintKey({ key: 'Tab', draft: '', hint: suggestion });
  assert.equal(accepted.accept, true);
  assert.equal(accepted.draft, suggestion);
  const after = view(accepted.draft, suggestion);
  assert.equal(after.value, suggestion);
  assert.equal(after.hintVisible, false);
  assert.equal(after.placeholder, idle);
  const shifted = composerHintKey({ key: 'Tab', draft: '', hint: suggestion, shiftKey: true });
  assert.equal(shifted.accept, false);
});

test('直接打字只留下用户的字，续写提示不会挂上 [AC:bot-composer-next-hint#AC-4]', () => {
  const typed = composerDraftFromTyping('我', suggestion);
  assert.equal(typed.draft, '我');
  assert.equal(typed.hintVisible, false);
  assert.equal(typed.draft.includes('紫藤'), false);
  const shown = view(typed.draft, suggestion);
  assert.equal(shown.value, '我');
  assert.equal(shown.placeholder, idle);
  assert.equal(shown.hintVisible, false);
  const key = composerHintKey({ key: 'a', draft: '', hint: suggestion });
  assert.equal(key.accept, false);
  assert.equal(key.draft, '');
  const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
  assert.equal(panel.includes('InputHint'), false);
  assert.match(panel, /composerHintPresentation/);
  assert.match(panel, /composerDraftFromTyping/);
  assert.match(panel, /composerHintKey/);
});

test('已有输入、正在回复或还没有助手回复时不出现下一句建议 [AC:bot-composer-next-hint#AC-5]', () => {
  assert.equal(shouldRequestComposerHint({ ...ready, draft: '已经打了字' }), false);
  assert.equal(shouldRequestComposerHint({ ...ready, generating: true }), false);
  assert.equal(shouldRequestComposerHint({ ...ready, hasAssistantReply: false }), false);
  assert.equal(shouldRequestComposerHint(ready), true);
  assert.equal(view('已经打了字', suggestion).hintVisible, false);
  const busy = view('', suggestion, true);
  assert.equal(busy.hintVisible, false);
  assert.equal(busy.placeholder, runningPlaceholder);
  assert.equal(busy.value, '');
});

test('普通聊天、房间和不是这只 Bot 主对话的会话不出现下一句建议 [AC:bot-composer-next-hint#AC-6]', () => {
  assert.equal(shouldRequestComposerHint({ ...ready, surface: 'chat' }), false);
  assert.equal(shouldRequestComposerHint({ ...ready, botMain: false }), false);
  assert.equal(shouldRequestComposerHint({ ...ready, groupOpen: true }), false);
  assert.equal(
    isBotMainComposerSession({ mode: 'chat', metadata: { canonicalBotChat: true, botId: 'b' } }),
    true
  );
  assert.equal(isBotMainComposerSession({ mode: 'chat', metadata: {} }), false);
  assert.equal(
    isBotMainComposerSession({
      mode: 'chat',
      metadata: { roomId: 'room-1', canonicalBotChat: true, botId: 'b' },
    }),
    false
  );
  assert.equal(
    isBotMainComposerSession({
      mode: 'subagent',
      parentSessionId: 'parent',
      metadata: { botId: 'b', canonicalBotChat: true },
    }),
    false
  );
  assert.equal(isBotMainComposerSession(null), false);
});

test('建议接口失败或没有完整一句时输入框仍可输入，不插入半截建议也不报错 [AC:bot-composer-next-hint#AC-7]', async () => {
  const failed = await loadComposerHint('sess', undefined, async () => {
    return new Response(JSON.stringify({ error: '挡住对话', hint: '{半截' }), { status: 500 });
  });
  const broken = await loadComposerHint('sess', undefined, async () => {
    throw new Error('network');
  });
  const fragment = readComposerHintBody(200, { hint: '{半截', error: '挡住对话' });
  assert.equal(failed, '');
  assert.equal(broken, '');
  assert.equal(fragment, '');
  assert.equal(readComposerHintBody(200, { error: '挡住对话' }), '');
  const still = view('', failed);
  assert.equal(still.value, '');
  assert.equal(still.hintVisible, false);
  assert.equal(still.placeholder, idle);
  const typed = composerDraftFromTyping('继续输入', '');
  assert.equal(typed.draft, '继续输入');
});

test('超过 80 字的模型行动指南仍显示，超过 500 字只留前 500 [AC:bot-composer-next-hint#AC-11]', () => {
  const mid = '核对紫藤花蜜放在阴凉处的保存时间'.repeat(6);
  assert.ok(Array.from(mid).length > 80 && Array.from(mid).length <= 500);
  assert.equal(readComposerHintBody(200, { hint: mid }), mid);
  const shown = readComposerHintBody(200, { hint: '核'.repeat(600) });
  assert.equal(shown, '核'.repeat(500));
  assert.equal(readComposerHintBody(200, { hint: '核对紫藤\n花蜜保存' }), '核对紫藤 花蜜保存');
});

test('没按 Tab 发出去的是用户真正输入的内容，空输入不会把建议发出去 [AC:bot-composer-next-hint#AC-8]', () => {
  const shown = view('', suggestion);
  assert.equal(shown.hintVisible, true);
  assert.equal(composerMessageToSend(shown.value), '');
  assert.notEqual(composerMessageToSend(shown.value), shown.placeholder);
  const typed = composerDraftFromTyping('我自己的字', suggestion);
  assert.equal(composerMessageToSend(typed.draft), '我自己的字');
  assert.equal(typed.draft.includes(suggestion), false);
  const chat = readFileSync(new URL('../components/usePlayChat.ts', import.meta.url), 'utf8');
  assert.match(chat, /composerMessageToSend\(playInput\)/);
});

test('回顾写成后才请求下一步，请求带上这行回顾 [AC:recap-next-action#AC-1] [AC:recap-next-action#AC-5]', async () => {
  assert.deepEqual(composerHintAfterRecap({ shown: true, status: 'loading', text: '' }), { wait: true, recap: '' });
  assert.equal(shouldRequestComposerHint({
    surface: 'bot', botMain: true, draft: '', generating: true, hasAssistantReply: true
  }), false);
  const done = composerHintAfterRecap({ shown: true, status: 'done', text: '瓶身日期还没写' });
  assert.deepEqual(done, { wait: false, recap: '瓶身日期还没写' });
  assert.deepEqual(composerHintRequestBody('sess-bot', done.recap), { sessionId: 'sess-bot', recap: '瓶身日期还没写' });
  assert.deepEqual(composerHintAfterRecap({ shown: false, status: 'hidden', text: '' }), { wait: false, recap: '' });
  assert.deepEqual(composerHintRequestBody('sess-bot'), { sessionId: 'sess-bot' });
  let sent = '';
  await loadComposerHint('sess-bot', undefined, async (_url, init) => {
    sent = String(init?.body ?? '');
    return new Response(JSON.stringify({ hint: '把开封日期写在瓶身' }), { status: 200 });
  }, done.recap);
  assert.deepEqual(JSON.parse(sent), { sessionId: 'sess-bot', recap: '瓶身日期还没写' });
});

test('回顾后的建议仍是提示，失败回顾不挡住输入 [AC:recap-next-action#AC-3] [AC:recap-next-action#AC-4]', () => {
  const hint = '把开封日期写在瓶身';
  const shown = composerHintPresentation({
    draft: '',
    hint,
    idlePlaceholder: idle,
    running: false,
    runningPlaceholder
  });
  assert.equal(shown.hintVisible, true);
  assert.equal(shown.value, '');
  assert.equal(composerMessageToSend(shown.value), '');
  const accepted = composerHintKey({ key: 'Tab', draft: '', hint });
  assert.equal(accepted.draft, hint);
  const typed = composerDraftFromTyping('我自己的字', hint);
  assert.equal(typed.draft, '我自己的字');
  assert.equal(typed.draft.includes(hint), false);
  assert.deepEqual(composerHintAfterRecap({ shown: true, status: 'failed', text: '这次没回顾成' }), { wait: false, recap: '' });
  assert.equal(composerHintRequestBody('sess-bot', '').recap, undefined);
});
