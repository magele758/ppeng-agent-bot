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
  ChatTurnIfVisible: React.ComponentType<Record<string, unknown>>;
};
const relay = loadFile(path.join(here, 'BotRelayStrip.tsx')) as {
  BotRelayDialog: React.ComponentType<Record<string, unknown>>;
};
const { parseBotRelayMessage } = loadFile(path.join(webRoot, 'lib/bot-relay-message.ts')) as {
  parseBotRelayMessage: (role: string, text: string) => unknown;
};

const DETAIL = '第二部分：请对照基线逐条核对实验设置并给出改进建议';
const TASK = `Message from 科研小助手 / bot_367eca0123abcd: Delegated task btask_9f8e7d: 请评估这篇论文的实验设计\n\n${DETAIL}\nReport the concrete result; this execution is tracked automatically.`;

function renderTurn(role: string, text: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    React.createElement(ui.ChatTurnIfVisible, {
      m: { id: 'msg-relay', role, parts: [{ type: 'text', text }] },
      sessionId: 'sess-relay',
      ...extra
    })
  );
}

test('委派任务只显示紧凑通信条 [AC:bot-relay-strip#AC-3] [AC:bot-relay-island#AC-1]', () => {
  const html = renderTurn('user', TASK);
  assert.match(html, /data-testid="bot-relay-strip"/);
  assert.match(html, /科研小助手/);
  assert.match(html, /委派任务/);
  assert.doesNotMatch(html, /请评估这篇论文的实验设计/);
  assert.equal(html.includes(DETAIL), false);
  assert.equal(html.includes('bot_367eca'), false);
  assert.equal(html.includes('btask_9f8e7d'), false);
  assert.equal(html.includes('Report the concrete result'), false);
  const model = renderTurn('user', TASK, { modelView: true });
  assert.equal(model.includes('bot-relay-strip'), false);
  assert.ok(model.includes(DETAIL));
});

test('弹窗以 Markdown 展示完整原文并可访问 [AC:bot-relay-strip#AC-4]', () => {
  const html = renderToStaticMarkup(
    React.createElement(relay.BotRelayDialog, { relay: parseBotRelayMessage('user', TASK), onClose: () => undefined })
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<button type="button"[^>]*>关闭<\/button>/);
  assert.ok(html.includes(DETAIL));
  assert.ok(html.includes('Report the concrete result'));
  assert.match(html, /chat-bubble__md/);
});

test('普通用户消息不受影响 [AC:bot-relay-strip#AC-5]', () => {
  const text = `请帮我总结：\n\n${DETAIL}`;
  const html = renderTurn('user', text);
  assert.equal(html.includes('bot-relay-strip'), false);
  assert.ok(html.includes(DETAIL));
});
