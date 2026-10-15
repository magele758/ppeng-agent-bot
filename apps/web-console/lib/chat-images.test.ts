import test from 'node:test';
import assert from 'node:assert/strict';
import { messageHasStructuredParts, msgPartsToText } from './chat-utils.ts';
import {
  TOOL_OBSERVATION_CAPTION,
  chatImageSrc,
  describeChatBubble
} from './chat-images.ts';
import { play as zhPlay } from './i18n/messages/zh/play.ts';
import { play as enPlay } from './i18n/messages/en/play.ts';
import type { MessagePart } from './types.ts';

const SHOT_A = 'img_ec96d2a7caa546719d5df44edc5eb343';
const SHOT_B = 'img_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function observationParts(): MessagePart[] {
  return [
    { type: 'text', text: TOOL_OBSERVATION_CAPTION },
    { type: 'image', assetId: SHOT_A, mimeType: 'image/jpeg' },
    { type: 'image', assetId: SHOT_B, mimeType: 'image/jpeg', alt: 'second shot' }
  ];
}

test('tool observation screenshots are thumbnails, not asset id text [AC:tool-observation-thumbnails#AC-1]', () => {
  const parts = observationParts();
  const plan = describeChatBubble(parts);
  assert.deepEqual(plan, [
    'caption:tool-observation',
    `thumb:${SHOT_A}`,
    `thumb:${SHOT_B}`
  ]);
  const visible = msgPartsToText(parts);
  assert.equal(visible.includes('[image '), false);
  assert.equal(visible.includes(SHOT_A), false);
  assert.equal(visible.includes('image/jpeg'), false);
  assert.equal(plan.some((line) => line === `thumb:${SHOT_A}`), true);
  assert.equal(messageHasStructuredParts(parts), true);
  assert.equal(
    chatImageSrc('sess 1', SHOT_A),
    `/api/sessions/${encodeURIComponent('sess 1')}/images/${encodeURIComponent(SHOT_A)}`
  );
});

test('tool observation keeps a localized caption [AC:tool-observation-thumbnails#AC-2]', () => {
  assert.equal(describeChatBubble(observationParts())[0], 'caption:tool-observation');
  assert.ok(zhPlay.turns.toolObservation.includes('截图'));
  assert.match(enPlay.turns.toolObservation, /screenshot/i);
  assert.notEqual(zhPlay.turns.toolObservation, enPlay.turns.toolObservation);
  assert.equal(zhPlay.turns.toolObservation.includes(TOOL_OBSERVATION_CAPTION), false);
  assert.equal(enPlay.turns.toolObservation.includes('[image '), false);
  assert.ok(zhPlay.turns.enlargeImage.length > 0);
  assert.ok(enPlay.turns.enlargeImage.length > 0);
  assert.notEqual(zhPlay.turns.toolShotAlt, enPlay.turns.toolShotAlt);
});

test('plain user text stays text [AC:tool-observation-thumbnails#AC-3]', () => {
  const parts: MessagePart[] = [{ type: 'text', text: '请继续' }];
  assert.deepEqual(describeChatBubble(parts), ['text:请继续']);
  assert.equal(messageHasStructuredParts(parts), false);
  assert.equal(msgPartsToText(parts), '请继续');
});
