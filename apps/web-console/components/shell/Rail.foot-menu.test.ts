import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { en } from '../../lib/i18n/messages/en/index.ts';
import { zh } from '../../lib/i18n/messages/zh/index.ts';
import { translate } from '../../lib/i18n/t.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');

function t(key: string, vars?: Record<string, string | number>): string {
  return translate(zh, key, vars);
}

const jsx = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
} as const;

type HookSlot = {
  begin(): void;
  useState<T>(init: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void];
  useEffect(effect: () => void | (() => void)): void;
  useRef<T>(value: T): { current: T };
  drainEffects(): Array<() => void | (() => void)>;
  cleanup(): void;
};

function createHooks(): HookSlot {
  const state: unknown[] = [];
  const ran = new Set<number>();
  const queued: Array<() => void | (() => void)> = [];
  const cleanups: Array<() => void> = [];
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
    },
    useEffect(effect) {
      const index = cursor;
      cursor += 1;
      if (!ran.has(index)) {
        ran.add(index);
        queued.push(effect);
      }
    },
    useRef(value) {
      const index = cursor;
      cursor += 1;
      if (!Object.hasOwn(state, index)) state[index] = { current: value };
      return state[index] as { current: typeof value };
    },
    drainEffects() {
      return queued.splice(0);
    },
    cleanup() {
      for (const fn of cleanups.splice(0)) fn();
    }
  };
}

const hookSlot: { current: HookSlot | null } = { current: null };

function loadTsx(filename: string): Record<string, unknown> {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: jsx }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const reactMod = new Proxy(React, {
    get(target, key) {
      if (key === 'useState') return (init: unknown) => hookSlot.current!.useState(init as never);
      if (key === 'useEffect') return (effect: () => void | (() => void)) => hookSlot.current!.useEffect(effect);
      if (key === 'useRef') return (value: unknown) => hookSlot.current!.useRef(value);
      const current = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof current === 'function' ? current.bind(target) : current;
    }
  });
  const req = (id: string) => resolveImport(filename, id, reactMod);
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

function resolveImport(fromFile: string, id: string, reactMod: typeof React): unknown {
  if (id === 'react') return reactMod;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return createRequire(fromFile)(id);
  if (id === 'react-dom') return createRequire(fromFile)(id);
  if (id.endsWith('.css')) return {};
  if (id === '@/lib/i18n') return { useI18n: () => ({ t, locale: 'zh', setLocale() {} }) };
  if (id === './LabProvider' || id.endsWith('/LabProvider')) {
    return {
      useLab: () => ({
        location: { section: 'chat', sub: null, pane: null },
        navigate() {},
        approvals: []
      })
    };
  }
  if (id.startsWith('@/')) {
    const base = path.join(webRoot, id.slice(2));
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.tsx`) ? `${base}.tsx` : base;
    if (file.endsWith('.tsx')) return loadTsx(file);
    return createRequire(fromFile)(file);
  }
  const resolved = path.resolve(path.dirname(fromFile), id);
  if (path.basename(resolved) === 'LabProvider') {
    return resolveImport(fromFile, './LabProvider', reactMod);
  }
  const tsxFile = existsSync(`${resolved}.tsx`) ? `${resolved}.tsx` : resolved.endsWith('.tsx') ? resolved : '';
  if (tsxFile) return loadTsx(tsxFile);
  const tsFile = existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved;
  return createRequire(fromFile)(tsFile);
}

type ElementNode = { type?: unknown; props?: Record<string, unknown> & { children?: unknown; hidden?: boolean } };

function walk(node: unknown, visit: (el: ElementNode) => boolean): boolean {
  if (Array.isArray(node)) return node.some((child) => walk(child, visit));
  if (!node || typeof node !== 'object') return false;
  const el = node as ElementNode;
  if (visit(el)) return true;
  return walk(el.props?.children, visit);
}

function findElement(node: unknown, match: (el: ElementNode) => boolean): ElementNode | null {
  let found: ElementNode | null = null;
  walk(node, (el) => {
    if (!match(el)) return false;
    found = el;
    return true;
  });
  return found;
}

function visibleButtons(node: unknown, hidden = false): ElementNode[] {
  const found: ElementNode[] = [];
  if (node == null || typeof node === 'boolean') return found;
  if (Array.isArray(node)) {
    for (const child of node) found.push(...visibleButtons(child, hidden));
    return found;
  }
  if (typeof node !== 'object') return found;
  const el = node as ElementNode;
  const nextHidden = hidden || Boolean(el.props?.hidden);
  if (!nextHidden && el.type === 'button') found.push(el);
  found.push(...visibleButtons(el.props?.children, nextHidden));
  return found;
}

function blockAfter(css: string, selector: string): string {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `missing ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const shellCss = readFileSync(path.join(webRoot, 'styles/shell.css'), 'utf8');
const railSource = readFileSync(path.join(here, 'Rail.tsx'), 'utf8');
const labShell = readFileSync(path.join(here, 'LabShell.tsx'), 'utf8');
const languageToggle = readFileSync(path.join(webRoot, 'components/LanguageToggle.tsx'), 'utf8');

function installWindow(collapsed: boolean) {
  const store = new Map<string, string>();
  if (collapsed) store.set('lab.railCollapsed', '1');
  Object.assign(globalThis, {
    window: {
      innerHeight: 800,
      matchMedia() {
        return { matches: false, addEventListener() {}, removeEventListener() {} };
      },
      addEventListener() {},
      removeEventListener() {},
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); }
      }
    }
  });
}

