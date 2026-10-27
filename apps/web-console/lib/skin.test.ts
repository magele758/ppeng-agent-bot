import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SKIN_BOOTSTRAP,
  SKIN_STORAGE_KEY,
  applySkin,
  parseSkin,
  type SkinEnv
} from './skin.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function memoryEnv(initial: Record<string, string> = {}): SkinEnv & { store: Map<string, string>; attrs: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  const attrs = new Map<string, string>();
  return {
    store,
    attrs,
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, value); },
      removeItem: (key) => { store.delete(key); }
    },
    root: {
      setAttribute: (name, value) => { attrs.set(name, value); },
      removeAttribute: (name) => { attrs.delete(name); },
      getAttribute: (name) => attrs.get(name) ?? null
    }
  };
}

test('未选过外观时是经典，不会写成圣所 [AC:sanctum-skin#AC-4] [AC:console-skin-motion#AC-4]', () => {
  assert.equal(parseSkin(null), 'classic');
  assert.equal(parseSkin(''), 'classic');
  assert.equal(parseSkin('light'), 'classic');
  assert.equal(parseSkin('sanctum'), 'sanctum');
  const env = memoryEnv();
  applySkin('classic', env);
  assert.equal(env.root.getAttribute('data-skin'), null);
  assert.equal(env.store.has(SKIN_STORAGE_KEY), false);
  assert.match(SKIN_BOOTSTRAP, /sanctum/);
  assert.match(SKIN_BOOTSTRAP, /kindergarten/);
  assert.match(SKIN_BOOTSTRAP, /cyberpunk/);
  assert.doesNotMatch(SKIN_BOOTSTRAP, /setAttribute\('data-theme'/);
});

test('圣所切换不改深浅色，切回经典后深浅色仍在 [AC:sanctum-skin#AC-1] [AC:sanctum-skin#AC-2]', () => {
  const env = memoryEnv({ theme: 'light' });
  applySkin('sanctum', env);
  assert.equal(env.root.getAttribute('data-skin'), 'sanctum');
  assert.equal(env.store.get(SKIN_STORAGE_KEY), 'sanctum');
  assert.equal(env.store.get('theme'), 'light');
  applySkin('classic', env);
  assert.equal(env.root.getAttribute('data-skin'), null);
  assert.equal(env.store.has(SKIN_STORAGE_KEY), false);
  assert.equal(env.store.get('theme'), 'light');
});

test('圣所样式只改炭绿旧金衬线，不改经典根变量 [AC:sanctum-skin#AC-3]', () => {
  const skinCss = readFileSync(path.join(webRoot, 'styles/sanctum-tokens.css'), 'utf8');
  const classic = readFileSync(path.join(webRoot, 'legacy-vanilla/styles.css'), 'utf8');
  assert.match(skinCss, /html\[data-skin="sanctum"\][\s\S]*--color-surface-base:\s*#0a100f/);
  assert.match(skinCss, /html\[data-skin="sanctum"\][\s\S]*--color-text-secondary:\s*#c3aa77/);
  assert.match(skinCss, /html\[data-skin="sanctum"\][\s\S]*--font-display:[^;]*Sanctum Serif/);
  assert.match(classic, /--color-surface-base:\s*#000000/);
  assert.match(classic, /--color-text-secondary:\s*#9bbcff/);
  assert.doesNotMatch(skinCss, /^:root\s*\{/m);
});

function gray(hex: string): boolean {
  const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex;
  return full.slice(0, 2) === full.slice(2, 4) && full.slice(2, 4) === full.slice(4, 6);
}

test('每套外观有自己的颜色，像素只有黑白灰 [AC:console-skins#AC-3] [AC:console-skins#AC-4] [AC:console-skins#AC-5]', () => {
  const read = (name: string) => readFileSync(path.join(webRoot, 'styles', name), 'utf8');
  const ornament = read('sanctum-ornament.css');
  assert.match(ornament, /html\[data-skin="sanctum"\][\s\S]*sanctum-geometry\.svg/);
  assert.match(ornament, /pointer-events:\s*none/);
  assert.match(read('skin-cyberpunk.css'), /html\[data-skin="cyberpunk"\][\s\S]*#fcee0a/);
  assert.match(read('skin-demon.css'), /html\[data-skin="demon"\][\s\S]*#e25822/);
  assert.match(read('skin-robot-stage.css'), /html\[data-skin="robot-stage"\][\s\S]*#ffb000/);
  assert.match(read('skin-kindergarten.css'), /html\[data-skin="kindergarten"\][\s\S]*#f5b400/);
  const pixel = read('skin-pixel.css');
  assert.match(pixel, /html\[data-skin="pixel"\]/);
  const colors = [...pixel.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)].map((match) => match[1]);
  assert.ok(colors.length > 0);
  assert.ok(colors.every(gray));
});

test('任意外观切换都不改深浅色，未选过仍是经典 [AC:console-skins#AC-1] [AC:console-skins#AC-2] [AC:console-skins#AC-6]', () => {
  for (const id of ['sanctum', 'cyberpunk', 'demon', 'robot-stage', 'pixel', 'kindergarten', 'minimal'] as const) {
    const env = memoryEnv({ theme: 'dark' });
    applySkin(id, env);
    assert.equal(env.root.getAttribute('data-skin'), id);
    assert.equal(env.store.get('theme'), 'dark');
    applySkin('classic', env);
    assert.equal(env.root.getAttribute('data-skin'), null);
    assert.equal(env.store.get('theme'), 'dark');
  }
  assert.equal(parseSkin('nope'), 'classic');
});

test('每套外观有独立特效，极简黑白没有彩色 [AC:console-skin-motion#AC-1] [AC:console-skin-motion#AC-2] [AC:console-skin-motion#AC-3]', () => {
  const read = (name: string) => readFileSync(path.join(webRoot, 'styles', name), 'utf8');
  for (const [file, id] of [
    ['motion/sanctum.css', 'sanctum'],
    ['motion/cyberpunk.css', 'cyberpunk'],
    ['motion/demon.css', 'demon'],
    ['motion/robot-stage.css', 'robot-stage'],
    ['motion/pixel.css', 'pixel'],
    ['motion/kindergarten.css', 'kindergarten']
  ] as const) {
    const css = read(file);
    assert.match(css, new RegExp(`html\\[data-skin="${id}"\\]`));
    assert.match(css, /@keyframes/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /pointer-events:\s*none/);
    assert.doesNotMatch(css, new RegExp(`html\\[data-skin="(?!${id}")`));
  }
  const minimal = read('skin-minimal.css');
  assert.match(minimal, /html\[data-skin="minimal"\]/);
  assert.doesNotMatch(minimal, /animation:/);
  assert.doesNotMatch(minimal, /@keyframes/);
  const colors = [...minimal.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)].map((match) => match[1]);
  assert.ok(colors.length > 0);
  assert.ok(colors.every(gray));
  assert.match(read('skin-motion-guard.css'), /prefers-reduced-motion:\s*reduce/);
});
