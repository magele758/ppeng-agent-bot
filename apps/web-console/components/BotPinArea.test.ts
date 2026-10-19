import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { BotInfo, SessionSummary } from '../lib/types.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { en } from '../lib/i18n/messages/en/index.ts';

const localRequire = createRequire(import.meta.url);
const copy: Record<string, string> = {
  'play.pin.title': zh.play.pin.title,
  'play.pin.empty': zh.play.pin.empty,
  'play.pin.hint': zh.play.pin.hint
};

function loadComponent(messages: Record<string, string>, clientStore: boolean) {
  const source = readFileSync(new URL('./BotPinArea.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  } }).outputText;
  const mod = { exports: {} as { BotPinArea?: React.ComponentType<Record<string, unknown>> } };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') {
      return clientStore
        ? { ...React, useSyncExternalStore: (_subscribe: unknown, getClient: () => unknown) => getClient() }
        : React;
    }
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => messages[key] ?? key }) };
    if (id === '@/lib/bots') return localRequire('../lib/bots.ts');
    if (id === '@/lib/bot-pin-area') return localRequire('../lib/bot-pin-area.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports.BotPinArea!;
}

const bots = [
  { id: 'super', name: 'Super Bot', canonicalSessionId: 'sess-super', hidden: false, builtin: true },
  { id: 'desk', name: 'DeskBot', canonicalSessionId: 'sess-desk', hidden: false },
  { id: 'blank', name: '  ', canonicalSessionId: 'sess-blank', hidden: false }
] as unknown as BotInfo[];
const sessions = [
  { id: 'sess-super' },
  { id: 'sess-desk' },
  { id: 'room-1' }
] as SessionSummary[];

function render(messages: Record<string, string>, clientStore: boolean) {
  const BotPinArea = loadComponent(messages, clientStore);
  return renderToStaticMarkup(React.createElement(BotPinArea, {
    bots,
    sessions,
    renderSession: (session: SessionSummary) => React.createElement('button', { type: 'button', 'data-session-id': session.id }, session.id),
    onOpenSession: () => undefined
  }));
}

test('default pin area shows Super Bot in its original conversation [AC:bot-pin-area#AC-1] [AC:bot-pin-area#AC-3] [AC:bot-pin-area#AC-5]', () => {
  const html = render(copy, false);
  assert.match(html, /data-testid="bot-pin-area"/);
  assert.match(html, /data-testid="bot-pin-item"/);
  assert.match(html, /data-bot-id="super"/);
  assert.match(html, /data-bot-name="Super Bot"/);
  assert.match(html, /data-session-id="sess-super"/);
  assert.equal(html.includes('data-session-id="room-1"'), false);
  assert.equal(html.includes('data-session-id="sess-desk"'), false);
  assert.match(html, new RegExp(zh.play.pin.title));
  assert.match(html, new RegExp(zh.play.pin.hint));
  assert.equal(html.includes('/open'), false);
  const source = readFileSync(new URL('./BotPinArea.tsx', import.meta.url), 'utf8');
  assert.equal(source.includes('/open'), false);
  assert.equal(source.includes('functional-group'), false);
});

test('a customized empty pin area shows localized empty copy and no nameless item [AC:bot-pin-area#AC-6] [AC:bot-pin-area#AC-7]', () => {
  const previous = globalThis.localStorage;
  const data = new Map<string, string>([['lab.botPins', JSON.stringify({ customized: true, ids: ['blank', 'missing', ''] })]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); }
    }
  });
  try {
    const html = render(copy, true);
    assert.equal(html.includes('data-testid="bot-pin-item"'), false);
    assert.match(html, new RegExp(zh.play.pin.empty));
    assert.equal(html.includes('data-bot-name=""'), false);
    const english = render({
      'play.pin.title': en.play.pin.title,
      'play.pin.empty': en.play.pin.empty,
      'play.pin.hint': en.play.pin.hint
    }, true);
    assert.match(english, new RegExp(en.play.pin.title));
    assert.match(english, new RegExp(en.play.pin.empty));
    assert.equal(english.includes(zh.play.pin.empty), false);
    assert.equal(html.includes(en.play.pin.empty), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
