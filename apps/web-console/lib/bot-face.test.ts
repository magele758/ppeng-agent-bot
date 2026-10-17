import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLINK_CLOSE_MS,
  BLINK_SPAN_MS,
  BOT_FACE_COLORS,
  BOT_FACE_COUNT,
  BOT_FACE_PICKER_COLORS,
  BOT_FACE_PICKER_SHAPES,
  BOT_FACE_SHAPES,
  HAPPY_BEAT_MS,
  HOVER_HOP_MS,
  SLEEPY_AFTER_MS,
  POINTER_FRESH_MS,
  blinkOpenness,
  botFaceColor,
  botFaceIndex,
  botFaceShape,
  isBotFaceColor,
  isBotFaceShape,
  avatarStandIn,
  avatarWhenNoFaceOverride,
  botFaceClassName,
  detailFaceProps,
  drawnFaceView,
  eyeInkForColor,
  faceLayout,
  indexSavedFaces,
  isAvatarImageUrl,
  previewFaceChoice,
  resolveBotFaceAppearance,
  resolveDrawnFace,
  damp,
  ellipsisScale,
  happyBeat,
  hoverDelight,
  mouthPath,
  expressionForMood,
  faceGaze,
  nextIdleLook,
  resolveEyePose,
  resolveFaceGesture,
  resolveLivingFaceMood,
  speakingMouth,
  stepBlinkClock,
  toolScan,
  turnFinishHappyUntil,
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

test('名字映射到稳定且彼此不同的脸颜色和轮廓', () => {
  assert.ok(BOT_FACE_COLORS.length > 3);
  assert.deepEqual(BOT_FACE_PICKER_SHAPES, [
    'circle',
    'cloud',
    'squircle',
    'star',
    'clover',
    'heart',
    'flower',
    'teardrop',
    'bean',
    'triangle',
    'house',
    'splat',
    'hexagon'
  ]);
  assert.equal(BOT_FACE_PICKER_COLORS.length, 11);
  assert.equal(isBotFaceShape('tall'), true);
  assert.equal(botFaceColor('  DeskBot  '), botFaceColor('DeskBot'));
  assert.equal(botFaceShape('  DeskBot  '), botFaceShape('DeskBot'));
  assert.notEqual(botFaceColor('DeskBot'), botFaceColor('Super Bot'));
  assert.notEqual(botFaceColor('Super Bot'), botFaceColor('小八'));
  assert.notEqual(botFaceShape('DeskBot'), botFaceShape('Super Bot'));
  assert.notEqual(botFaceShape('Super Bot'), botFaceShape('小八'));
  assert.notEqual(botFaceShape('小八'), botFaceShape('DeskBot'));
  const seenColors = new Set<string>();
  const seenShapes = new Set<string>();
  for (const name of ['DeskBot', 'Super Bot', '小八', 'ada', '每日简报', 'Alpha', 'Gamma', 'Echo', 'Foxtrot']) {
    const color = botFaceColor(name);
    const shape = botFaceShape(name);
    assert.ok(color && (BOT_FACE_COLORS as readonly string[]).includes(color));
    assert.ok(shape && (BOT_FACE_SHAPES as readonly string[]).includes(shape));
    assert.equal(color, botFaceColor(name));
    assert.equal(shape, botFaceShape(name));
    if (color) seenColors.add(color);
    if (shape) seenShapes.add(shape);
  }
  assert.ok(seenShapes.size > 3);
  assert.ok(seenColors.size > 3);
  const reachable = new Set<string>();
  for (let i = 0; i < 500; i += 1) {
    const shape = botFaceShape(`shape-${i}`);
    if (shape) reachable.add(shape);
  }
  assert.deepEqual([...reachable].sort(), [...BOT_FACE_PICKER_SHAPES].sort());
  assert.equal(botFaceColor(''), null);
  assert.equal(botFaceShape(''), null);
  assert.equal(botFaceColor(null), null);
  assert.equal(botFaceShape(undefined), null);
});

