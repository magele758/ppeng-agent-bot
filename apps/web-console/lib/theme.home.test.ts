import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isUserPreferenceKey } from './user-preference-schema.ts';
import { THEME_STORAGE_KEY, applyThemePreference } from './theme.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withBrowser(prefersDark: boolean, run: () => void): void {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const data = new Map<string, string>();
  const attrs = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  const root = {
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    getAttribute: (name: string) => attrs.get(name) ?? null
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: storage, matchMedia: () => ({ matches: prefersDark }), dispatchEvent: () => true }
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
  try {
    run();
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  }
}

test('深浅色记在原有偏好里，并套用对应的第 2 版配色 [AC:console-home-shell#AC-2]', () => {
  const themeSource = readFileSync(path.join(webRoot, 'lib/theme.ts'), 'utf8');
  const layout = readFileSync(path.join(webRoot, 'app/layout.tsx'), 'utf8');
  const tokens = readFileSync(path.join(webRoot, 'styles/tokens.css'), 'utf8');
  assert.equal(THEME_STORAGE_KEY, 'theme');
  assert.equal(isUserPreferenceKey('theme'), true);
  assert.doesNotMatch(themeSource, /RAW_AGENT_|process\.env/);
  assert.match(layout, /localStorage\.getItem\('theme'\)/);
  assert.doesNotMatch(layout, /RAW_AGENT_/);
  assert.match(tokens, /:root\[data-theme='light'\][\s\S]*?--ui-home-bg:\s*#F4F5F2/);
  assert.match(tokens, /--ui-home-bg:\s*#111411/);
  withBrowser(true, () => {
    applyThemePreference('light');
    assert.equal(window.localStorage.getItem('theme'), 'light');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
    applyThemePreference('dark');
    assert.equal(window.localStorage.getItem('theme'), 'dark');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  });
});
