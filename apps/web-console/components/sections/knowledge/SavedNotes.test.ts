import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../../../lib/i18n/t.ts';
import type { Messages } from '../../../lib/i18n/messages/types.ts';
import { en } from '../../../lib/i18n/messages/en/index.ts';
import { zh } from '../../../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);
const source = readFileSync(new URL('./SavedNotes.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
  fileName: 'SavedNotes.tsx',
}).outputText;

const notes = [
  { title: 'Transformers', file: 'ai/transformers.md', vault: 'Brain', topics: ['ai', 'engineering'] },
  { title: 'Markets', file: 'biz/markets.md', vault: 'Brain', topics: ['business'] },
  { title: 'Compilers', file: 'eng/compilers.md', vault: 'Brain', topics: ['engineering'] },
];

interface HostProps {
  children?: React.ReactNode;
  href?: string;
  role?: string;
  onClick?: () => void;
  'aria-pressed'?: boolean;
}

function hostProps(node: React.ReactElement): HostProps {
  if (!node.props || typeof node.props !== 'object') return {};
  return node.props as HostProps;
}

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf(hostProps(node).children);
  return '';
}

function walk(node: React.ReactNode, visit: (el: React.ReactElement) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(hostProps(node).children, visit);
}

function expand(node: React.ReactNode): React.ReactNode {
  if (Array.isArray(node)) return node.map(child => expand(child));
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === 'function') {
    const render = node.type as (props: unknown) => React.ReactNode;
    return expand(render(node.props));
  }
  return React.cloneElement(node, undefined, expand(hostProps(node).children));
}

function buttons(tree: React.ReactNode) {
  const found: React.ReactElement[] = [];
  walk(tree, el => { if (el.type === 'button') found.push(el); });
  return found;
}

function pressed(tree: React.ReactNode) {
  return buttons(tree).filter(button => hostProps(button)['aria-pressed'] === true);
}

function mount(messages: Messages, notesApi: () => Promise<unknown>) {
  const states: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | undefined;
  const fakeReact = new Proxy(React, {
    get(target, key, receiver) {
      if (key === 'useState') {
        return (init: unknown) => {
          const index = cursor;
          cursor += 1;
          if (states.length <= index) states[index] = typeof init === 'function' ? (init as () => unknown)() : init;
          const setState = (value: unknown) => {
            states[index] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(states[index]) : value;
          };
          return [states[index], setState];
        };
      }
      if (key === 'useEffect') return (fn: () => void | (() => void)) => { effect = fn; };
      return Reflect.get(target, key, receiver);
    },
  });
  const mod = { exports: {} as { SavedNotes?: React.FC } };
  const req = (id: string) => {
    if (id === 'react') return fakeReact;
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
    if (id === '@/lib/api') return { api: () => notesApi() };
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars) }) };
    if (id.endsWith('.css')) return {};
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  const SavedNotes = mod.exports.SavedNotes;
  if (!SavedNotes) throw new Error('SavedNotes export missing');
  const view = () => {
    cursor = 0;
    return expand(React.createElement(SavedNotes));
  };
  const tree = view();
  const stop = effect?.();
  return { view, tree, stop: typeof stop === 'function' ? stop : () => {} };
}

async function flush() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

test('saved notes stay on the loading copy until the request settles', () => {
  const { promise: pending } = Promise.withResolvers<never>();
  for (const [messages, loading, title] of [
    [en, 'Loading…', 'Obsidian save location'],
    [zh, '正在加载…', 'Obsidian 保存位置'],
  ] as const) {
    const { tree } = mount(messages, () => pending);
    const html = renderToStaticMarkup(tree as React.ReactElement);
    assert.match(html, new RegExp(loading));
    const link = html.match(/<a href="([^"]+)">([^<]+)<\/a>/);
    assert.ok(link);
    assert.equal(link[1], '#/settings/integrations');
    assert.equal(link[2], title);
  }
});

