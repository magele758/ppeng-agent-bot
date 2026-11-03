import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { acknowledgePreferences, pendingPreferences } from '../lib/user-preference-storage.ts';
import { SKIN_STORAGE_KEY } from '../lib/skin.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const PORTAL = Symbol.for('react.portal');

const jsx = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
} as const;

type AttrNode = {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
};

type FakeNode = {
  nodeType: number;
  className?: string;
  children: FakeNode[];
  contains(target: unknown): boolean;
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
};

type Storage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.get(key) ?? null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); }
  };
}

function attrNode(): AttrNode {
  const attrs = new Map<string, string>();
  return {
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.get(name) ?? null; },
    removeAttribute(name) { attrs.delete(name); }
  };
}

function makeFake(className?: string): FakeNode {
  const fake: FakeNode = {
    nodeType: 1,
    className,
    children: [],
    contains(target) {
      if (target === fake) return true;
      return fake.children.some((child) => child.contains(target));
    },
    getBoundingClientRect() {
      return { top: 100, bottom: 132, left: 8, right: 40, width: 32, height: 32 };
    }
  };
  return fake;
}

function listenerBag() {
  const map = new Map<string, Array<(event: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (event: unknown) => void) {
      const list = map.get(type) ?? [];
      list.push(fn);
      map.set(type, list);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      map.set(type, (map.get(type) ?? []).filter((item) => item !== fn));
    },
    emit(type: string, event: unknown) {
      for (const fn of [...(map.get(type) ?? [])]) fn(event);
    }
  };
}

function installBrowser() {
  const storage = memoryStorage();
  const root = attrNode();
  const body = makeFake('body');
  const listeners = listenerBag();
  const windowListeners = listenerBag();
  const win = {
    innerHeight: 800,
    localStorage: storage,
    matchMedia() {
      return { matches: true, addEventListener() {}, removeEventListener() {} };
    },
    addEventListener: windowListeners.addEventListener,
    removeEventListener: windowListeners.removeEventListener,
    dispatchEvent() { return true; },
    setInterval(fn: () => void) {
      win.interval = fn;
      return 1;
    },
    clearInterval() { win.interval = null; },
    interval: null as (() => void) | null
  };
  const doc = {
    documentElement: root,
    body,
    addEventListener: listeners.addEventListener,
    removeEventListener: listeners.removeEventListener,
    emit: listeners.emit
  };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage
  };
  Object.assign(globalThis, { window: win, document: doc, localStorage: storage });
  return {
    win,
    doc,
    storage,
    root,
    body,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.localStorage = previous.localStorage;
    }
  };
}

type EffectSlot = { deps?: unknown[]; started: boolean; cleanup?: () => void };

function createHooks() {
  const state: unknown[] = [];
  const slots: EffectSlot[] = [];
  const pending: Array<{ index: number; effect: () => void | (() => void); deps?: unknown[] }> = [];
  let cursor = 0;
  const sameDeps = (left?: unknown[], right?: unknown[]) => {
    if (!left || !right || left.length !== right.length) return false;
    return left.every((item, index) => Object.is(item, right[index]));
  };
  return {
    begin() { cursor = 0; },
    useState<T>(init: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void] {
      const index = cursor;
      cursor += 1;
      if (!Object.hasOwn(state, index)) state[index] = typeof init === 'function' ? (init as () => T)() : init;
      return [state[index] as T, (value) => {
        state[index] = typeof value === 'function' ? (value as (prev: T) => T)(state[index] as T) : value;
      }];
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const index = cursor;
      cursor += 1;
      const slot = slots[index] ??= { started: false };
      if (!slot.started || deps === undefined || !sameDeps(slot.deps, deps)) pending.push({ index, effect, deps });
    },
    useRef<T>(value: T): { current: T } {
      const index = cursor;
      cursor += 1;
      if (!Object.hasOwn(state, index)) state[index] = { current: value };
      return state[index] as { current: T };
    },
    drain() {
      for (const item of pending.splice(0)) {
        const slot = slots[item.index]!;
        slot.cleanup?.();
        const cleanup = item.effect();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        slot.deps = item.deps;
        slot.started = true;
      }
    },
    cleanup() {
      for (const slot of slots) slot?.cleanup?.();
    }
  };
}

const hookSlot: { current: ReturnType<typeof createHooks> | null } = { current: null };
const apiState: { values: Record<string, string | null> } = { values: {} };

