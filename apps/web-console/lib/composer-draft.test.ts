import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composerDraftKey,
  createComposerDraftScope,
  emptyComposerDraft,
  type ComposerDraft,
  type ComposerDraftIo,
  type ComposerDraftSpot
} from './composer-draft.ts';

function draft(text: string, extra: Partial<ComposerDraft> = {}): ComposerDraft {
  return { ...emptyComposerDraft(), text, ...extra };
}

/** Plays the role of the composer: one live draft on screen, plus a log of leave calls. */
function composer(first: ComposerDraftSpot) {
  let live = emptyComposerDraft();
  const events: string[] = [];
  const scope = createComposerDraftScope(first);
  const io: ComposerDraftIo = {
    read: () => live,
    apply: (next) => {
      events.push(`apply:${next.text}`);
      live = next;
    },
    leave: () => events.push('leave')
  };
  return {
    type: (text: string, extra: Partial<ComposerDraft> = {}) => {
      live = draft(text, extra);
    },
    send: () => {
      live = emptyComposerDraft();
    },
    go: (spot: ComposerDraftSpot, claimed = false) => scope.move(spot, { claimed }, io),
    shown: () => live,
    events
  };
}

const botA: ComposerDraftSpot = { key: composerDraftKey({ sessionId: 'sess-a', surface: 'bot', botId: 'bot-a' }), botId: 'bot-a' };
const botB: ComposerDraftSpot = { key: composerDraftKey({ sessionId: 'sess-b', surface: 'bot', botId: 'bot-b' }), botId: 'bot-b' };

test('switching to a bot without a draft shows an empty composer [AC:composer-draft-per-session#AC-1]', () => {
  const ui = composer(botA);
  ui.type('A 的半句话');
  ui.go(botB);
  assert.deepEqual(ui.shown(), emptyComposerDraft());
});

test('switching back restores text, attachments and context of each bot [AC:composer-draft-per-session#AC-2]', () => {
  const ui = composer(botA);
  const context = [{ id: 'c1', kind: 'file' as const, name: 'a.ts', text: 'x' }];
  ui.type('A 草稿', { imageAssetIds: ['img-a'], attachmentIds: ['att-a'], context });
  ui.go(botB);
  ui.type('B 草稿');
  ui.go(botA);
  assert.deepEqual(ui.shown(), draft('A 草稿', { imageAssetIds: ['img-a'], attachmentIds: ['att-a'], context }));
  ui.go(botB);
  assert.deepEqual(ui.shown(), draft('B 草稿'));
});

test('sending in A clears only A [AC:composer-draft-per-session#AC-3]', () => {
  const ui = composer(botA);
  ui.type('A 草稿');
  ui.go(botB);
  ui.type('B 草稿');
  ui.go(botA);
  ui.send();
  assert.equal(ui.shown().text, '');
  ui.go(botB);
  assert.equal(ui.shown().text, 'B 草稿');
  ui.go(botA);
  assert.equal(ui.shown().text, '');
});

test('session keys isolate chat sessions and new chats by surface and bot [AC:composer-draft-per-session#AC-1]', () => {
  assert.equal(
    composerDraftKey({ sessionId: 's1', surface: 'bot', botId: 'b1' }),
    composerDraftKey({ sessionId: 's1', surface: 'chat', botId: '' })
  );
  assert.notEqual(
    composerDraftKey({ sessionId: null, surface: 'bot', botId: 'b1' }),
    composerDraftKey({ sessionId: null, surface: 'bot', botId: 'b2' })
  );
  assert.notEqual(
    composerDraftKey({ sessionId: '', surface: 'chat', botId: '' }),
    composerDraftKey({ sessionId: 's1', surface: 'chat', botId: '' })
  );
});

test('text typed while a session is being created stays in the composer [AC:composer-draft-per-session#AC-4]', () => {
  const newChat: ComposerDraftSpot = { key: composerDraftKey({ sessionId: null, surface: 'chat', botId: '' }), botId: '' };
  const ui = composer(newChat);
  ui.send();
  ui.type('趁生成时打的字');
  ui.go({ key: composerDraftKey({ sessionId: 'new-sid', surface: 'chat', botId: '' }), botId: '' }, true);
  assert.equal(ui.shown().text, '趁生成时打的字');

  const opening: ComposerDraftSpot = { key: composerDraftKey({ sessionId: null, surface: 'bot', botId: 'bot-b' }), botId: 'bot-b' };
  const bot = composer(opening);
  bot.type('还在打开时打的字');
  bot.go(botB);
  assert.equal(bot.shown().text, '还在打开时打的字');
});

test('a new-chat draft does not follow the user into an existing session [AC:composer-draft-per-session#AC-1]', () => {
  const newChat: ComposerDraftSpot = { key: composerDraftKey({ sessionId: null, surface: 'chat', botId: '' }), botId: '' };
  const ui = composer(newChat);
  ui.type('新对话草稿');
  ui.go({ key: composerDraftKey({ sessionId: 'old', surface: 'chat', botId: '' }), botId: '' });
  assert.equal(ui.shown().text, '');
  ui.go(newChat);
  assert.equal(ui.shown().text, '新对话草稿');
});

test('leaving a session stops dictation before the next draft is shown [AC:composer-draft-per-session#AC-5]', () => {
  const ui = composer(botA);
  ui.type('A 语音已识别');
  ui.go(botB);
  assert.deepEqual(ui.events, ['leave', 'apply:']);
  ui.go(botA);
  assert.equal(ui.shown().text, 'A 语音已识别');
});

test('staying on the same session changes nothing', () => {
  const ui = composer(botA);
  ui.type('A');
  ui.go(botA);
  assert.deepEqual(ui.events, []);
  assert.equal(ui.shown().text, 'A');
});
