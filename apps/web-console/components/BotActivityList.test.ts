import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import type { Messages } from '../lib/i18n/messages/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
let messages: Messages = zh;

const i18n = {
  useI18n: () => ({
    locale: messages === en ? 'en' : 'zh',
    t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars)
  })
};

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`];
  for (const candidate of candidates) {
    try {
      if (readFileSync(candidate)) return candidate;
    } catch {
      // try the next suffix
    }
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
    if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18n;
    if (id === '@/components/shell/LabProvider') return { useLab: () => ({ openSession: () => undefined }) };
    if (id.endsWith('.css')) return {};
    if (id.startsWith('@/')) return loadModule(resolveFile(path.join(webRoot, id.slice(2))));
    if (id.startsWith('.')) return loadModule(resolveFile(path.resolve(path.dirname(resolved), id)));
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

const loaded = new Map<string, Record<string, unknown>>();
function loadModule(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = loaded.get(resolved);
  if (cached) return cached;
  const mod = loadFile(resolved);
  loaded.set(resolved, mod);
  return mod;
}

const ui = loadModule(path.join(here, 'BotActivityList.tsx')) as {
  BotActivityRow: React.ComponentType<Record<string, unknown>>;
  BotActivityCardView: (props: Record<string, unknown>) => React.ReactElement;
};

const title = 'grok --prompt-file plan.md';
const started = '开始于 10月16日 19:50';

function item(sessionId?: string) {
  return {
    id: 'job:bg',
    title,
    status: 'done',
    outcomeStatus: 'completed',
    botId: 'ada',
    botName: 'Ada',
    startedAt: '2026-10-16T11:50:00.000Z',
    ...(sessionId ? { sessionId } : {})
  };
}

function renderRow(localeMessages: Messages, sessionId?: string): string {
  messages = localeMessages;
  return renderToStaticMarkup(React.createElement(ui.BotActivityRow, {
    item: item(sessionId),
    started,
    onOpenSession: () => undefined
  }));
}

function buttons(node: unknown, found: Array<{ props: Record<string, unknown> }> = []): Array<{ props: Record<string, unknown> }> {
  if (!node || typeof node !== 'object') return found;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === 'button' && el.props) found.push({ props: el.props });
  const children = el.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) buttons(child, found);
  } else {
    buttons(children, found);
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buttonHtml(html: string): string {
  const match = /<button\b[^>]*>[\s\S]*?<\/button>/.exec(html);
  assert.ok(match, html);
  return match[0];
}

test('a card with a session opens that session from the whole card [AC:bot-activity-open-session#AC-1] [AC:bot-activity-open-session#AC-3]', () => {
  const zhHtml = renderRow(zh, 'child-grok');
  const zhButton = buttonHtml(zhHtml);
  const zhName = translate(zh, 'play.activity.workOpenSession', {
    status: translate(zh, 'botWork.states.completed'),
    title
  });
  assert.match(zhButton, /type="button"/);
  assert.equal(zhButton.includes('tabindex="-1"'), false);
  assert.match(zhButton, /class="bot-activity__open"/);
  assert.match(zhButton, /data-session-id="child-grok"/);
  assert.match(zhButton, new RegExp(`aria-label="${escapeRegExp(zhName)}"`));
  assert.match(zhButton, /已完成/);
  assert.match(zhButton, new RegExp(escapeRegExp(title)));
  assert.equal(zhHtml.includes('data-session-id="focus"'), false);
  assert.equal(zhHtml.includes('data-session-id="job:bg"'), false);

  const enHtml = renderRow(en, 'child-grok');
  const enName = translate(en, 'play.activity.workOpenSession', {
    status: translate(en, 'botWork.states.completed'),
    title
  });
  assert.match(buttonHtml(enHtml), new RegExp(`aria-label="${escapeRegExp(enName)}"`));
  assert.notEqual(zhName, enName);

  const calls: Array<{ id: string; opts?: { focusChat?: boolean } }> = [];
  const element = ui.BotActivityCardView({
    item: item('child-grok'),
    started,
    statusLabel: '已完成',
    phaseStatus: 'completed',
    phaseStyle: {},
    openLabel: zhName,
    onOpenSession: (id: string, opts?: { focusChat?: boolean }) => calls.push({ id, opts })
  });
  const [button] = buttons(element);
  assert.equal(button?.props.type, 'button');
  assert.equal(button?.props.tabIndex, undefined);
  assert.equal(typeof button?.props.onClick, 'function');
  (button?.props.onClick as () => void)();
  assert.deepEqual(calls, [{ id: 'child-grok', opts: { focusChat: true } }]);
  assert.notEqual(calls[0]?.id, 'focus');

  const css = readFileSync(path.join(webRoot, 'app/globals.css'), 'utf8');
  assert.match(css, /\.bot-activity__row \{ cursor: default; \}/);
  assert.match(css, /button\.bot-activity__open \{[^}]*cursor: pointer;/s);
  assert.match(css, /button\.bot-activity__open \.bot-activity__row \{ cursor: pointer; \}/);
});

test('a card without a session is not a control [AC:bot-activity-open-session#AC-2]', () => {
  for (const sessionId of [undefined, '   ']) {
    const html = renderRow(zh, sessionId);
    assert.equal(html.includes('<button'), false);
    assert.equal(html.includes('bot-activity__open'), false);
    assert.equal(html.includes('data-session-id'), false);
    assert.match(html, /class="activity-card__summary bot-activity__row"/);
    assert.match(html, /aria-label="已完成 grok --prompt-file plan.md"/);
  }
  const calls: string[] = [];
  const element = ui.BotActivityCardView({
    item: item(undefined),
    started,
    statusLabel: '已完成',
    phaseStatus: 'completed',
    phaseStyle: {},
    openLabel: 'unused',
    onOpenSession: (id: string) => calls.push(id)
  });
  assert.equal(buttons(element).length, 0);
  assert.deepEqual(calls, []);
});
