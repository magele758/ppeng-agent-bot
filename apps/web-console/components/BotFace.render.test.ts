import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import sharp from 'sharp';
import { faceLayout, BOT_FACE_PICKER_SHAPES } from '../lib/bot-face.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

// Render the actual TSX component in this node:test suite, preserving React's
// server renderer while resolving the app alias and ignoring its CSS import.
const localRequire = createRequire(import.meta.url);
let savedTestAvatar: string | null = null;
const loadedComponents = new Map<string, { exports: Record<string, unknown> }>();
function loadComponent(file: string, effects?: Array<() => unknown>, root?: any): any {
  const cached = loadedComponents.get(file);
  if (cached && !effects && !root) return cached.exports;
  let refs = 0;
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  } }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  if (!effects && !root) loadedComponents.set(file, mod);
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react' && effects) return { ...React, useEffect: (effect: () => unknown) => effects.push(effect), ...(root ? { useRef: (value: unknown) => ({ current: refs++ === 0 ? root : value }) } : {}) };
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key === 'play.faceMotion.working' ? '工作中' : key }) };
    if (id === '@/lib/bot-face') return localRequire('../lib/bot-face.ts');
    if (id === './BotFaceCatalog') return { useSavedFace: () => ({ shape: null, color: null, style: null, expression: null, avatar: savedTestAvatar }) };
    if (id === '@/lib/soft-bot-face') return localRequire('../lib/soft-bot-face.ts');
    if (id === '@/lib/bloub-motion') return localRequire('../lib/bloub-motion.ts');
    if (id === './BloubFace') return loadComponent('./BloubFace.tsx');
    if (id === './SoftBotFace') return loadComponent('./SoftBotFace.tsx');
    if (id === './BotFace') return loadComponent('./BotFace.tsx');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports;
}
const { BotFace } = loadComponent('./BotFace.tsx');

async function rasterFace(size: number) {
  const markup = renderToStaticMarkup(React.createElement(BotFace, { name: 'DeskBot', shape: 'flower', color: 'green', mood: 'idle' }));
  return sharp(Buffer.from(markup.replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

test('DeskBot flower retains both eyes and mouth at list and conversation sizes [AC:bot-functional-groups#AC-3]', async () => {
  const layout = faceLayout('flower');
  for (const size of [40, 48, 56]) {
    const { data, info } = await rasterFace(size);
    const pixel = (x: number, y: number) => {
      const i = (Math.round(y * size / 64) * info.width + Math.round(x * size / 64)) * 4;
      return [...data.subarray(i, i + 4)];
    };
    for (const x of [layout.left, layout.right]) {
      const [r, g, b, a] = pixel(x, layout.eyeY);
      assert.ok(r > 220 && g > 220 && b > 220 && a > 240, `visible white eye at ${size}px, got ${pixel(x, layout.eyeY)}`);
    }
    let mouthInk = 0;
    for (let y = layout.mouthY - 1; y <= layout.mouthY + 3; y++) {
      for (let x = 28; x <= 36; x++) {
        const [r, g, b] = pixel(x, y);
        if (r > 190 && g > 190 && b > 190) mouthInk++;
      }
    }
    assert.ok(mouthInk > 0, `smiling mouth remains visible at ${size}px`);
    // All five petal extremities must remain inside the visible viewport.
    for (const [x, y] of [[32, 8], [54, 28], [45, 49], [20, 49], [9, 28]]) {
      assert.ok(pixel(x, y)[3] > 240, `petal at ${x},${y} remains visible at ${size}px`);
    }
  }
});

test('idle face smiles without subscribing to pointer, blink or work animation [AC:bot-functional-groups#AC-4]', () => {
  const effects: Array<() => unknown> = [];
  const { BotFace: IdleFace } = loadComponent('./BotFace.tsx', effects);
  const markup = renderToStaticMarkup(React.createElement(IdleFace, { name: 'DeskBot', shape: 'flower', color: 'green', mood: 'idle' }));
  assert.match(markup, /data-mouth=""[^>]*opacity="1"/);
  assert.doesNotMatch(markup, /data-dot=""/);
  let scheduledFrames = 0;
  const globals = globalThis as any;
  const previousWindow = globals.window;
  const previousFrame = globals.requestAnimationFrame;
  globals.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
  globals.requestAnimationFrame = () => ++scheduledFrames;
  try {
    for (const effect of effects) effect();
    assert.equal(scheduledFrames, 0, 'idle faces stay fully still, even when pointer or time changes');
  } finally {
    globals.window = previousWindow;
    globals.requestAnimationFrame = previousFrame;
  }
});


function motionRoot() {
  const node = () => ({ attrs: new Map<string, string>(), setAttribute(key: string, value: string) { this.attrs.set(key, value); }, removeAttribute(key: string) { this.attrs.delete(key); }, getAttribute(key: string) { return this.attrs.get(key) ?? null; } });
  const root = Object.assign(node(), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }), querySelector: (selector: string) => nodes[selector] ?? null, querySelectorAll: () => [] });
  const nodes: Record<string, ReturnType<typeof node>> = { '[data-bob]': node(), '[data-look]': node(), '[data-blush]': node(), '[data-mouth]': node() };
  nodes['[data-mouth]'].setAttribute('data-y', '44');
  return { root, nodes };
}

