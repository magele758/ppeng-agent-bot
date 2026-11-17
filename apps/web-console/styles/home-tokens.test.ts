import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = readFileSync(path.join(root, 'styles/tokens.css'), 'utf8');
const shell = readFileSync(path.join(root, 'styles/shell.css'), 'utf8');

function homeBlock(): string {
  const at = shell.indexOf('/* home-shell */');
  assert.notEqual(at, -1);
  return shell.slice(at);
}

test('默认外观的浅色和深色用第 2 版鼠尾草绿 [AC:console-home-shell#AC-1]', () => {
  const lightAt = tokens.indexOf(":root[data-theme='light']");
  assert.notEqual(lightAt, -1);
  const dark = tokens.slice(0, lightAt);
  const light = tokens.slice(lightAt);
  assert.match(dark, /--ui-home-bg:\s*#111411/);
  assert.match(dark, /--ui-home-panel:\s*#161A16/);
  assert.match(dark, /--ui-home-text:\s*#E7ECE7/);
  assert.match(dark, /--ui-home-accent:\s*#82BD95/);
  assert.match(dark, /--ui-home-ok:\s*#6FC38D/);
  assert.match(dark, /--ui-home-warn:\s*#DFB25E/);
  assert.match(dark, /--ui-home-danger:\s*#EE8B78/);
  assert.match(dark, /--ui-home-info:\s*#82B4E6/);
  assert.match(light, /--ui-home-bg:\s*#F4F5F2/);
  assert.match(light, /--ui-home-panel:\s*#FAFAF8/);
  assert.match(light, /--ui-home-text:\s*#1A201B/);
  assert.match(light, /--ui-home-accent:\s*#3D6A4D/);
  assert.match(light, /--ui-home-ok:\s*#2C7A4D/);
  assert.match(light, /--ui-home-warn:\s*#93650F/);
  assert.match(light, /--ui-home-danger:\s*#B53C2A/);
  assert.match(light, /--ui-home-info:\s*#2A69A4/);
  assert.equal(tokens.includes('--ui-home-shadow: none'), true);
});

test('侧栏和顶栏是实色面板，当前项用强调色，待处理用待处理色 [AC:console-home-shell#AC-4]', () => {
  const home = homeBlock();
  assert.match(home, /body\.lab-root \.app\.lab-shell > \.lab-rail/);
  assert.match(home, /body\.lab-root \.lab-shell > \.lab-main > \.lab-toolbar/);
  assert.match(home, /background-color:\s*var\(--ui-home-panel\)/);
  assert.match(home, /background-color:\s*var\(--ui-home-bg\)/);
  assert.match(home, /border-color:\s*var\(--ui-home-line\)/);
  assert.match(home, /box-shadow:\s*var\(--ui-home-shadow\)/);
  assert.match(home, /backdrop-filter:\s*none/);
  assert.match(home, /aria-current='page'\] \.lab-rail__icon[\s\S]*?color:\s*var\(--ui-home-accent\)/);
  assert.match(home, /\.lab-rail__badge[\s\S]*?color:\s*var\(--ui-home-warn\)/);
  assert.match(home, /\.lab-rail__badge[\s\S]*?background:\s*var\(--ui-home-warn-soft\)/);
  assert.doesNotMatch(home, /gradient\(/);
  assert.match(home, /:focus-visible[\s\S]*?outline:\s*2px solid var\(--ui-home-accent\)/);
});
