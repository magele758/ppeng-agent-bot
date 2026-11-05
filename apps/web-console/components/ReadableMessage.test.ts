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

const view = loadFile(path.join(here, 'ReadableMessage.tsx')) as {
  ReadableMessage: React.ComponentType<{ text: string; role: string; messageKey?: string }>;
};

test('[AC:chat-reading#AC-5] a long message expands through MarkdownHtml, not a plain pre', () => {
  const tail = 'UNIQUE-TAIL-BEYOND-PREVIEW';
  const text = `${'x'.repeat(4100)}${tail}`;
  assert.ok(text.length > 4000);
  const html = renderToStaticMarkup(React.createElement(view.ReadableMessage, { text, role: 'assistant' }));
  assert.match(html, /chat-bubble__md/);
  assert.match(html, /<button type="button"/);
  assert.match(html, /展开全文/);
  assert.equal(html.includes('long-message__full'), false);
  assert.equal(html.includes(tail), false);

  const source = readFileSync(path.join(here, 'ReadableMessage.tsx'), 'utf8');
  assert.equal(source.includes('long-message__full'), false);
  assert.match(source, /<MarkdownHtml className="chat-bubble__body chat-bubble__md" text=\{expanded \? body : body\.slice\(0, 1600\) \+ '\\n…'\} \/>/);
});