test('working faces keep body and expression moving across long token pauses [AC:bot-working-animation#AC-1]', () => {
  const globals = globalThis as any;
  const originals = { window: globals.window, document: globals.document, requestAnimationFrame: globals.requestAnimationFrame };
  let callback: (now: number) => void;
  globals.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
  globals.document = { hidden: false };
  globals.requestAnimationFrame = (next: (now: number) => void) => { callback = next; return 1; };
  try {
    for (const mood of ['thinking', 'speaking', 'tool']) {
      const { root, nodes } = motionRoot();
      const effects: Array<() => unknown> = [];
      const { BotFace: Face } = loadComponent('./BotFace.tsx', effects, root);
      renderToStaticMarkup(React.createElement(Face, { name: 'DeskBot', mood }));
      const cleanups = effects.map(effect => effect());
      const samples = [10000, 10230, 10730, 60000, 60230].map(now => {
        callback!(now);
        return { body: nodes['[data-bob]'].getAttribute('transform'), look: nodes['[data-look]'].getAttribute('transform'), mouth: nodes['[data-mouth]'].getAttribute('d') };
      });
      assert.ok(new Set(samples.map(sample => sample.body)).size > 1, `${mood} body keeps moving: ${JSON.stringify(samples)}`);
      assert.ok(new Set(samples.map(sample => sample.look + sample.mouth)).size > 1, `${mood} expression keeps changing`);
      assert.notEqual(samples[3].body, samples[4].body, `${mood} still moves after a minute without tokens`);
      cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
    }
  } finally { Object.assign(globals, originals); }
});

test('idle face resets its last working pose and remains still [AC:bot-working-animation#AC-3]', () => {
  const effects: Array<() => unknown> = [];
  const { root, nodes } = motionRoot();
  root.querySelectorAll = () => [nodes['[data-bob]'], nodes['[data-look]']];
  nodes['[data-bob]'].setAttribute('transform', 'translate(0 2)');
  const { BotFace: Face } = loadComponent('./BotFace.tsx', effects, root);
  const markup = renderToStaticMarkup(React.createElement(Face, { name: 'DeskBot', mood: 'idle' }));
  effects.forEach(effect => effect());
  assert.equal(nodes['[data-bob]'].getAttribute('transform'), null);
  assert.match(markup, /data-face-working="false"/);
});

test('saved emoji and image retain identity and expose continuous work motion only while active [AC:bot-working-animation#AC-5]', () => {
  for (const avatar of ['🌼', 'https://example.com/bot.png']) {
    savedTestAvatar = avatar;
    for (const mood of ['tool', 'idle']) {
      const markup = renderToStaticMarkup(React.createElement(BotFace, { name: 'DeskBot', mood }));
      assert.ok(markup.includes(avatar));
      assert.ok(markup.includes(`data-face-working="${mood !== 'idle'}"`));
      assert.equal(markup.includes('bot-face--working'), mood !== 'idle');
    }
  }
  savedTestAvatar = null;
  const css = readFileSync(new URL('./bot-face.css', import.meta.url), 'utf8');
  assert.match(css, /animation:[^;]*infinite/);
});

test('reduced motion holds body and expression still with a visible localized working label [AC:bot-working-animation#AC-6]', () => {
  const globals = globalThis as any;
  const originals = { window: globals.window, document: globals.document, requestAnimationFrame: globals.requestAnimationFrame };
  let callback: (now: number) => void;
  globals.window = { matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} };
  globals.document = { hidden: false };
  globals.requestAnimationFrame = (next: (now: number) => void) => { callback = next; return 1; };
  try {
    const { root, nodes } = motionRoot();
    const effects: Array<() => unknown> = [];
    const { BotFace: Face } = loadComponent('./BotFace.tsx', effects, root);
    const markup = renderToStaticMarkup(React.createElement(Face, { name: 'DeskBot', mood: 'speaking' }));
    const cleanups = effects.map(effect => effect());
    callback!(10000);
    const first = [...nodes['[data-bob]'].attrs, ...nodes['[data-look]'].attrs, ...nodes['[data-mouth]'].attrs];
    callback!(10500);
    assert.deepEqual([...nodes['[data-bob]'].attrs, ...nodes['[data-look]'].attrs, ...nodes['[data-mouth]'].attrs], first);
    assert.match(markup, /class="bot-face__work-label"[^>]*>工作中/);
    const css = readFileSync(new URL('./bot-face.css', import.meta.url), 'utf8');
    assert.match(css, /prefers-reduced-motion: reduce/);
    cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
  } finally { Object.assign(globals, originals); }
});

