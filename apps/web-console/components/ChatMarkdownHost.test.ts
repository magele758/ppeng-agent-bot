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
const i18n = {
  useI18n: () => ({
    locale: 'zh' as const,
    messages: zh,
    setLocale: () => undefined,
    t: (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars)
  })
};
const loaded = new Map<string, Record<string, unknown>>();

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
  }
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = loaded.get(resolved);
  if (cached) return cached;
  if (resolved.endsWith('.css')) return {};
  const compiled = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  loaded.set(resolved, mod.exports);
  const requireFrom = (id: string) => requireId(resolved, id);
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

function requireId(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
  if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18n;
  if (id.endsWith('.css')) return {};
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)));
  return localRequire(id);
}

const host = loadFile(path.join(here, 'ChatMarkdownHost.tsx')) as {
  withCopyLabels: (html: string, copyLabel: string) => string;
  finishCodeCopy: (code: string, copiedLabel: string, write: (value: string) => boolean) => string;
  ChatMarkdownHost: React.ComponentType<{ html: string; className?: string; copyLabel: string; copiedLabel: string }>;
};

const FRAME = '<div class="chat-md-code"><div class="chat-md-code__bar"><span class="chat-md-code__lang">typescript</span><button type="button" class="chat-md-code__copy" data-md-copy></button></div><pre><code class="language-typescript">const n = 1;</code></pre></div>';

test('[AC:chat-reading#AC-3] withCopyLabels puts 复制代码 inside the empty copy button and finishCodeCopy writes the code', () => {
  const labeled = host.withCopyLabels(FRAME, '复制代码');
  assert.match(labeled, /<button type="button" class="chat-md-code__copy" data-md-copy>复制代码<\/button>/);
  assert.equal(labeled.includes('data-md-copy></button>'), false);
  assert.equal(host.withCopyLabels(FRAME + FRAME, '复制代码').split('复制代码').length - 1, 2);
  assert.match(
    host.withCopyLabels(FRAME, 'a&b<c>'),
    /<button type="button" class="chat-md-code__copy" data-md-copy>a&amp;b&lt;c&gt;<\/button>/
  );

  let wrote = '';
  const copied = host.finishCodeCopy('const n = 1;\n', '已复制', (value) => {
    wrote = value;
    return true;
  });
  assert.equal(wrote, 'const n = 1;\n');
  assert.equal(copied, '已复制');

  let failed = '';
  const kept = host.finishCodeCopy('const n = 1;\n', '已复制', (value) => {
    failed = value;
    return false;
  });
  assert.equal(failed, 'const n = 1;\n');
  assert.equal(kept, '');

  const html = renderToStaticMarkup(React.createElement(host.ChatMarkdownHost, {
    html: FRAME,
    className: 'chat-bubble__md',
    copyLabel: '复制代码',
    copiedLabel: '已复制'
  }));
  assert.match(html, /class="chat-bubble__md"/);
  assert.match(html, /<button type="button" class="chat-md-code__copy" data-md-copy>复制代码<\/button>/);
  assert.equal(html.includes('已复制'), false);
  assert.ok(html.includes('const n = 1;'));
});
