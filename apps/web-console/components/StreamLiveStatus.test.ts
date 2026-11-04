import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
const css = readFileSync(path.join(webRoot, 'legacy-vanilla/styles.css'), 'utf8');

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, path.join(request, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
  }
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const compiled = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const requireFrom = (id: string) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
    if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) {
      return { useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars) }) };
    }
    if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
    if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(resolved), id)));
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

function renderStatus(props: { segments: unknown[]; visibleCount: number; hiddenCount: number }): string {
  const ui = loadFile(path.join(here, 'StreamLiveStatus.tsx')) as {
    StreamLiveStatus: React.ComponentType<Record<string, unknown>>;
  };
  return renderToStaticMarkup(React.createElement(ui.StreamLiveStatus, props));
}

test('还没出字时三个点在状态行里，点开能看到等待明细 [AC:stream-live-status#AC-1] [AC:stream-live-status#AC-4]', () => {
  const html = renderStatus({ segments: [], visibleCount: 0, hiddenCount: 0 });
  assert.equal((html.match(/class="stream-live__dot"/g) ?? []).length, 3);
  assert.match(html, /data-phase="waiting"/);
  assert.match(html, /stream-live__phase">等待模型/);
  assert.match(html, /stream-live__pace">\d+\.\ds/);
  assert.match(html, /<summary[^>]*title="点开查看已用时间、字数和速度"/);
  assert.match(html, /已用/);
  assert.match(html, /还没有输出/);
  assert.match(html, /0 字/);
  assert.match(html, /<details/);
});

test('有正文时点让开，工具名写在状态上 [AC:stream-live-status#AC-2] [AC:stream-live-status#AC-3]', () => {
  const writing = renderStatus({
    segments: [{ kind: 'text', raw: '已经在写了', html: '已经在写了' }],
    visibleCount: 1,
    hiddenCount: 0
  });
  assert.equal(writing.includes('stream-live__dot'), false);
  assert.match(writing, /正在写/);
  const tool = renderStatus({
    segments: [{ kind: 'tool', name: 'read_file', args: '{}' }],
    visibleCount: 1,
    hiddenCount: 0
  });
  assert.match(tool, /正在调用 read_file/);
  assert.match(tool, /正在做/);
  assert.match(tool, />read_file</);
});

test('三个点错落跳动，减少动态时停住 [AC:stream-live-status#AC-1] [AC:stream-live-status#AC-5]', () => {
  assert.match(css, /@keyframes stream-live-dot/);
  assert.match(css, /\.stream-live__dot\s*\{[^}]*animation:\s*stream-live-dot 1\.05s ease-in-out infinite/);
  assert.match(css, /\.stream-live__dot:nth-child\(2\)\s*\{[^}]*animation-delay:\s*0\.16s/);
  assert.match(css, /\.stream-live__dot:nth-child\(3\)\s*\{[^}]*animation-delay:\s*0\.32s/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.stream-live__dot\s*\{[^}]*animation:\s*none/);
});