async function measureListFace(shape: string) {
  const size = 40;
  const layout = faceLayout(shape as 'cloud');
  const markup = renderToStaticMarkup(React.createElement(BotFace, {
    name: 'Ubuntu2', shape, color: 'purple', mood: 'idle'
  }));
  const { data, info } = await sharp(Buffer.from(markup.replace('<svg ', `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const px = Math.max(0, Math.min(info.width - 1, Math.round(x * size / 64)));
    const py = Math.max(0, Math.min(info.height - 1, Math.round(y * size / 64)));
    const i = (py * info.width + px) * 4;
    return [...data.subarray(i, i + 4)];
  };
  const white = (sample: number[]) => sample[0] > 190 && sample[1] > 190 && sample[2] > 190 && sample[3] > 200;
  let mouthInk = 0;
  for (let y = layout.mouthY - 1; y <= layout.mouthY + 4; y++) {
    for (let x = 27; x <= 37; x++) {
      if (white(pixel(x, y))) mouthInk++;
    }
  }
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;
  const rows = new Array<number>(info.height).fill(0);
  for (let y = 0; y < info.height; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 40) {
        if (left < 0) left = x;
        right = x;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    rows[y] = left < 0 ? 0 : right - left + 1;
  }
  const height = maxY - minY + 1;
  return {
    markup,
    mouthInk,
    height,
    eyeL: white(pixel(layout.left, layout.eyeY)),
    eyeR: white(pixel(layout.right, layout.eyeY)),
    widthNearTop: rows[minY + Math.round((height - 1) * 0.1)]
  };
}

test('尖角星和尖顶房子换成圆润脸，选择器和列表用同一张 [AC:bot-face-readable-shapes#AC-1] [AC:bot-face-readable-shapes#AC-2]', async () => {
  const source = readFileSync(new URL('./BotFace.tsx', import.meta.url), 'utf8');
  const list = readFileSync(new URL('./SessionListRow.tsx', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('./BotFaceChoice.tsx', import.meta.url), 'utf8');
  assert.match(list, /from '\.\/BotFace'/);
  assert.match(picker, /from '\.\/BotFace'/);
  assert.equal(source.includes('M32 4 39 25 60 32'), false);
  assert.equal(source.includes('M32 6 58 28V58H6V28Z'), false);
  assert.notEqual(zh.agents.bots.faceShape.star, '星星');
  assert.notEqual(zh.agents.bots.faceShape.house, '房子');
  assert.notEqual(en.agents.bots.faceShape.star, 'Star');
  assert.notEqual(en.agents.bots.faceShape.house, 'House');
  for (const shape of ['star', 'house'] as const) {
    const face = await measureListFace(shape);
    assert.match(face.markup, new RegExp(`data-bot-shape="${shape}"`));
    assert.match(face.markup, /data-mouth=""[^>]*opacity="1"/);
    assert.equal(face.eyeL && face.eyeR, true, `${shape} eyes stay visible`);
    assert.ok(face.mouthInk > 0, `${shape} mouth stays inside the silhouette`);
    assert.ok(face.widthNearTop >= 16, `${shape} is rounded, top width ${face.widthNearTop}`);
  }
});

test('经典和软萌可以切换，没选风格时仍是经典脸 [AC:bot-face-soft-style#AC-4]', () => {
  const { BotFaceChoice } = loadComponent('./BotFaceChoice.tsx');
  const base = {
    name: 'Ada',
    shape: 'star',
    color: 'red',
    onShape: () => {},
    onColor: () => {},
    onStyle: () => {},
    onSoftSilhouette: () => {},
    onSoftColor: () => {}
  };
  const classic = renderToStaticMarkup(React.createElement(BotFaceChoice, { ...base, style: null }));
  assert.match(classic, /data-face-style="classic"/);
  assert.match(classic, /data-testid="bot-face-style-classic"[^>]*aria-pressed="true"/);
  assert.match(classic, /data-testid="bot-face-choice-preview"[^>]*data-bot-shape="star"/);
  assert.doesNotMatch(classic, /data-soft-bot-face=/);
  assert.match(classic, /data-bot-shape="circle"/);
  assert.match(classic, /aria-label="agents\.bots\.faceShape\.circle"/);

  const soft = renderToStaticMarkup(
    React.createElement(BotFaceChoice, {
      ...base,
      style: 'soft',
      softSilhouette: 'pebble',
      softColor: 'lilac'
    })
  );
  assert.match(soft, /data-face-style="soft"/);
  assert.match(soft, /data-testid="bot-face-style-soft"[^>]*aria-pressed="true"/);
  assert.match(soft, /data-testid="bot-face-choice-preview"[^>]*data-soft-bot-face="pebble"/);
  assert.match(soft, /data-soft-bot-color="lilac"/);
  assert.match(soft, /agents\.bots\.softShape\.capsule/);
  assert.doesNotMatch(soft, /data-bot-shape=/);
});

test('云朵在列表尺寸下嘴巴可见 [AC:bot-face-readable-shapes#AC-3]', async () => {
  const cloud = await measureListFace('cloud');
  assert.equal(cloud.eyeL && cloud.eyeR, true);
  assert.ok(cloud.mouthInk > 0, `cloud mouth ink ${cloud.mouthInk}`);
  assert.ok(cloud.height >= 26, `cloud is still a thin sliver, height ${cloud.height}`);
  for (const shape of BOT_FACE_PICKER_SHAPES) {
    if (shape === 'cloud') continue;
    const face = await measureListFace(shape);
    assert.ok(face.mouthInk > 0, `${shape} mouth remains visible`);
  }
});

test('干活时头像连续侧看和点头，空闲列表仍是慢动作 [AC:bot-face-readable-shapes#AC-4]', () => {
  const globals = globalThis as any;
  const originals = { window: globals.window, document: globals.document, requestAnimationFrame: globals.requestAnimationFrame };
  let callback: (now: number) => void;
  globals.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
  globals.document = { hidden: false };
  globals.requestAnimationFrame = (next: (now: number) => void) => { callback = next; return 1; };
  try {
    const { root, nodes } = motionRoot();
    const effects: Array<() => unknown> = [];
    const { BotFace: Face } = loadComponent('./BotFace.tsx', effects, root);
    renderToStaticMarkup(React.createElement(Face, { name: 'Ubuntu2', shape: 'cloud', color: 'purple', mood: 'speaking' }));
    const cleanups = effects.map(effect => effect());
    const samples = [1000, 1260, 1520, 2100].map((now) => {
      callback(now);
      return nodes['[data-bob]'].getAttribute('transform') ?? '';
    });
    assert.ok(samples.every((body) => /rotate\([-\d.]+ 32 36\)/.test(body)), `body should tilt while busy: ${samples.join(' | ')}`);
    const tilts = samples.map((body) => Number(/rotate\(([-\d.]+)/.exec(body)?.[1]));
    assert.ok(Math.max(...tilts) - Math.min(...tilts) > 4, `tilt should keep changing: ${tilts.join(',')}`);
    const css = readFileSync(new URL('./bot-face.css', import.meta.url), 'utf8');
    const working = css.slice(css.indexOf('@keyframes bot-face-working'), css.indexOf('@keyframes bot-face-idle-body'));
    assert.match(working, /translate\(-/);
    assert.match(css, /bot-face-working 0\.\d+s/);
    assert.match(css, /bot-face-idle-body 8\.8s/);
    cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
  } finally { Object.assign(globals, originals); }
});

test('soft style receives live mood and exposes animated face parts [AC:bot-soft-motion#AC-2]', () => {
  for (const mood of ['idle', 'thinking', 'speaking', 'tool'] as const) {
    const markup = renderToStaticMarkup(React.createElement(BotFace, { name: '111', faceStyle: 'soft', softSilhouette: 'pebble', softColor: 'coral', softExpression: 'happy', mood }));
    assert.match(markup, new RegExp(`data-face-mood="${mood}"`));
    assert.match(markup, new RegExp(`data-face-working="${mood !== 'idle'}"`));
    assert.match(markup, /data-soft-bot-face="pebble"/);
    assert.match(markup, /data-soft-bot-color="coral"/);
    for (const part of ['data-bob', 'data-look', 'data-eye', 'data-soft-mouth']) assert.ok(markup.includes(part));
    if (mood !== 'idle') assert.match(markup, /工作中/);
  }
});