const { Rail } = loadTsx(path.join(here, 'Rail.tsx')) as {
  Rail: (props: { footer?: (collapsed: boolean) => React.ReactNode }) => React.ReactElement;
};

function mountRail(footer: (collapsed: boolean) => React.ReactNode) {
  const hooks = createHooks();
  hookSlot.current = hooks;
  const paint = () => {
    hooks.begin();
    return Rail({ footer });
  };
  const view = {
    tree: null as React.ReactElement | null,
    redraw() {
      this.tree = paint();
      return this.tree;
    },
    stop() { hooks.cleanup(); }
  };
  view.redraw();
  for (const effect of hooks.drainEffects()) {
    const cleanup = effect();
    if (typeof cleanup === 'function') {
      const prev = view.stop.bind(view);
      view.stop = () => { prev(); cleanup(); };
    }
  }
  view.redraw();
  return view;
}

test('默认底部只有小触发按钮，不铺开配置模型和语言 [AC:rail-foot-menu#AC-1]', () => {
  installWindow(false);
  const view = mountRail(() => React.createElement(React.Fragment, null,
    React.createElement('button', { type: 'button', id: 'btnModelSetup' }, zh.nav.configureModel),
    React.createElement('button', { type: 'button', 'aria-label': '中文' }, '中文'),
    React.createElement('button', { type: 'button', 'aria-label': 'English' }, 'English')
  ));
  try {
    const foot = findElement(view.tree, (el) => el.props?.className === 'lab-rail__foot');
    assert.ok(foot, 'rail foot exists');
    const trigger = findElement(foot, (el) => el.props?.['data-testid'] === 'rail-foot-trigger');
    assert.ok(trigger);
    assert.equal(trigger.type, 'button');
    assert.equal(trigger.props?.['aria-expanded'], false);
    assert.equal(trigger.props?.['aria-label'], zh.shell.nav.footMenu);
    assert.equal(typeof zh.shell.nav.footMenu, 'string');
    assert.equal(typeof en.shell.nav.footMenu, 'string');
    assert.notEqual(zh.shell.nav.footMenu, en.shell.nav.footMenu);
    assert.notEqual(zh.shell.nav.footMenu, 'shell.nav.footMenu');
    assert.match(railSource, /t\('shell\.nav\.footMenu'\)/);
    assert.doesNotMatch(railSource, /配置模型|Configure model|>中文<|>English</);

    const menu = findElement(foot, (el) => el.props?.id === 'lab-rail-foot-menu');
    assert.ok(menu);
    assert.equal(menu.props?.hidden, true);
    const shown = visibleButtons(foot);
    assert.equal(shown.length, 1);
    assert.equal(shown[0], trigger);
    assert.equal(findElement(menu, (el) => el.props?.id === 'btnModelSetup')?.props?.hidden, undefined);

    const menuRule = blockAfter(shellCss, '.lab-rail__foot-menu {');
    assert.match(menuRule, /position:\s*absolute/);
    assert.match(menuRule, /bottom:\s*calc\(100% - 4px\)/);
    assert.match(blockAfter(shellCss, '.lab-rail__foot-menu[hidden]'), /display:\s*none\s*!important/);
    assert.doesNotMatch(menuRule, /min-height:\s*\d{3}/);
  } finally {
    view.stop();
  }
});

