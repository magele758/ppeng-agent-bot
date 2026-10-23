import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { en } from '../../lib/i18n/messages/en/index.ts';
import { zh } from '../../lib/i18n/messages/zh/index.ts';
import { translate } from '../../lib/i18n/t.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');

function t(key: string, vars?: Record<string, string | number>): string {
  return translate(zh, key, vars);
}

const jsx = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
} as const;

function loadTsx(filename: string): Record<string, unknown> {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: jsx }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => resolveImport(filename, id);
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

function resolveImport(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return createRequire(fromFile)(id);
  if (id.endsWith('.css')) return {};
  if (id === '@/lib/i18n') return { useI18n: () => ({ t, locale: 'zh' }) };
  if (id === './LabProvider') {
    return {
      useLab: () => ({
        location: { section: 'settings', sub: 'general', pane: null },
        navigate: () => {},
        approvals: []
      })
    };
  }
  if (id.startsWith('@/')) {
    const base = path.join(webRoot, id.slice(2));
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.tsx`) ? `${base}.tsx` : base;
    if (file.endsWith('.tsx')) return loadTsx(file);
    return createRequire(fromFile)(file);
  }
  const resolved = path.resolve(path.dirname(fromFile), id);
  const tsxFile = existsSync(`${resolved}.tsx`) ? `${resolved}.tsx` : resolved.endsWith('.tsx') ? resolved : '';
  if (tsxFile) return loadTsx(tsxFile);
  const tsFile = existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved;
  return createRequire(fromFile)(tsFile);
}

/** Hub plus disconnected straight rays (or line rays) reads as a sun. A gear is a hub plus a closed curved outline. */
function iconKind(svg: string): 'sun' | 'gear' | 'other' {
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((match) => match[1]);
  const d = paths.join(' ');
  const circles = svg.match(/<circle\b/g)?.length ?? 0;
  const lines = svg.match(/<line\b/g)?.length ?? 0;
  const moves = d.match(/M/gi)?.length ?? 0;
  const curved = /[aAcCqQsS]/.test(d);
  const closed = /[zZ]/.test(d);
  if (circles >= 1 && !curved && !closed && (moves >= 4 || lines >= 4)) return 'sun';
  if (circles >= 1 && lines >= 4 && !closed) return 'sun';
  if (circles >= 1 && closed && curved) return 'gear';
  return 'other';
}

function sliceAnchor(html: string, id: string): string {
  const match = html.match(new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</a>`));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

const { Rail } = loadTsx(path.join(here, 'Rail.tsx')) as {
  Rail: React.ComponentType<{ footer?: React.ReactNode }>;
};

const railHtml = renderToStaticMarkup(React.createElement(Rail, {}));
const settingsLink = sliceAnchor(railHtml, 'nav-settings');
const settingsIcon = settingsLink.match(/<svg[\s\S]*?<\/svg>/)?.[0] ?? '';
const shellCss = readFileSync(path.join(webRoot, 'styles/shell.css'), 'utf8');
const themeToggle = readFileSync(path.join(webRoot, 'components/ThemeToggle.tsx'), 'utf8');
const labShell = readFileSync(path.join(here, 'LabShell.tsx'), 'utf8');
const railSource = readFileSync(path.join(here, 'Rail.tsx'), 'utf8');

test('设置入口是齿轮，展开文字仍是现有「设置」 [AC:rail-settings-icon#AC-1]', () => {
  assert.ok(settingsIcon, 'settings entry has an icon');
  assert.equal(iconKind(settingsIcon), 'gear');
  assert.equal(zh.shell.nav.settings, '设置');
  assert.equal(en.shell.nav.settings, 'Settings');
  assert.match(settingsLink, new RegExp(`>${zh.shell.nav.settings}<`));
  assert.match(railSource, /t\(`shell\.nav\.\$\{id\}`\)/);
  assert.doesNotMatch(railSource, />(设置|Settings)</);
  const collapsedLabel = shellCss.match(
    /\.lab-rail\.is-collapsed \.lab-rail__label[\s\S]*?\{([^}]*)\}/
  );
  assert.ok(collapsedLabel, 'collapsed rail clips the label');
  assert.match(collapsedLabel[1], /clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
  assert.doesNotMatch(shellCss, /\.lab-rail\.is-collapsed[^{]*\.lab-rail__icon\s*\{[^}]*display:\s*none/);
});

test('太阳留在主题切换，不占设置入口 [AC:rail-settings-icon#AC-2]', () => {
  assert.equal(iconKind(settingsIcon), 'gear');
  assert.doesNotMatch(settingsLink, /<line\b/);
  assert.match(themeToggle, /theme === 'dark'/);
  assert.match(themeToggle, /<line /);
  assert.match(themeToggle, /<circle cx="8" cy="8" r="3\.5"/);
  assert.match(labShell, /<ThemeToggle \/>/);
  assert.doesNotMatch(labShell, /nav-settings[\s\S]{0,400}<ThemeToggle/);
});