test('a rejected notes request shows the alert copy', async () => {
  for (const [messages, failed] of [
    [en, 'Could not load saved notes.'],
    [zh, '无法加载收藏图谱。'],
  ] as const) {
    const pending = Promise.withResolvers<unknown>();
    const { view } = mount(messages, () => pending.promise);
    pending.reject(new Error('offline'));
    await flush();
    const html = renderToStaticMarkup(view() as React.ReactElement);
    assert.match(html, /role="alert"/);
    assert.match(html, new RegExp(failed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('an empty note list shows the empty copy', async () => {
  const pending = Promise.withResolvers<unknown>();
  const { view } = mount(en, () => pending.promise);
  pending.resolve({ notes: [] });
  await flush();
  const html = renderToStaticMarkup(view() as React.ReactElement);
  assert.match(html, /Save a reply to Obsidian to see it by subject here\./);
});

test('the default subject is the first note topic and links open that vault file', async () => {
  const pending = Promise.withResolvers<unknown>();
  const { view } = mount(en, () => pending.promise);
  pending.resolve({ notes });
  await flush();
  const tree = view();
  const html = renderToStaticMarkup(tree as React.ReactElement);
  const selected = pressed(tree);
  assert.equal(selected.length, 1);
  assert.equal(textOf(selected[0]), 'Artificial intelligence · 1');
  assert.match(html, /href="obsidian:\/\/open\?vault=Brain&amp;file=ai%2Ftransformers\.md"/);
  assert.match(html, /Also covered by these notes/);
  assert.equal(buttons(tree).some(button => textOf(button) === 'Software engineering'), true);
  assert.match(html, /Software engineering · 2/);
  assert.match(html, /Business and economics · 1/);
});

test('subject and related buttons change the visible notes', async () => {
  const pending = Promise.withResolvers<unknown>();
  const { view } = mount(en, () => pending.promise);
  pending.resolve({ notes });
  await flush();
  const engineering = buttons(view()).find(button => textOf(button).includes('Software engineering · 2'));
  assert.ok(engineering);
  hostProps(engineering).onClick?.();
  const engineeringTree = view();
  const html = renderToStaticMarkup(engineeringTree as React.ReactElement);
  assert.match(html, /Transformers/);
  assert.match(html, /Compilers/);
  assert.equal(textOf(pressed(engineeringTree)[0]), 'Software engineering · 2');
  const related = buttons(engineeringTree).filter(button => hostProps(button)['aria-pressed'] === undefined);
  assert.deepEqual(related.map(textOf), ['Artificial intelligence']);
  hostProps(related[0]!).onClick?.();
  const back = renderToStaticMarkup(view() as React.ReactElement);
  assert.match(back, /Transformers/);
  assert.doesNotMatch(back, /Compilers/);
  assert.doesNotMatch(back, /Markets/);
  const business = buttons(view()).find(button => textOf(button).includes('Business and economics · 1'));
  assert.ok(business);
  hostProps(business).onClick?.();
  const businessHtml = renderToStaticMarkup(view() as React.ReactElement);
  assert.match(businessHtml, /Markets/);
  assert.doesNotMatch(businessHtml, /Also covered by these notes/);
  assert.doesNotMatch(businessHtml, /Transformers/);
});

test('effect cleanup ignores a late notes response', async () => {
  const resolved = Promise.withResolvers<unknown>();
  const loaded = mount(en, () => resolved.promise);
  loaded.stop();
  resolved.resolve({ notes });
  await flush();
  const afterResolve = renderToStaticMarkup(loaded.view() as React.ReactElement);
  assert.match(afterResolve, /Loading…/);
  assert.doesNotMatch(afterResolve, /Transformers/);
  assert.doesNotMatch(afterResolve, /role="alert"/);
  const rejected = Promise.withResolvers<unknown>();
  const failed = mount(en, () => rejected.promise);
  failed.stop();
  rejected.reject(new Error('late'));
  await flush();
  const afterReject = renderToStaticMarkup(failed.view() as React.ReactElement);
  assert.match(afterReject, /Loading…/);
  assert.doesNotMatch(afterReject, /role="alert"/);
});