function loadTsx(filename: string, reactMod: object): Record<string, unknown> {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: jsx }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => resolveImport(filename, id, reactMod);
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

function resolveImport(fromFile: string, id: string, reactMod: object): unknown {
  if (id === 'react') return reactMod;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime' || id === 'react-dom') return createRequire(fromFile)(id);
  if (id === '@/lib/api') return { api: async () => ({ scope: 'user-1', values: { ...apiState.values } }) };
  if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key, locale: 'zh', setLocale() {} }) };
  if (id.startsWith('@/')) {
    const base = path.join(webRoot, id.slice(2));
    const file = ['ts', 'tsx'].map((ext) => `${base}.${ext}`).find((candidate) => {
      try { readFileSync(candidate); return true; } catch { return false; }
    }) ?? base;
    if (file.endsWith('.tsx')) return loadTsx(file, reactMod);
    return createRequire(fromFile)(file);
  }
  return createRequire(fromFile)(id);
}

function reactHooks() {
  return new Proxy(React, {
    get(target, key) {
      if (key === 'useState') return (init: unknown) => hookSlot.current!.useState(init as never);
      if (key === 'useEffect') return (effect: () => void | (() => void), deps?: unknown[]) => hookSlot.current!.useEffect(effect, deps);
      if (key === 'useRef') return (value: unknown) => hookSlot.current!.useRef(value);
      const current = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof current === 'function' ? current.bind(target) : current;
    }
  });
}

type ReactLike = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> & { children?: unknown }; children?: unknown; containerInfo?: unknown; ref?: { current: unknown } };

function walkReact(node: unknown, visit: (el: ReactLike) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkReact(child, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const el = node as ReactLike;
  if (el.$$typeof === PORTAL) {
    visit(el);
    walkReact(el.children, visit);
    return;
  }
  if (!el.props) return;
  visit(el);
  walkReact(el.props.children, visit);
}

function findReact(node: unknown, match: (el: ReactLike) => boolean): ReactLike | null {
  let found: ReactLike | null = null;
  walkReact(node, (el) => {
    if (!found && match(el)) found = el;
  });
  return found;
}

const fakes = new WeakMap<object, FakeNode>();

function commitRefs(node: unknown, parent: FakeNode): void {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const child of node) commitRefs(child, parent);
    return;
  }
  if (typeof node !== 'object') return;
  const el = node as ReactLike;
  if (el.$$typeof === PORTAL) {
    const host = el.containerInfo;
    if (host && typeof host === 'object' && 'children' in host) commitRefs(el.children, host as FakeNode);
    return;
  }
  if (!el.props) return;
  const fake = makeFake(typeof el.props.className === 'string' ? el.props.className : undefined);
  parent.children.push(fake);
  fakes.set(el, fake);
  const ref = el.props.ref as { current: unknown } | undefined;
  if (ref && typeof ref === 'object' && 'current' in ref) ref.current = fake;
  commitRefs(el.props.children, fake);
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('偏好同步后经典深色不再被盖上毛玻璃 [AC:classic-solid-dark#AC-2]', async () => {
  acknowledgePreferences(pendingPreferences());
  const browser = installBrowser();
  browser.root.setAttribute('data-skin', 'sanctum');
  apiState.values = { theme: 'dark', 'lab.skin': null };
  const hooks = createHooks();
  hookSlot.current = hooks;
  try {
    const mod = loadTsx(path.join(here, 'UserPreferenceSync.tsx'), reactHooks());
    const UserPreferenceSync = mod.UserPreferenceSync as () => null;
    hooks.begin();
    UserPreferenceSync();
    hooks.drain();
    await flush();
    assert.equal(browser.root.getAttribute('data-skin'), null);
    assert.notEqual(browser.root.getAttribute('data-skin'), 'classic');
    assert.equal(browser.root.getAttribute('data-theme'), 'dark');

    apiState.values = { theme: 'dark', 'lab.skin': 'classic' };
    browser.win.interval?.();
    await flush();
    assert.equal(browser.root.getAttribute('data-skin'), null);
    assert.equal(browser.root.getAttribute('data-theme'), 'dark');

    apiState.values = { theme: 'dark', 'lab.skin': 'sanctum' };
    browser.win.interval?.();
    await flush();
    assert.equal(browser.root.getAttribute('data-skin'), 'sanctum');
    assert.equal(browser.root.getAttribute('data-theme'), 'dark');

    apiState.values = { theme: 'light', 'lab.skin': null };
    browser.win.interval?.();
    await flush();
    assert.equal(browser.root.getAttribute('data-skin'), null);
    assert.equal(browser.root.getAttribute('data-theme'), 'light');
  } finally {
    hooks.cleanup();
    browser.restore();
  }
});

