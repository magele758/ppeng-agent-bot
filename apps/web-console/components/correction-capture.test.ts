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
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
const cssPath = path.join(here, 'correction-capture.css');

type Locale = 'zh' | 'en';
const catalogs = { zh, en } as const;

function i18nFor(locale: Locale) {
  const messages = catalogs[locale];
  return {
    useI18n: () => ({
      locale,
      messages,
      setLocale: () => undefined,
      t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars)
    })
  };
}

const loaded = new Map<string, Record<string, unknown>>();

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
  }
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string, locale: Locale): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cacheKey = `${locale}:${resolved}`;
  const cached = loaded.get(cacheKey);
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
  loaded.set(cacheKey, mod.exports);
  const requireFrom = (id: string) => requireId(resolved, id, locale);
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

function requireId(fromFile: string, id: string, locale: Locale): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
  if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18nFor(locale);
  if (id.endsWith('.css')) return {};
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))), locale);
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)), locale);
  return localRequire(id);
}

function turns(locale: Locale = 'zh') {
  return loadFile(path.join(here, 'ChatTurns.tsx'), locale) as {
    ChatTurnFromMessage: React.ComponentType<Record<string, unknown>>;
    ChatTurnPlain: React.ComponentType<Record<string, unknown>>;
    ChatTurnStreaming: React.ComponentType<Record<string, unknown>>;
  };
}

function renderTurn(props: Record<string, unknown>, locale: Locale = 'zh'): string {
  return renderToStaticMarkup(React.createElement(turns(locale).ChatTurnFromMessage, props));
}

function assistantHtml(locale: Locale = 'zh'): string {
  return renderTurn({
    m: { id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: '已经答完。' }] },
    sessionId: 'sess-done'
  }, locale);
}

function triggerMarkup(html: string): string {
  const match = html.match(/<button\b[^>]*correction-capture__trigger[^>]*>[\s\S]*?<\/button>/);
  assert.ok(match, html);
  return match[0];
}

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

test('默认不展示文字按钮 [AC:correction-capture-hover#AC-1]', () => {
  const html = assistantHtml();
  const button = triggerMarkup(html);
  assert.equal(button.includes('>纠错转评测<'), false);
  assert.equal(/>\s*纠错转评测\s*</.test(button), false);
  assert.doesNotMatch(html, /<button\b[^>]*>\s*纠错转评测\s*<\/button>/);
  const css = readFileSync(cssPath, 'utf8');
  const hidden = cssRules(css).filter((rule) =>
    rule.selector.includes('.correction-capture__trigger') &&
    !rule.selector.includes(':hover') &&
    !rule.selector.includes(':focus'));
  assert.ok(hidden.some((rule) => /position:\s*absolute/.test(rule.body) && /opacity:\s*0/.test(rule.body)));
});

