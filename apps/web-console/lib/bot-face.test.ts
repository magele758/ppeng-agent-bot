import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINK_CLOSE_MS,
  BLINK_SPAN_MS,
  BOT_FACE_COLORS,
  BOT_FACE_COUNT,
  POINTER_FRESH_MS,
  blinkOpenness,
  botFaceColor,
  botFaceIndex,
  damp,
  ellipsisScale,
  expressionForMood,
  faceGaze,
  nextIdleLook,
  resolveEyePose,
  resolveLivingFaceMood,
  speakingMouth,
  stepBlinkClock,
  toolScan,
  type BlinkClock
} from './bot-face.ts';

test('同一个名字始终对应同一张脸 [AC:bot-robot-faces#AC-1] [AC:bot-robot-faces#AC-2] [AC:bot-robot-faces#AC-3]', () => {
  assert.equal(BOT_FACE_COUNT, 8);
  assert.equal(botFaceIndex('Researcher'), 2);
  assert.equal(botFaceIndex('Researcher'), botFaceIndex('Researcher'));
  assert.equal(botFaceIndex('  Ada  '), 6);
  assert.equal(botFaceIndex('Ada'), 6);
  assert.equal(botFaceIndex('ada'), 4);
  assert.notEqual(botFaceIndex('Ada'), botFaceIndex('ada'));
  assert.equal(botFaceIndex('Beta'), 7);
  assert.equal(botFaceIndex('每日简报'), 2);
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo']) {
    const index = botFaceIndex(name);
    assert.equal(index, botFaceIndex(name));
    assert.ok(index !== null && index >= 0 && index < BOT_FACE_COUNT);
  }
  const used = new Set(
    ['Alpha', 'Beta', 'Gamma', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kay', 'Lima'].map(
      (name) => botFaceIndex(name)
    )
  );
  assert.ok(used.size > 1);
});

test('没有名字时使用占位脸 [AC:bot-robot-faces#AC-4]', () => {
  assert.equal(botFaceIndex(''), null);
  assert.equal(botFaceIndex('   '), null);
  assert.equal(botFaceIndex(null), null);
  assert.equal(botFaceIndex(undefined), null);
});

test('名字映射到稳定且彼此不同的脸颜色', () => {
  assert.deepEqual(BOT_FACE_COLORS, ['blue', 'white', 'orange', 'red', 'purple']);
  assert.equal(botFaceColor('DeskBot'), 'purple');
  assert.equal(botFaceColor('Super Bot'), 'red');
  assert.equal(botFaceColor('小八'), 'blue');
  assert.equal(botFaceColor('  DeskBot  '), botFaceColor('DeskBot'));
  assert.equal(botFaceColor('DeskBot'), botFaceColor('DeskBot'));
  assert.notEqual(botFaceColor('DeskBot'), botFaceColor('Super Bot'));
  assert.notEqual(botFaceColor('Super Bot'), botFaceColor('小八'));
  assert.notEqual(botFaceColor('小八'), botFaceColor('DeskBot'));
  for (const name of ['DeskBot', 'Super Bot', '小八', 'Ada', '每日简报']) {
    const color = botFaceColor(name);
    assert.ok(color && BOT_FACE_COLORS.includes(color));
  }
  assert.equal(botFaceColor(''), null);
  assert.equal(botFaceColor('   '), null);
  assert.equal(botFaceColor(null), null);
  assert.equal(botFaceColor(undefined), null);
});

test('对话状态按最新片段切换', () => {
  assert.equal(resolveLivingFaceMood({ live: false, segments: [{ kind: 'tool' }] }), 'idle');
  assert.equal(resolveLivingFaceMood({ live: true }), 'thinking');
  assert.equal(resolveLivingFaceMood({ live: true, segments: [] }), 'thinking');
  assert.equal(resolveLivingFaceMood({ live: true, segments: [{ kind: 'reasoning' }] }), 'thinking');
  assert.equal(resolveLivingFaceMood({ live: true, segments: [{ kind: 'text' }] }), 'speaking');
  assert.equal(resolveLivingFaceMood({ live: true, segments: [{ kind: 'tool' }] }), 'tool');
  assert.equal(
    resolveLivingFaceMood({ live: true, segments: [{ kind: 'reasoning' }, { kind: 'text' }] }),
    'speaking'
  );
  assert.equal(
    resolveLivingFaceMood({ live: true, segments: [{ kind: 'text' }, { kind: 'tool' }] }),
    'tool'
  );
  assert.equal(
    resolveLivingFaceMood({ live: true, segments: [{ kind: 'tool' }, { kind: 'a2ui' }] }),
    'tool'
  );
  assert.equal(resolveLivingFaceMood({ live: true, segments: [{ kind: 'a2ui' }] }), 'thinking');
  assert.equal(expressionForMood('idle'), 'rest');
  assert.equal(expressionForMood('thinking'), 'ellipsis');
  assert.equal(expressionForMood('speaking'), 'talk');
  assert.equal(expressionForMood('tool'), 'scan');
});

