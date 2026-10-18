import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import sharp from 'sharp';
import { faceLayout } from '../lib/bot-face.ts';

// Render the actual TSX component in this node:test suite, preserving React's
// server renderer while resolving the app alias and ignoring its CSS import.
const localRequire = createRequire(import.meta.url);
let savedTestAvatar: string | null = null;
function loadComponent(file: string, effects?: Array<() => unknown>, root?: any): any {
  let refs = 0;
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  } }).outputText;
  const mod = { exports: {} };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react' && effects) return { ...React, useEffect: (effect: () => unknown) => effects.push(effect), ...(root ? { useRef: (value: unknown) => ({ current: refs++ === 0 ? root : value }) } : {}) };
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key === 'play.faceMotion.working' ? '工作中' : '空闲' }) };
    if (id === '@/lib/bot-face') return localRequire('../lib/bot-face.ts');
    if (id === './BotFaceCatalog') return { useSavedFace: () => ({ shape: null, color: null, avatar: savedTestAvatar }) };
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