test('悬停或聚焦才出现图标 [AC:correction-capture-hover#AC-2]', () => {
  const zhHtml = assistantHtml('zh');
  const enHtml = assistantHtml('en');
  const zhButton = triggerMarkup(zhHtml);
  const enButton = triggerMarkup(enHtml);
  assert.match(zhHtml, /class="chat-bubble[\s\S]*chat-turn__actions[\s\S]*correction-capture__trigger/);
  assert.match(zhButton, /aria-label="纠错转评测"/);
  assert.match(enButton, /aria-label="Capture correction"/);
  assert.match(zhButton, /<svg[\s\S]*aria-hidden="true"/);
  assert.equal(zhButton.includes('>纠错转评测<'), false);
  assert.equal(enButton.includes('>Capture correction<'), false);
  const source = readFileSync(path.join(here, 'LearningWorkbench.tsx'), 'utf8');
  const capture = source.slice(source.indexOf('export function CorrectionCapture'), source.indexOf('type Report'));
  assert.match(capture, /aria-label=\{t\('learning\.capture'\)\}/);
  assert.equal(capture.includes('纠错转评测'), false);
  assert.equal(capture.includes('Capture correction'), false);
  const rules = cssRules(readFileSync(cssPath, 'utf8'));
  const reveal = rules.find((rule) =>
    rule.selector.includes('.chat-turn:hover') &&
    rule.selector.includes('.chat-turn:focus-within') &&
    rule.selector.includes('.correction-capture__trigger') &&
    /opacity:\s*1/.test(rule.body));
  assert.ok(reveal);
  for (const rule of rules) {
    if (/opacity:\s*1/.test(rule.body)) assert.match(rule.selector, /:hover|:focus-within|:focus-visible/);
  }
});

type HookSlot = {
  begin(): void;
  useState<T>(init: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
};

function createHooks(): HookSlot {
  const state: unknown[] = [];
  let cursor = 0;
  return {
    begin() { cursor = 0; },
    useState(init) {
      const index = cursor;
      cursor += 1;
      if (!Object.hasOwn(state, index)) state[index] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [state[index] as never, (value) => {
        state[index] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(state[index]) : value;
      }];
    }
  };
}

const hookSlot: { current: HookSlot | null } = { current: null };

function loadCapture(api: (path: string, init?: { method?: string; body?: string }) => Promise<unknown>) {
  const source = readFileSync(path.join(here, 'LearningWorkbench.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as { CorrectionCapture: React.ComponentType<Record<string, unknown>> } };
  const reactMod = new Proxy(React, {
    get(target, key) {
      if (key === 'useState') return (init: unknown) => hookSlot.current!.useState(init as never);
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return reactMod;
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
    if (id === '@/lib/i18n') return i18nFor('zh');
    if (id === '@/lib/api') return { api };
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports;
}

function paintCapture(ui: { CorrectionCapture: React.ComponentType<{ sessionId: string; messageId: string }> }, hooks: HookSlot) {
  hookSlot.current = hooks;
  hooks.begin();
  return ui.CorrectionCapture({ sessionId: 'sess-1', messageId: 'msg-9' });
}

function walk(node: unknown, visit: (element: { type?: unknown; props?: Record<string, unknown> }) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  visit(element);
  walk(element.props?.children, visit);
}

function collect(node: unknown, match: (element: { type?: unknown; props?: Record<string, unknown> }) => boolean) {
  const found: Array<{ type?: unknown; props?: Record<string, unknown> }> = [];
  walk(node, (element) => { if (match(element)) found.push(element); });
  return found;
}

test('点开仍是原表单 [AC:correction-capture-hover#AC-3]', async () => {
  const calls: Array<{ path: string; init?: { method?: string; body?: string } }> = [];
  const ui = loadCapture(async (path, init) => {
    calls.push({ path, init });
    return {};
  });
  const hooks = createHooks();
  let tree = paintCapture(ui, hooks);
  const trigger = collect(tree, (element) => String(element.props?.className ?? '').includes('correction-capture__trigger'))[0];
  assert.ok(trigger?.props?.onClick);
  (trigger.props.onClick as () => void)();
  tree = paintCapture(ui, hooks);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /<details[^>]*\sopen/);
  assert.match(html, /纠错转评测/);
  assert.match(html, /选择明确的期望与禁止行为/);
  assert.match(html, /应包含的文字/);
  assert.match(html, /禁止出现的文字/);
  assert.match(html, /禁止调用的工具/);
  assert.match(html, /反例任务文本（可选）/);
  assert.match(html, /aria-label="案例类型"/);
  assert.match(html, /原任务回归/);
  assert.match(html, />反例</);
  assert.match(html, />保存</);
  assert.match(html, /role="status"/);
  const fields = ['要有结论\n要引用', '不要道歉', 'bash', '改写成短句'];
  for (const [index, value] of fields.entries()) {
    const areas = collect(tree, (element) => element.type === 'textarea');
    const onChange = areas[index]?.props?.onChange as ((event: { target: { value: string } }) => void) | undefined;
    assert.ok(onChange);
    onChange({ target: { value } });
    tree = paintCapture(ui, hooks);
  }
  const select = collect(tree, (element) => element.type === 'select')[0];
  (select.props?.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'counterexample' } });
  tree = paintCapture(ui, hooks);
  const save = collect(tree, (element) => element.type === 'button' && element.props?.children === '保存')[0];
  assert.ok(save?.props?.onClick);
  (save.props.onClick as () => void)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/sessions/sess-1/learning');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    action: 'capture',
    messageId: 'msg-9',
    expected: ['要有结论', '要引用'],
    forbiddenText: ['不要道歉'],
    forbiddenTools: ['bash'],
    prompt: '改写成短句',
    kind: 'counterexample'
  });
});

test('用户消息和正在输出的消息没有这个入口 [AC:correction-capture-hover#AC-4]', () => {
  const ui = turns();
  const user = renderToStaticMarkup(React.createElement(ui.ChatTurnFromMessage, {
    m: { id: 'msg-user', role: 'user', parts: [{ type: 'text', text: '你好' }] },
    sessionId: 'sess-done'
  }));
  const streaming = renderToStaticMarkup(React.createElement(ui.ChatTurnStreaming, {
    segments: [{ kind: 'text', id: 'seg-1', raw: '还在写', html: '还在写' }],
    sessionId: 'sess-done',
    typing: true
  }));
  const held = renderToStaticMarkup(React.createElement(ui.ChatTurnPlain, {
    role: 'assistant',
    text: '还没落成回复'
  }));
  for (const html of [user, streaming, held]) {
    assert.equal(html.includes('correction-capture__trigger'), false);
    assert.equal(html.includes('纠错转评测'), false);
    assert.equal(html.includes('learning.capture'), false);
  }
});

test('省略标题的助手消息仍保留操作按钮 [AC:assistant-label-dedupe#AC-3]', () => {
  const props = {
    m: { id: 'msg-done', role: 'assistant', parts: [{ type: 'text', text: '已经答完。' }] },
    sessionId: 'sess-done'
  };
  assert.ok(renderTurn(props).includes('助手'));
  const html = renderTurn({ ...props, hideRoleLabel: true });
  assert.equal(html.includes('>助手'), false);
  assert.ok(html.includes('correction-capture__trigger'));
});
