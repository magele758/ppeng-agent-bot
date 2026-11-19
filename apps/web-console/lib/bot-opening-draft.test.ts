import assert from 'node:assert/strict';
import test from 'node:test';
import { composerDraftSpot, createComposerDraftScope, emptyComposerDraft, type ComposerDraftSpot } from './composer-draft.ts';

const opening = (openingBotId: string) => composerDraftSpot({surface:'bot',sessionId:null,botId:'',openingBotId});
const bound = (botId: string) => composerDraftSpot({surface:'bot',sessionId:'session-'+botId,botId,openingBotId:''});
const chat = composerDraftSpot({surface:'chat',sessionId:null,botId:'',openingBotId:''});

function composer(first: ComposerDraftSpot) {
  const scope = createComposerDraftScope(first);
  let live = emptyComposerDraft();
  return {
    type(text: string, attachmentIds: string[] = []) { live = {...emptyComposerDraft(),text, attachmentIds}; },
    move(to: ComposerDraftSpot, claimed = false) {
      scope.move(to,{claimed},{read:() => live, apply:draft => {live=draft;}, leave() {}});
      return live;
    },
  };
}

test('private text and attachments typed for a pending Bot stay with that Bot across manual navigation [AC:composer-draft-per-session#AC-1] [AC:lab-performance-regression-gate#AC-4]', () => {
  const ui = composer(opening('first'));
  ui.type('Unsent for first', ['attachment-for-first']);
  assert.deepEqual(ui.move(bound('second')), emptyComposerDraft());
  assert.deepEqual(ui.move(chat), emptyComposerDraft());
  assert.deepEqual(ui.move(opening('second')), emptyComposerDraft(), 'second Bot is still opening');
  assert.deepEqual(ui.move(bound('second'), true), emptyComposerDraft());
  assert.deepEqual(ui.move(bound('first')), {...emptyComposerDraft(),text:'Unsent for first',attachmentIds:['attachment-for-first']});
  assert.deepEqual(ui.move(bound('second')), emptyComposerDraft());
});

test('a fallback Bot cannot claim a known Bot’s opening draft, and its own established draft takes precedence [AC:composer-draft-per-session#AC-2] [AC:lab-performance-regression-gate#AC-4]', () => {
  const ui = composer(bound('first'));
  ui.type('Already saved for first');
  ui.move(chat);
  ui.move(opening('first'));
  ui.type('Newer pending draft');
  assert.deepEqual(ui.move(bound('fallback'), true), emptyComposerDraft());
  assert.equal(ui.move(bound('first')).text, 'Already saved for first');
  ui.type('');
  ui.move(chat);
  assert.deepEqual(ui.move(bound('first')), emptyComposerDraft(), 'a superseded pending draft was consumed');
});
