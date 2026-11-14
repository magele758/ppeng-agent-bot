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
const source = readFileSync(new URL('./ObsidianSettings.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
  fileName: 'ObsidianSettings.tsx',
}).outputText;

interface HostProps {
  children?: React.ReactNode;
  disabled?: boolean;
  value?: string;
  placeholder?: string;
  role?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => void;
}

interface Call { path: string; init?: { method?: string; body?: string } }

function hostProps(node: React.ReactElement): HostProps {
  if (!node.props || typeof node.props !== 'object') return {};
  return node.props as HostProps;
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

function first(tree: React.ReactNode, type: string) {
  let found: React.ReactElement | undefined;
  walk(tree, el => { if (!found && el.type === type) found = el; });
  if (!found) throw new Error(`missing ${type}`);
  return found;
}

function SettingsGroup(props: { title: string; description?: string; children?: React.ReactNode }) {
  return React.createElement('section', { 'aria-label': props.title },
    React.createElement('h2', null, props.title),
    React.createElement('p', null, props.description),
    props.children);
}

function mount(messages: Messages) {
  const states: unknown[] = [];
  let cursor = 0;
  let effect: (() => void | (() => void)) | undefined;
  const calls: Call[] = [];
  let loadApi: () => Promise<unknown> = () => Promise.withResolvers<unknown>().promise;
  let saveApi: (init: { method?: string; body?: string }) => Promise<unknown> = () => Promise.withResolvers<unknown>().promise;
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
  const mod = { exports: {} as { ObsidianSettings?: React.FC } };
  const req = (id: string) => {
    if (id === 'react') return fakeReact;
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
    if (id === '@/lib/api') {
      return {
        api: (path: string, init?: { method?: string; body?: string }) => {
          calls.push({ path, init });
          if (init?.method === 'PATCH') return saveApi(init);
          return loadApi();
        },
      };
    }
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars) }) };
    if (id === '../../ui') return { SettingsGroup };
    if (id.endsWith('.css')) return {};
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  const ObsidianSettings = mod.exports.ObsidianSettings;
  if (!ObsidianSettings) throw new Error('ObsidianSettings export missing');
  const view = () => {
    cursor = 0;
    return expand(React.createElement(ObsidianSettings));
  };
  const tree = view();
  return {
    calls,
    view,
    tree,
    start() {
      const stop = effect?.();
      return typeof stop === 'function' ? stop : () => {};
    },
    setLoad(next: () => Promise<unknown>) { loadApi = next; },
    setSave(next: (init: { method?: string; body?: string }) => Promise<unknown>) { saveApi = next; },
  };
}

async function flush() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function controls(tree: React.ReactNode) {
  return { input: first(tree, 'input'), button: first(tree, 'button'), form: first(tree, 'form') };
}

async function loadVault(messages: Messages, value: unknown) {
  const pending = Promise.withResolvers<unknown>();
  const harness = mount(messages);
  harness.setLoad(() => pending.promise);
  harness.start();
  pending.resolve(value);
  await flush();
  return harness;
}

test('vault controls stay disabled until settings load', () => {
  for (const [messages, title, help, placeholder] of [
    [en, 'Obsidian save location', 'Enter the Obsidian vault root on the computer running Lab. Clear and save to restore automatic detection.', 'Detect the active vault'],
    [zh, 'Obsidian 保存位置', '填写运行 Lab 的电脑上的 Obsidian 库根目录。留空并保存可恢复自动识别。', '自动识别当前库'],
  ] as const) {
    const harness = mount(messages);
    harness.start();
    const html = renderToStaticMarkup(harness.tree as React.ReactElement);
    const { input, button } = controls(harness.tree);
    assert.equal(hostProps(input).disabled, true);
    assert.equal(hostProps(button).disabled, true);
    assert.equal(hostProps(input).placeholder, placeholder);
    assert.equal(html.includes('Current destination'), false);
    assert.equal(html.includes('当前收藏写入目录'), false);
    assert.equal(html.includes(title), true);
    assert.equal(html.includes(help), true);
  }
});

test('a loaded vault enables the form and shows the destination', async () => {
  for (const [messages, destination] of [[en, 'Current destination'], [zh, '当前收藏写入目录']] as const) {
    const harness = await loadVault(messages, { configuredPath: '/vaults/Brain', destination: '/vaults/Brain/Lab' });
    const tree = harness.view();
    const html = renderToStaticMarkup(tree as React.ReactElement);
    const { input, button } = controls(tree);
    assert.equal(hostProps(input).disabled, false);
    assert.equal(hostProps(button).disabled, false);
    assert.equal(hostProps(input).value, '/vaults/Brain');
    assert.equal(html.includes(destination), true);
    assert.equal(html.includes('/vaults/Brain/Lab'), true);
  }
});

test('an empty destination shows the missing-vault copy and still enables the form', async () => {
  for (const [messages, missing] of [[en, 'No vault detected'], [zh, '尚未找到 Obsidian 库']] as const) {
    const harness = await loadVault(messages, { configuredPath: '', destination: '' });
    const tree = harness.view();
    const html = renderToStaticMarkup(tree as React.ReactElement);
    const { input, button } = controls(tree);
    assert.equal(hostProps(input).disabled, false);
    assert.equal(hostProps(button).disabled, false);
    assert.equal(html.includes(missing), true);
  }
});

