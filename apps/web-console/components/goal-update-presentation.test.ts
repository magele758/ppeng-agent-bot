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

const VERIFY_REASON = 'Completion verification unavailable; evidence retained for review';
const NUDGE_TELL = 'Briefly tell the user this meaningful change.';
const NUDGE_RESTART = 'Do not restart this goal or treat this notification as a new user task.';
const GOAL_ID = 'goal_84377e09-043c-4a93-86de-3e834e1678be';
const CURRENT = 'sess-current';
const OTHER = 'sess-other';

type Role = 'user' | 'assistant' | 'tool' | 'system';
type Turn = { role: Role; text: string; sessionId?: string };

function goalUpdateText(fields: {
  id: string;
  title: string;
  status: string;
  progress?: string;
  reason?: string;
  nextStep?: string;
}): string {
  const payload: Record<string, string> = { id: fields.id, title: fields.title, status: fields.status };
  if (fields.progress !== undefined) payload.progress = fields.progress;
  if (fields.reason !== undefined) payload.reason = fields.reason;
  if (fields.nextStep !== undefined) payload.nextStep = fields.nextStep;
  return `[goal update] ${JSON.stringify(payload)}\n${NUDGE_TELL} ${NUDGE_RESTART}`;
}

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
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx'), path.join(request, 'index.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
    if (candidate.endsWith('.css') && existsSync(candidate)) return candidate;
  }
  const css = candidates.find((candidate) => candidate.endsWith('.css'));
  if (css && existsSync(css)) return css;
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = loaded.get(resolved);
  if (cached) return cached;
  if (resolved.endsWith('.css')) return {};
  const source = readFileSync(resolved, 'utf8');
  const compiled = ts.transpileModule(source, {
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
  if (id.endsWith('.css')) return new Proxy({}, { get: (_target, prop) => String(prop) });
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)));
  return localRequire(id);
}

const ui = loadFile(path.join(here, 'ChatTurns.tsx')) as {
  ChatTurnPlain: React.ComponentType<Record<string, unknown>>;
  ChatTurnFromMessage: React.ComponentType<Record<string, unknown>>;
};

function renderTurns(turns: readonly Turn[], conversationId: string): string {
  return renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-testid': 'conversation' },
      turns.map((turn, index) =>
        React.createElement(ui.ChatTurnPlain, {
          key: String(index),
          role: turn.role,
          text: turn.text,
          messageSessionId: turn.sessionId,
          conversationId
        })
      )
    )
  );
}

function textOf(html: string, testId: string): string {
  const match = new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)<`).exec(html);
  assert.ok(match, `missing ${testId} in ${html}`);
  return match[1] ?? '';
}

function cards(html: string): string[] {
  return [...html.matchAll(/<article\b[^>]*data-testid="goal-update-card"[^>]*>[\s\S]*?<\/article>/g)].map((match) => match[0]);
}

const blockedNotice = goalUpdateText({
  id: GOAL_ID,
  title: '可以考虑让bo',
  status: 'blocked',
  progress: 'probe-progress-9f3a',
  reason: VERIFY_REASON,
  nextStep: 'probe-next-step-9f3a'
});

test('目标更新通知不展示，助手回复与其它系统通知照常 [AC:goal-update-hidden#AC-1] [AC:goal-update-hidden#AC-2]', () => {
  const html = renderTurns(
    [
      { role: 'user', text: '请把结论写短一点', sessionId: CURRENT },
      { role: 'system', text: blockedNotice, sessionId: CURRENT },
      { role: 'system', text: blockedNotice, sessionId: OTHER },
      { role: 'assistant', text: '好，我改成三句话。', sessionId: CURRENT },
      { role: 'system', text: '[recovery] Stopped: test-only', sessionId: CURRENT }
    ],
    CURRENT
  );
  for (const gone of ['goal-update-card', '[goal update]', '可以考虑让bo', 'probe-progress-9f3a', NUDGE_TELL]) {
    assert.equal(html.includes(gone), false, gone);
  }
  assert.match(html, /请把结论写短一点/);
  assert.match(html, /好，我改成三句话。/);
  assert.match(html, /data-kind="stopped"/);
  assert.equal(html.split('<details').length - 1, 1);
  const message = { role: 'system', parts: [{ type: 'text', text: blockedNotice }] };
  const hist = renderToStaticMarkup(React.createElement(ui.ChatTurnFromMessage, { m: message, sessionId: CURRENT }));
  assert.equal(hist.includes('chat-turn'), false);
});

test('system cards cover immediate, historical, mixed and model-view text [AC:system-message-ui#AC-1] [AC:system-message-ui#AC-3]', () => {
  const text = '[recovery] Stopped: test-only';
  const immediate = renderTurns([{ role: 'system', text, sessionId: CURRENT }], CURRENT);
  assert.match(immediate, /data-kind="stopped"/);
  const message = { role: 'system', parts: [{ type: 'text', text }] };
  const render = (m: unknown, modelView = false) => renderToStaticMarkup(React.createElement(ui.ChatTurnFromMessage, { m, sessionId: CURRENT, modelView }));
  assert.match(render(message), /data-kind="stopped"/);
  assert.doesNotMatch(render(message, true), /data-testid="system-notice-card"/);
  assert.match(render(message, true), /chat-bubble__pre/);
  const mixed = render({ role: 'system', parts: [{ type: 'text', text }, { type: 'tool_result', toolCallId: 'synthetic-call', name: 'example', content: 'PRESERVED_TOOL_RESULT', isError: false }] });
  assert.match(mixed, /data-kind="stopped"/);
  assert.match(mixed, /PRESERVED_TOOL_RESULT/);
  assert.doesNotMatch(renderTurns([{ role: 'user', text }], CURRENT), /data-testid="system-notice-card"/);
});