test('悬停或聚焦后能看到配置模型和语言并触发原动作 [AC:rail-foot-menu#AC-2]', (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installWindow(true);
  let seenCollapsed: boolean | null = null;
  let modelClicks = 0;
  let locale = '';
  let extraClicks = 0;
  const view = mountRail((collapsed) => {
    seenCollapsed = collapsed;
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        type: 'button',
        id: 'btnModelSetup',
        onClick: () => { modelClicks += 1; }
      }, zh.nav.configureModel),
      React.createElement('button', {
        type: 'button',
        'aria-label': '中文',
        onClick: () => { locale = 'zh'; }
      }, collapsed ? '中' : '中文'),
      React.createElement('button', {
        type: 'button',
        'aria-label': 'English',
        onClick: () => { locale = 'en'; }
      }, 'English'),
      React.createElement('button', {
        type: 'button',
        'data-testid': 'rail-foot-extra',
        onClick: () => { extraClicks += 1; }
      }, '星标')
    );
  });
  try {
    assert.equal(seenCollapsed, false, 'menu keeps full language names even when the rail is collapsed');
    const foot = () => findElement(view.tree, (el) => el.props?.className === 'lab-rail__foot');
    const menu = () => findElement(foot(), (el) => el.props?.id === 'lab-rail-foot-menu');
    const trigger = () => findElement(foot(), (el) => el.props?.['data-testid'] === 'rail-foot-trigger');

    (foot()?.props?.onMouseEnter as () => void)();
    view.redraw();
    assert.equal(menu()?.props?.hidden, false);
    assert.equal(trigger()?.props?.['aria-expanded'], true);
    assert.equal(findElement(menu(), (el) => el.props?.id === 'btnModelSetup')?.props?.children, zh.nav.configureModel);
    assert.equal(findElement(menu(), (el) => el.props?.['aria-label'] === '中文')?.props?.children, '中文');
    assert.equal(findElement(menu(), (el) => el.props?.['aria-label'] === 'English')?.props?.children, 'English');
    assert.ok(findElement(menu(), (el) => el.props?.['data-testid'] === 'rail-foot-extra'));

    (findElement(menu(), (el) => el.props?.id === 'btnModelSetup')?.props?.onClick as () => void)();
    (findElement(menu(), (el) => el.props?.['aria-label'] === 'English')?.props?.onClick as () => void)();
    (findElement(menu(), (el) => el.props?.['data-testid'] === 'rail-foot-extra')?.props?.onClick as () => void)();
    assert.equal(modelClicks, 1);
    assert.equal(locale, 'en');
    assert.equal(extraClicks, 1);

    const inside = {};
    (foot()?.props?.onBlur as (event: { relatedTarget: object; currentTarget: { contains(node: object): boolean } }) => void)({
      relatedTarget: inside,
      currentTarget: { contains: (node) => node === inside }
    });
    view.redraw();
    assert.equal(menu()?.props?.hidden, false);

    (foot()?.props?.onMouseLeave as () => void)();
    view.redraw();
    assert.equal(menu()?.props?.hidden, false);
    t.mock.timers.tick(200);
    view.redraw();
    assert.equal(menu()?.props?.hidden, true);
    assert.equal(trigger()?.props?.['aria-expanded'], false);

    (foot()?.props?.onFocus as () => void)();
    view.redraw();
    assert.equal(menu()?.props?.hidden, false);
    (foot()?.props?.onMouseEnter as () => void)();
    (foot()?.props?.onMouseLeave as () => void)();
    t.mock.timers.tick(200);
    view.redraw();
    assert.equal(menu()?.props?.hidden, false, 'keyboard focus keeps the menu open after the pointer leaves');
    (foot()?.props?.onBlur as (event: { relatedTarget: null; currentTarget: { contains(): boolean } }) => void)({
      relatedTarget: null,
      currentTarget: { contains: () => false }
    });
    view.redraw();
    assert.equal(menu()?.props?.hidden, true);

    assert.match(labShell, /id="btnModelSetup"[\s\S]*setModelSetupOpen\(true\)[\s\S]*<LanguageToggle compact=\{collapsed\} \/>[\s\S]*<SkinToggle \/>[\s\S]*<ThemeToggle \/>[\s\S]*AccountMenu/);
    assert.match(languageToggle, /return '中文'/);
    assert.match(languageToggle, /return 'English'/);
    assert.match(languageToggle, /localeEndonym\(code\)/);
    const unclip = blockAfter(shellCss, '.lab-rail.is-collapsed .lab-rail__foot-menu .lab-rail__label');
    assert.match(unclip, /position:\s*static/);
    assert.match(unclip, /clip:\s*auto/);
  } finally {
    view.stop();
    t.mock.timers.reset();
  }
});