test('a rejected settings load keeps the form locked and shows the failed copy', async () => {
  for (const [messages, failed] of [
    [en, 'Could not read or save Obsidian settings.'],
    [zh, '无法读取或保存 Obsidian 设置。'],
  ] as const) {
    const pending = Promise.withResolvers<unknown>();
    const harness = mount(messages);
    harness.setLoad(() => pending.promise);
    harness.start();
    pending.reject(new Error('offline'));
    await flush();
    const tree = harness.view();
    const html = renderToStaticMarkup(tree as React.ReactElement);
    const { input, button } = controls(tree);
    assert.equal(hostProps(input).disabled, true);
    assert.equal(hostProps(button).disabled, true);
    assert.equal(hostProps(first(tree, 'p')).role === 'status' || html.includes('role="status"'), true);
    assert.equal(html.includes(failed), true);
  }
});

test('saving replaces the typed path with the normalized vault and clears a prior status', async () => {
  const harness = await loadVault(en, { configuredPath: '/vaults/Brain', destination: '/vaults/Brain/Lab' });
  const invalid = Promise.withResolvers<unknown>();
  harness.setSave(() => invalid.promise);
  let tree = harness.view();
  hostProps(controls(tree).form).onSubmit?.({ preventDefault() {} });
  invalid.reject(new Error('obsidian_invalid_path'));
  await flush();
  assert.equal(renderToStaticMarkup(harness.view() as React.ReactElement).includes('Enter an absolute vault path containing a .obsidian folder.'), true);

  tree = harness.view();
  hostProps(controls(tree).input).onChange?.({ target: { value: '/tmp/typed' } });
  tree = harness.view();
  const saving = Promise.withResolvers<unknown>();
  harness.setSave(() => saving.promise);
  let prevented = false;
  hostProps(controls(tree).form).onSubmit?.({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const pendingTree = harness.view();
  const pendingHtml = renderToStaticMarkup(pendingTree as React.ReactElement);
  assert.equal(hostProps(controls(pendingTree).input).disabled, true);
  assert.equal(hostProps(controls(pendingTree).button).disabled, true);
  assert.equal(pendingHtml.includes('Enter an absolute vault path containing a .obsidian folder.'), false);
  assert.equal(pendingHtml.includes('Save location updated'), false);
  saving.resolve({ configuredPath: '/tmp/normalized', destination: '/tmp/normalized/Lab' });
  await flush();
  const savedTree = harness.view();
  const savedHtml = renderToStaticMarkup(savedTree as React.ReactElement);
  const patch = harness.calls.filter(call => call.init?.method === 'PATCH').at(-1);
  assert.equal(patch?.path, '/api/obsidian/settings');
  assert.deepEqual(JSON.parse(patch?.init?.body ?? ''), { path: '/tmp/typed' });
  assert.equal(hostProps(controls(savedTree).input).value, '/tmp/normalized');
  assert.equal(hostProps(controls(savedTree).input).disabled, false);
  assert.equal(savedHtml.includes('/tmp/normalized/Lab'), true);
  assert.equal(savedHtml.includes('Save location updated'), true);
});

test('an invalid vault path reports the invalid copy and unlocks the form', async () => {
  const harness = await loadVault(en, { configuredPath: '/vaults/Brain', destination: '/vaults/Brain/Lab' });
  const saving = Promise.withResolvers<unknown>();
  harness.setSave(() => saving.promise);
  const tree = harness.view();
  hostProps(controls(tree).form).onSubmit?.({ preventDefault() {} });
  saving.reject(new Error('obsidian_invalid_path'));
  await flush();
  const next = harness.view();
  const html = renderToStaticMarkup(next as React.ReactElement);
  assert.equal(html.includes('Enter an absolute vault path containing a .obsidian folder.'), true);
  assert.equal(hostProps(controls(next).input).disabled, false);
  assert.equal(hostProps(controls(next).button).disabled, false);
});

test('a failed save reports the settings failure and unlocks the form', async () => {
  const harness = await loadVault(en, { configuredPath: '/vaults/Brain', destination: '/vaults/Brain/Lab' });
  const saving = Promise.withResolvers<unknown>();
  harness.setSave(() => saving.promise);
  const tree = harness.view();
  hostProps(controls(tree).form).onSubmit?.({ preventDefault() {} });
  saving.reject(new Error('network down'));
  await flush();
  const html = renderToStaticMarkup(harness.view() as React.ReactElement);
  assert.equal(html.includes('Could not read or save Obsidian settings.'), true);
  assert.equal(hostProps(controls(harness.view()).input).disabled, false);
});

test('effect cleanup ignores a late settings response', async () => {
  const resolved = Promise.withResolvers<unknown>();
  const loaded = mount(en);
  loaded.setLoad(() => resolved.promise);
  const stopLoad = loaded.start();
  stopLoad();
  resolved.resolve({ configuredPath: '/vaults/Brain', destination: '/vaults/Brain/Lab' });
  await flush();
  const afterResolve = loaded.view();
  const resolvedHtml = renderToStaticMarkup(afterResolve as React.ReactElement);
  assert.equal(hostProps(controls(afterResolve).input).value, '');
  assert.equal(hostProps(controls(afterResolve).input).disabled, true);
  assert.equal(resolvedHtml.includes('Could not read or save Obsidian settings.'), false);

  const rejected = Promise.withResolvers<unknown>();
  const failed = mount(en);
  failed.setLoad(() => rejected.promise);
  failed.start()();
  rejected.reject(new Error('late'));
  await flush();
  const afterReject = failed.view();
  assert.equal(hostProps(controls(afterReject).input).disabled, true);
  assert.equal(renderToStaticMarkup(afterReject as React.ReactElement).includes('role="status"'), false);
});