test('保存的脸型和颜色覆盖名字，没保存则沿用名字', () => {
  assert.equal(isBotFaceShape('squircle'), true);
  assert.equal(isBotFaceShape('star'), true);
  assert.equal(isBotFaceShape('spark'), false);
  assert.equal(isBotFaceColor('yellow'), true);
  assert.equal(isBotFaceColor('gold'), false);
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot' }), {
    shape: botFaceShape('DeskBot'),
    color: botFaceColor('DeskBot')
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: '  DeskBot  ', savedShape: null, savedColor: null }), {
    shape: botFaceShape('DeskBot'),
    color: botFaceColor('DeskBot')
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot', savedShape: 'teardrop', savedColor: 'black' }), {
    shape: 'teardrop',
    color: 'black'
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot', savedShape: 'bean' }), {
    shape: 'bean',
    color: botFaceColor('DeskBot')
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot', savedColor: 'mint' }), {
    shape: botFaceShape('DeskBot'),
    color: 'mint'
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: 'DeskBot', savedShape: 'nope', savedColor: '' }), {
    shape: botFaceShape('DeskBot'),
    color: botFaceColor('DeskBot')
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: '' }), { shape: null, color: null });
  assert.deepEqual(resolveBotFaceAppearance({ name: '', savedShape: 'circle', savedColor: 'red' }), {
    shape: 'circle',
    color: 'red'
  });
  assert.deepEqual(resolveBotFaceAppearance({ name: 'Super Bot' }), {
    shape: botFaceShape('Super Bot'),
    color: botFaceColor('Super Bot')
  });
});

test('picker preview keeps a saved avatar until a shape or color is chosen', () => {
  const shown = { shape: 'star' as const, color: 'blue' as const };
  assert.deepEqual(previewFaceChoice(null, null, shown), {});
  assert.deepEqual(previewFaceChoice('circle', null, shown), { shape: 'star' });
  assert.deepEqual(previewFaceChoice(null, 'red', shown), { color: 'blue' });
  assert.deepEqual(previewFaceChoice('circle', 'red', { shape: null, color: null }), {
    shape: 'teardrop',
    color: 'red'
  });
});

test('saved faces index by trimmed name and skip blanks', () => {
  const map = indexSavedFaces([
    { name: '  Ada  ', faceShape: 'bean', faceColor: 'mint', avatar: '  🤖  ' },
    { name: '   ', faceShape: 'star', faceColor: 'red' },
    { name: 'NoSave', faceShape: 'spark', faceColor: 'gold', avatar: '  ' },
    { name: 'Pic', avatar: ' https://cdn.example/a.png ' },
    { name: 'ShapeOnly', faceShape: 'heart' }
  ]);
  assert.deepEqual(map.get('Ada'), { shape: 'bean', color: 'mint', avatar: '🤖' });
  assert.equal(map.has(''), false);
  assert.equal(map.has('NoSave'), false);
  assert.deepEqual(map.get('Pic'), { shape: null, color: null, avatar: 'https://cdn.example/a.png' });
  assert.deepEqual(map.get('ShapeOnly'), { shape: 'heart', color: null, avatar: null });
  assert.equal(indexSavedFaces([{ name: 'Num', avatar: 3 as unknown as string }]).size, 0);
});

test('an avatar stands in only when no face override was passed', () => {
  assert.equal(avatarWhenNoFaceOverride(undefined, undefined, '🤖'), '🤖');
  assert.equal(avatarWhenNoFaceOverride(null, undefined, '🤖'), null);
  assert.equal(avatarWhenNoFaceOverride(undefined, 'red', '🤖'), null);
  assert.equal(isAvatarImageUrl(null), false);
  assert.equal(isAvatarImageUrl('🤖'), false);
  assert.equal(isAvatarImageUrl('https://cdn.example/a.png'), true);
  assert.equal(isAvatarImageUrl('HTTP://cdn.example/a.png'), true);
  assert.equal(avatarStandIn({ avatar: null, size: 'sm' }), null);
  assert.deepEqual(avatarStandIn({ avatar: 'https://cdn.example/a.png', size: 'lg', label: 'Ada' }), {
    kind: 'image',
    className: 'bot-face bot-face--avatar bot-face--lg',
    src: 'https://cdn.example/a.png',
    alt: 'Ada'
  });
  assert.deepEqual(avatarStandIn({ avatar: '🤖', size: 'sm' }), {
    kind: 'emoji',
    className: 'bot-face bot-face--avatar',
    text: '🤖',
    label: undefined
  });
  assert.equal(botFaceClassName({ size: 'md', empty: true, className: 'extra' }), 'bot-face bot-face--empty bot-face--md extra');
  assert.equal(botFaceClassName({ size: 'sm' }), 'bot-face');
});