function mountSkinToggle() {
  const browser = installBrowser();
  const hooks = createHooks();
  hookSlot.current = hooks;
  const mod = loadTsx(path.join(here, 'SkinToggle.tsx'), reactHooks());
  const SkinToggle = mod.SkinToggle as () => ReactLike;
  const foot = makeFake('lab-rail__foot-menu');
  const paint = () => {
    hooks.begin();
    const tree = SkinToggle();
    foot.children = [];
    browser.body.children = [];
    commitRefs(tree, foot);
    return tree;
  };
  let tree = paint();
  hooks.drain();
  tree = paint();
  const redraw = () => {
    tree = paint();
    hooks.drain();
    tree = paint();
    return tree;
  };
  const clickOpen = () => {
    const button = findReact(tree, (el) => el.props?.['aria-haspopup'] === 'listbox');
    assert.ok(button);
    (button.props?.onClick as () => void)();
    redraw();
  };
  return {
    browser,
    foot,
    hooks,
    clickOpen,
    redraw,
    tree: () => tree,
    stop() {
      hooks.cleanup();
      browser.restore();
    }
  };
}

test('毛玻璃底部菜单里外观列表挂在页面上并能点中 [AC:outer-skin-picker#AC-2]', () => {
  const view = mountSkinToggle();
  try {
    view.clickOpen();
    const list = findReact(view.tree(), (el) => el.props?.className === 'skin-menu__list');
    assert.ok(list, 'open list exists');
    assert.equal(list.props?.style && (list.props.style as { top: number; left: number }).top, 100);
    assert.equal(list.props?.style && (list.props.style as { left: number }).left, 48);
    const listFake = fakes.get(list);
    assert.ok(listFake);
    assert.equal(view.foot.contains(listFake), false);
    assert.equal(view.browser.body.contains(listFake), true);

    const option = findReact(view.tree(), (el) => el.props?.role === 'option' && el.props?.['aria-selected'] !== true);
    assert.ok(option);
    const optionFake = fakes.get(option);
    assert.ok(optionFake);
    view.browser.doc.emit('mousedown', { target: optionFake });
    view.redraw();
    const stillOpen = findReact(view.tree(), (el) => el.props?.['aria-haspopup'] === 'listbox');
    assert.equal(stillOpen?.props?.['aria-expanded'], true);
    const liveOption = findReact(view.tree(), (el) => el.props?.role === 'option' && el.props?.['aria-selected'] !== true);
    assert.ok(liveOption);
    (liveOption.props?.onClick as () => void)();
    assert.equal(view.browser.storage.getItem(SKIN_STORAGE_KEY), 'sanctum');
    assert.equal(view.browser.root.getAttribute('data-skin'), 'sanctum');
  } finally {
    view.stop();
  }
});

test('外观列表按 Escape 或点外面会关掉且不改外观 [AC:outer-skin-picker#AC-3]', () => {
  const view = mountSkinToggle();
  try {
    view.browser.storage.setItem(SKIN_STORAGE_KEY, 'demon');
    view.clickOpen();
    view.browser.doc.emit('keydown', { key: 'Escape' });
    view.redraw();
    let button = findReact(view.tree(), (el) => el.props?.['aria-haspopup'] === 'listbox');
    assert.equal(button?.props?.['aria-expanded'], false);
    assert.equal(findReact(view.tree(), (el) => el.props?.className === 'skin-menu__list'), null);
    assert.equal(view.browser.storage.getItem(SKIN_STORAGE_KEY), 'demon');
    assert.equal(view.browser.root.getAttribute('data-skin'), null);

    view.clickOpen();
    view.browser.doc.emit('mousedown', { target: { nodeType: 1, contains() { return false; } } });
    view.redraw();
    button = findReact(view.tree(), (el) => el.props?.['aria-haspopup'] === 'listbox');
    assert.equal(button?.props?.['aria-expanded'], false);
    assert.equal(view.browser.storage.getItem(SKIN_STORAGE_KEY), 'demon');
  } finally {
    view.stop();
  }
});