test('眨眼从张开到闭合再张开，并可以连眨一次', () => {
  const resting: BlinkClock = { nextAtMs: 1000, startedAtMs: null, followAtMs: null };
  const waiting = stepBlinkClock(resting, 500, 0.5);
  assert.equal(waiting.open, 1);
  assert.equal(waiting.clock.startedAtMs, null);
  assert.deepEqual(resting, { nextAtMs: 1000, startedAtMs: null, followAtMs: null });

  const gap = 2100 + 0.5 * 2700;
  const started = stepBlinkClock(resting, 1000, 0.5);
  assert.equal(started.open, 1);
  assert.equal(started.clock.startedAtMs, 1000);
  assert.equal(started.clock.followAtMs, null);
  assert.equal(started.clock.nextAtMs, 1000 + BLINK_SPAN_MS + gap);

  const shut = stepBlinkClock(started.clock, 1000 + BLINK_CLOSE_MS, 0.5);
  assert.equal(shut.open, 0.14);
  assert.equal(shut.clock.startedAtMs, 1000);
  assert.ok(blinkOpenness(1000 + BLINK_CLOSE_MS / 2, 1000) < 1);
  assert.ok(blinkOpenness(1000 + BLINK_CLOSE_MS / 2, 1000) > 0.14);

  const done = stepBlinkClock(started.clock, 1000 + BLINK_SPAN_MS, 0.5);
  assert.equal(done.open, 1);
  assert.equal(done.clock.startedAtMs, null);
  assert.equal(done.clock.nextAtMs, 1000 + BLINK_SPAN_MS + gap);

  let doubled = stepBlinkClock({ nextAtMs: 0, startedAtMs: null, followAtMs: null }, 0, 0);
  assert.equal(doubled.clock.followAtMs, BLINK_SPAN_MS + 150);
  doubled = stepBlinkClock(doubled.clock, BLINK_SPAN_MS, 0.9);
  assert.equal(doubled.clock.startedAtMs, null);
  assert.equal(doubled.clock.nextAtMs, BLINK_SPAN_MS + 150);
  doubled = stepBlinkClock(doubled.clock, BLINK_SPAN_MS + 150, 0.9);
  assert.equal(doubled.clock.startedAtMs, BLINK_SPAN_MS + 150);
  assert.equal(doubled.clock.followAtMs, null);
});

test('视线跟随指针，空闲时环视，思考和工具各自改表情', () => {
  const same = faceGaze({ x: 10, y: 10 }, { x: 10, y: 10 });
  assert.equal(same.x, 0);
  assert.equal(same.y, 0);
  const right = faceGaze({ x: 0, y: 0 }, { x: 80, y: 0 });
  assert.ok(right.x > 0.45 && right.x < 0.55);
  assert.equal(right.y, 0);
  const far = faceGaze({ x: 0, y: 0 }, { x: 5000, y: -5000 });
  assert.ok(far.x > 0.999 && far.x <= 1);
  assert.ok(far.y < -0.999 && far.y >= -1);

  const glance = nextIdleLook(0, 0, 1);
  assert.equal(glance.x, -0.62);
  assert.equal(glance.y, 0.36);
  assert.equal(glance.untilMs, 1880);

  const tracking = resolveEyePose({
    mood: 'idle',
    nowMs: 1000,
    pointer: { x: 200, y: 0, atMs: 1000 - POINTER_FRESH_MS },
    faceCenter: { x: 0, y: 0 },
    idle: { x: -0.4, y: 0.2 }
  });
  assert.equal(tracking.expression, 'rest');
  assert.ok(tracking.lookX > 0.5);

  const wandering = resolveEyePose({
    mood: 'speaking',
    nowMs: 1000,
    pointer: { x: 200, y: 0, atMs: 1000 - POINTER_FRESH_MS - 1 },
    faceCenter: { x: 0, y: 0 },
    idle: { x: -0.4, y: 0.2 }
  });
  assert.equal(wandering.expression, 'talk');
  assert.equal(wandering.lookX, -0.4);
  assert.equal(wandering.lookY, 0.2);

  const thinking = resolveEyePose({
    mood: 'thinking',
    nowMs: 1000,
    pointer: { x: 400, y: 10, atMs: 1000 },
    faceCenter: { x: 0, y: 0 },
    idle: { x: 0, y: 0 }
  });
  assert.equal(thinking.expression, 'ellipsis');
  assert.equal(thinking.lookX, 0.12);
  assert.equal(thinking.lookY, -0.18);

  const tool = resolveEyePose({
    mood: 'tool',
    nowMs: 1000,
    pointer: { x: 400, y: 10, atMs: 1000 },
    faceCenter: { x: 0, y: 0 },
    idle: { x: 0.5, y: 0.5 }
  });
  assert.deepEqual(tool, { lookX: 0, lookY: 0, expression: 'scan' });

  assert.equal(toolScan(0), -0.72);
  assert.equal(toolScan(0.25), 0);
  assert.equal(toolScan(0.5), 0.72);
  assert.equal(speakingMouth(0), 0);
  assert.equal(speakingMouth(0.18), 1);
  assert.equal(speakingMouth(0.36), 0);
  assert.equal(speakingMouth(0.9), 0.08);
  assert.equal(ellipsisScale(0, 0.25), 1);
  assert.equal(ellipsisScale(0, 0), 0.775);
  assert.equal(damp(0, 1, 0), 0);
  assert.ok(Math.abs(damp(0, 1, 90) - (1 - Math.exp(-1))) < 1e-12);
});