test('drawn face uses a save, then the name, and rounds the eyes when surprised', () => {
  const saved = { shape: 'bean' as const, color: 'mint' as const };
  const idle = drawnFaceView({ name: 'DeskBot', saved, mood: 'idle' });
  assert.equal(idle.shape, 'bean');
  assert.equal(idle.color, 'mint');
  assert.equal(idle.mouth, 'rest');
  assert.equal(idle.mouthOpen, 0);
  assert.deepEqual(idle.layout, faceLayout('bean'));
  const named = drawnFaceView({ name: 'DeskBot', shape: null, color: null, saved, mood: 'speaking' });
  assert.equal(named.shape, botFaceShape('DeskBot'));
  assert.equal(named.mouth, 'open');
  assert.equal(named.mouthOpen, 0.45);
  assert.equal(named.drawnShape, named.shape);
  const blank = drawnFaceView({ name: '', shape: null, color: 'red', saved: { shape: null, color: null }, mood: 'tool' });
  assert.equal(blank.drawnShape, 'circle');
  assert.equal(blank.eyeW, 8.2);
  assert.equal(blank.mouth, 'oh');
  assert.equal(blank.index, null);
  const empty = drawnFaceView({ name: '', saved: { shape: null, color: null }, mood: 'thinking' });
  assert.equal(empty.drawnShape, 'empty');
  assert.equal(empty.empty, true);
  assert.equal(empty.eyes, '#667085');
  assert.equal(eyeInkForColor('yellow'), '#1A1A1A');
  assert.equal(eyeInkForColor('white'), '#1A1A1A');
  assert.equal(eyeInkForColor('blue'), '#FFFFFF');
  assert.equal(eyeInkForColor(null), '#667085');
  assert.deepEqual(faceLayout(null), faceLayout('circle'));
  assert.deepEqual(faceLayout('tall').left, 27);
  assert.deepEqual(resolveDrawnFace({ name: 'DeskBot', color: 'red', saved }), {
    shape: 'bean',
    color: 'red'
  });
  assert.deepEqual(detailFaceProps(null, null), {});
  assert.deepEqual(detailFaceProps('star', null), { shape: 'star' });
  assert.deepEqual(detailFaceProps(null, 'pink'), { color: 'pink' });
  for (const shape of BOT_FACE_SHAPES) assert.ok(faceLayout(shape).eyeH > 0);
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
  assert.equal(expressionForMood('tool'), 'surprised');
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
  assert.deepEqual(tool, { lookX: 0, lookY: 0, expression: 'surprised' });

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

test('悬停、犯困和说完后的高兴各自接在空闲脸上', () => {
  const base = {
    mood: 'idle' as const,
    hovering: false,
    pointerAgeMs: 100,
    nowMs: 5000,
    happyUntilMs: null
  };
  assert.equal(resolveFaceGesture(base), 'rest');
  assert.equal(resolveFaceGesture({ ...base, hovering: true }), 'hover');
  assert.equal(resolveFaceGesture({ ...base, pointerAgeMs: SLEEPY_AFTER_MS + 1 }), 'sleepy');
  assert.equal(resolveFaceGesture({ ...base, pointerAgeMs: null }), 'rest');
  assert.equal(resolveFaceGesture({ ...base, hovering: true, pointerAgeMs: null }), 'hover');
  assert.equal(resolveFaceGesture({ ...base, happyUntilMs: 5400 }), 'happy');
  assert.equal(resolveFaceGesture({ ...base, happyUntilMs: 5400, hovering: true }), 'happy');
  assert.equal(resolveFaceGesture({ ...base, mood: 'thinking', hovering: true }), 'ellipsis');
  assert.equal(resolveFaceGesture({ ...base, mood: 'speaking' }), 'talk');
  assert.equal(resolveFaceGesture({ ...base, mood: 'tool', hovering: true }), 'surprised');

  assert.equal(turnFinishHappyUntil('idle', 'idle', 1000), null);
  assert.equal(turnFinishHappyUntil('speaking', 'thinking', 1000), null);
  assert.equal(turnFinishHappyUntil('tool', 'idle', 1000), 1000 + HAPPY_BEAT_MS);
  assert.equal(turnFinishHappyUntil('thinking', 'idle', 1000), 1000 + HAPPY_BEAT_MS);

  assert.equal(hoverDelight(-1).smile, 0);
  assert.ok(Math.abs(hoverDelight(0).dy) < 1e-12);
  assert.equal(hoverDelight(0).smile, 1);
  assert.ok(hoverDelight(HOVER_HOP_MS / 2).dy < -0.9);
  assert.ok(hoverDelight(HOVER_HOP_MS / 2).dy > -1.3);
  assert.equal(hoverDelight(HOVER_HOP_MS).dy, 0);
  assert.equal(hoverDelight(HOVER_HOP_MS).smile, 1);

  assert.ok(Math.abs(happyBeat(0).dy) < 1e-12);
  assert.equal(happyBeat(0).smile, 1);
  assert.ok(happyBeat(HAPPY_BEAT_MS / 4).dy < 0);
  assert.deepEqual(happyBeat(HAPPY_BEAT_MS + 1), { dy: 0, smile: 0 });
  assert.equal(mouthPath('sleepy', 43), 'M29 44 H35');
  assert.match(mouthPath('smile', 43), /^M29 /);
  assert.match(mouthPath('oh', 40), /^M29 /);
  assert.match(mouthPath('open', 43, 1), /Q32 /);
});
