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

const ui = loadFile(path.join(here, 'ChatTurns.tsx')) as {
  ChatTurnFromMessage: React.ComponentType<Record<string, unknown>>;
};

function renderTurn(role: string, text: string, key?: string): string {
  return renderToStaticMarkup(
    React.createElement(ui.ChatTurnFromMessage, {
      m: { id: 'msg-routine', role, parts: [{ type: 'text', text }], ...(key ? { key } : {}) },
      sessionId: 'sess-routine'
    })
  );
}

test('已写入主对话的无结论定时回执不再显示 [AC:routine-quiet-chat#AC-2]', () => {
  const narration = '定时任务醒了。我只核对 omp 这两分钟有没有新结论。';
  for (const body of [`${narration}\n[NO_UPDATE]`, `${narration} [NO_UPDATE]`]) {
    const html = renderTurn(
      'assistant',
      `[routine:盯流式重复修复] completed\n${body}\nRun: run_1 · /api/sessions/child`,
      'routine-result:run_1'
    );
    assert.equal(html.includes('routine-result-card'), false);
    assert.equal(html.includes('定时任务醒了'), false);
    assert.equal(html.includes('盯流式重复修复'), false);
  }
  const found = renderTurn(
    'assistant',
    '[routine:提醒] completed\nHello\nRun: routine_run_abc · /api/sessions/child',
    'routine-result:routine_run_abc'
  );
  assert.match(found, /routine-result-card/);
  assert.match(found, /提醒/);
  assert.match(found, /Hello/);
  const mention = renderTurn('assistant', '流式重复已经停了。说明里出现过 [NO_UPDATE] 这个词，但这次有结论。');
  assert.match(mention, /\[NO_UPDATE\]/);
  assert.match(mention, /这次有结论/);
  const lookalike = renderTurn('user', '[routine:我只是输入了这个字符串] completed Hello');
  assert.match(lookalike, /我只是输入了这个字符串/);
});
