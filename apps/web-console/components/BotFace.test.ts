import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./BotFace.tsx', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function BotFace('));

test('BotFace runs both effects before the avatar return so hook order stays stable', () => {
  const moodEffect = body.indexOf('turnFinishHappyUntil(');
  const motionEffect = body.indexOf("matchMedia('(prefers-reduced-motion: reduce)')");
  const avatarReturn = body.indexOf('if (standIn)');
  assert.ok(moodEffect > 0 && motionEffect > moodEffect, 'both effects exist, mood effect first');
  assert.ok(avatarReturn > motionEffect, 'avatar return stays after every hook');
});

test('BotFace keeps the living face subscribed when an avatar is removed', () => {
  const motionEffect = body.lastIndexOf('useEffect(() => {', body.indexOf("matchMedia('(prefers-reduced-motion: reduce)')"));
  const subscribe = body.indexOf('return subscribeFace(', motionEffect);
  const end = body.indexOf('}, [showAvatar, mood, faceStyle]);', motionEffect);
  assert.ok(motionEffect > 0 && subscribe > motionEffect && end > subscribe);
  const effect = body.slice(motionEffect, end);
  assert.equal(effect.includes('if (!svg) return'), false);
  assert.match(effect, /if \(showAvatar \|\| faceStyle === 'soft' \|\| faceStyle === 'bloub'\) return/);
});
