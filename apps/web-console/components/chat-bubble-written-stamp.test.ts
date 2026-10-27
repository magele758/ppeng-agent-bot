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

const STAMP = '[written 2026-10-27 17:29 Asia/Shanghai]';
const BODY = '文件结构和用户消息的位置对上了。我按会话抽出今天的标题和用户原话。';

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

function renderBubble(parts: unknown[]): string {
  return renderToStaticMarkup(
    React.createElement(ui.ChatTurnFromMessage, {
      m: { id: 'msg-written', role: 'assistant', parts },
      sessionId: 'sess-written'
    })
  );
}

test('气泡不展示 [written … Asia/Shanghai] 这种行，正文其余部分还在 [AC:chat-bubble-written-stamp#AC-1]', () => {
  const stored = `${STAMP}\n${BODY}\n`;
  const html = renderBubble([
    { type: 'text', text: stored },
    { type: 'tool_call', toolCallId: 'call-1', name: 'bash', input: { command: 'pwd' } }
  ]);
  assert.equal(stored.includes(STAMP), true);
  assert.equal(html.includes('[written'), false);
  assert.equal(html.includes('Asia/Shanghai'), false);
  assert.match(html, /chat-bubble__md/);
  assert.match(html, /文件结构和用户消息的位置对上了/);
  assert.match(html, /我按会话抽出今天的标题和用户原话/);
  assert.match(html, /纠错转评测/);
  assert.match(html, /chat-tool-fold/);
  assert.match(html, />bash</);
});

test('正文中间的写入时间和会话时钟行也不进气泡 [AC:chat-bubble-written-stamp#AC-2]', () => {
  const first = 'Grok 的用户原话被系统提示淹没了。我把标题补上。';
  const clock = '[conversation-clock] Current time: 2026-10-27 17:29 Tuesday (Asia/Shanghai). This is the only current date.';
  const html = renderBubble([
    { type: 'text', text: `${first}\n\n${STAMP}\n${first}\n${clock}\n收尾还在。` }
  ]);
  assert.equal(html.includes('[written'), false);
  assert.equal(html.includes('[conversation-clock]'), false);
  assert.equal(html.includes('Current time:'), false);
  assert.equal(html.split(first).length - 1, 2);
  assert.match(html, /收尾还在/);
});

test('提到时区或别的方括号标记时气泡仍显示原文 [AC:chat-bubble-written-stamp#AC-3]', () => {
  const prose = '今天的时区是 Asia/Shanghai，不是写入标记。\n[NO_UPDATE]\n句子里提到 [written note] 但不是时间戳。';
  const html = renderBubble([{ type: 'text', text: prose }]);
  assert.match(html, /Asia\/Shanghai/);
  assert.match(html, /\[NO_UPDATE\]/);
  assert.match(html, /\[written note\]/);
});
