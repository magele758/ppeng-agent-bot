import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);
const mobileCss = readFileSync(new URL('../styles/mobile.css', import.meta.url), 'utf8');
const globalsCss = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const legacyCss = readFileSync(new URL('../legacy-vanilla/styles.css', import.meta.url), 'utf8');
const playPanel = readFileSync(new URL('./PlayPanel.tsx', import.meta.url), 'utf8');
const botDetailMenu = readFileSync(new URL('./BotDetailMenu.tsx', import.meta.url), 'utf8');

const copy: Record<string, string> = {};
function walkCopy(value: unknown, prefix: string) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') copy[path] = child;
    else walkCopy(child, path);
  }
}
walkCopy(zh, '');

function translate(key: string, vars?: Record<string, string | number>) {
  let text = copy[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

function mediaBlock(css: string, query: string): string {
  const needle = `@media ${query}`;
  const parts: string[] = [];
  let from = 0;
  while (from < css.length) {
    const at = css.indexOf(needle, from);
    if (at < 0) break;
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    parts.push(css.slice(open + 1, end));
    from = end + 1;
  }
  assert.ok(parts.length > 0, `missing ${needle}`);
  return parts.join('\n');
}

function outsideMedia(css: string): string {
  return css.replace(/@media[^{]+\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '');
}

const narrow = mediaBlock(mobileCss, '(max-width: 760px)');
const mobileOutside = outsideMedia(mobileCss);

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
      const effects = queued.splice(0);
      return effects;
    },
    cleanup() {
      for (const fn of cleanups.splice(0)) fn();
    }
  };
}

const hookSlot: { current: HookSlot | null } = { current: null };

function loadComponent(file: string, api: (path: string) => Promise<unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, React.ComponentType<Record<string, unknown>>> };
  const reactMod = new Proxy(React, {
    get(target, key) {
      if (key === 'useState') return (...args: unknown[]) => hookSlot.current!.useState(args[0] as never);
      if (key === 'useEffect') return (...args: unknown[]) => hookSlot.current!.useEffect(args[0] as () => void);
      if (key === 'useRef') return (...args: unknown[]) => hookSlot.current!.useRef(args[0]);
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return reactMod;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: translate }) };
    if (id === '@/lib/api') return { api };
    if (id === '@/lib/bot-goals') return localRequire('../lib/bot-goals.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', `const React = require("react");\n${compiled}`)(requireComponent, mod, mod.exports);
  return mod.exports;
}

function installMatch(matches: boolean) {
  Object.assign(globalThis, {
    window: {
      matchMedia(query: string) {
        assert.equal(query, '(max-width: 760px)');
        return { matches, addEventListener() {}, removeEventListener() {} };
      }
    }
  });
}

async function mount(render: () => React.ReactElement | null) {
  const hooks = createHooks();
  hookSlot.current = hooks;
  const paint = () => {
    hooks.begin();
    return render();
  };
  const view = {
    tree: null as React.ReactElement | null,
    html: '',
    redraw() {
      this.tree = paint();
      this.html = this.tree ? renderToStaticMarkup(this.tree) : '';
      return this.html;
    },
    stop() { hooks.cleanup(); }
  };
  view.redraw();
  for (const effect of hooks.drainEffects()) {
    const cleanup = effect();
    if (typeof cleanup === 'function') hooks.cleanup = ((prev) => () => { prev(); cleanup(); })(hooks.cleanup);
  }
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  view.redraw();
  return view;
}

function find(node: unknown, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const element = node as { props?: Record<string, unknown> };
  if (element.props && match(element.props)) return element.props;
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : children == null ? [] : [children];
  for (const child of list) {
    const found = find(child, match);
    if (found) return found;
  }
  return null;
}

const pendingGoal = {
  goalId: 'goal-1',
  source: 'bot',
  status: 'pending_review',
  condition: '把简历里的项目经历问完并给出评分',
  turnsUsed: 1,
  maxTurns: 4
};

test('窄屏刚进入对话时 Bot 信息和目标收成一行，对话区吃掉剩余高度 [AC:mobile-chat-density#AC-1]', () => {
  assert.match(narrow, /\.chat-panel-header:not\(\.is-mobile-open\) \.chat-panel-header__details,\s*\.lab-shell \.chat-panel-header:not\(\.is-mobile-open\) \.chat-panel-header__actions \{\s*display:\s*none;/);
  assert.match(narrow, /\.goal-status-card:not\(\.is-expanded\) \.goal-status-card__body \{ display:\s*none; \}/);
  assert.match(narrow, /\.goal-status-card__summary \{[^}]*white-space:\s*nowrap;/);
  assert.match(narrow, /\.goal-status-card__peek \{[^}]*text-overflow:\s*ellipsis;/);
  assert.match(narrow, /\.chat-panel-body \{ flex:\s*1 1 auto; min-height:\s*0; \}/);
  assert.match(narrow, /\.chat-feed-shell \{ flex:\s*1 1 auto; min-height:\s*0; \}/);
  assert.match(narrow, /\.chat-composer-outer \{ flex:\s*0 0 auto; \}/);
  assert.match(legacyCss, /\.play-main\.chat-panel \{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*flex:\s*1;/);
  assert.match(playPanel, /const \[mobileBotBarOpen, setMobileBotBarOpen\] = useState\(false\)/);
  assert.match(playPanel, /mobileBotBarOpen \? ' is-mobile-open' : ''/);
  assert.match(playPanel, /data-testid="mobile-bot-bar-toggle"/);
  assert.match(playPanel, /aria-expanded=\{mobileBotBarOpen\}/);
  assert.doesNotMatch(mobileOutside, /is-mobile-open/);
  assert.doesNotMatch(mobileOutside, /is-expanded/);
});

test('点开窄屏摘要后权限、详情、目标历史、状态、费用、Trace 和目标全文仍可操作 [AC:mobile-chat-density#AC-2]', async () => {
  assert.match(narrow, /\.chat-panel-header\.is-mobile-open \.chat-panel-header__details,\s*\.lab-shell \.chat-panel-header\.is-mobile-open \.chat-panel-header__actions \{\s*display:\s*flex;/);
  assert.match(narrow, /\.chat-panel-header\.is-mobile-open \.chat-panel-header__title-row \.chat-panel-header__permissions,\s*\.lab-shell \.chat-panel-header\.is-mobile-open \.chat-panel-header__title-row \.chat-panel-header__detail \{\s*display:\s*inline-flex;/);
  assert.match(narrow, /\.goal-status-card\.is-expanded \.goal-status-card__body \{ display:\s*block;[^}]*\}/);
  assert.match(botDetailMenu, /className="chat-panel-header__permissions"/);
  assert.match(botDetailMenu, /className="chat-panel-header__detail"/);
  assert.match(playPanel, /<GoalHistory /);
  assert.match(playPanel, /onOpenTrace/);
  assert.match(playPanel, /\{t\('play\.trace'\)\}/);
  const header = playPanel.slice(playPanel.indexOf('className={`chat-panel-header'), playPanel.indexOf('<div className="chat-panel-body">'));
  assert.match(header, /<BotPermissionsLink /);
  assert.match(header, /<BotDetailToggle /);
  assert.ok(header.indexOf('chat-panel-header__details') < header.indexOf('session-chrome'));
  assert.ok(header.indexOf('chat-panel-header__actions') < header.indexOf('<GoalHistory '));
  assert.ok(header.indexOf('<GoalHistory ') < header.indexOf('onOpenTrace'));

  const { GoalStatusCard } = loadComponent('./GoalStatusCard.tsx', async () => ({ goal: pendingGoal }));
  installMatch(true);
  const view = await mount(() => GoalStatusCard({ sessionId: 'sess-1' }) as React.ReactElement);
  try {
    const collapsed = find(view.tree, (props) => props['data-testid'] === 'mobile-goal-card-toggle');
    assert.ok(collapsed);
    assert.equal(collapsed['aria-expanded'], false);
    assert.match(view.html, /目标 待核对/);
    assert.match(view.html, /把简历里的项目经历问完并给出评分/);
    assert.doesNotMatch(String((find(view.tree, (props) => props.role === 'status') ?? {}).className), /is-expanded/);
    (collapsed.onClick as () => void)();
    const opened = view.redraw();
    const expanded = find(view.tree, (props) => props['data-testid'] === 'mobile-goal-card-toggle');
    assert.equal(expanded?.['aria-expanded'], true);
    assert.match(String((find(view.tree, (props) => props.role === 'status') ?? {}).className), /is-expanded/);
    assert.match(opened, /goal-status-card__cond/);
    assert.match(opened, /把简历里的项目经历问完并给出评分/);
    assert.match(opened, /执行 1\/4 次/);
  } finally {
    view.stop();
  }
});

test('窄屏的目标与进展默认收起，点开后仍能看到目标列表 [AC:mobile-chat-density#AC-3]', async () => {
  const goals = [
    { id: 'g-1', title: '问完项目经历', status: 'running', progress: '正在出题', evidence: [], priority: 0, budgetUsd: 10, costUsd: 0, attempts: 0 },
    { id: 'g-2', title: '给出评分', status: 'waiting', progress: '', evidence: [], priority: 0, budgetUsd: 10, costUsd: 0, attempts: 0 }
  ];
  const settings = { maxConcurrent: 2, defaultBudgetUsd: 10, maxAttempts: 8, maxNoProgress: 3, leaseMs: 60000, preferredStrategy: 'auto' };
  const { BotGoals } = loadComponent('./bot-work/BotGoals.tsx', async () => ({ goals, settings }));
  installMatch(true);
  const view = await mount(() => BotGoals({
    botId: 'bot-a',
    sessionId: 'sess-1',
    initialSnapshot: { goals, settings }
  }) as React.ReactElement);
  try {
    const closed = find(view.tree, (props) => props['data-testid'] === 'bot-goals');
    assert.ok(closed);
    assert.equal(closed.open, false);
    assert.match(view.html, /<details[^>]*><summary/);
    const button = find(view.tree, (props) => props.onClick && props['aria-expanded'] === false);
    assert.ok(button);
    assert.equal(button['aria-expanded'], false);
    assert.match(view.html, /目标与进展 \(2\)/);
    assert.match(view.html, /问完项目经历/);
    assert.match(view.html, /给出评分/);
    assert.match(narrow, /\.chat-composer-outer \.bot-goals:not\(\[open\]\) \.bot-goals__body \{ display:\s*none; \}/);
    let prevented = false;
    (button.onClick as (event: {preventDefault():void}) => void)({preventDefault(){prevented=true;}});
    assert.equal(prevented,true);
    const openedHtml = view.redraw();
    const opened = find(view.tree, (props) => props['data-testid'] === 'bot-goals');
    assert.equal(opened?.open, true);
    assert.equal(find(view.tree, (props) => props.onClick && props['aria-expanded'] === true)?.['aria-expanded'], true);
    assert.match(openedHtml, /问完项目经历/);
    assert.match(openedHtml, /给出评分/);
  } finally {
    view.stop();
  }
});

test('宽屏仍用原来的 Bot 信息、目标卡片和目标与进展，不套用手机收起 [AC:mobile-chat-density#AC-4]', async () => {
  assert.match(globalsCss, /\.chat-panel-header__mobile-toggle \{ display: none; \}/);
  assert.match(globalsCss, /\.goal-status-card__toggle \{\s*display: none;\s*\}/);
  assert.doesNotMatch(globalsCss, /is-mobile-open/);
  assert.doesNotMatch(outsideMedia(globalsCss), /goal-status-card__body \{ display:\s*none/);
  assert.doesNotMatch(mobileOutside, /is-mobile-open|is-expanded|goal-status-card__body/);
  const goals = [
    { id: 'g-1', title: '问完项目经历', status: 'running', progress: '', evidence: [], priority: 0, budgetUsd: 10, costUsd: 0, attempts: 0 },
    { id: 'g-2', title: '给出评分', status: 'waiting', progress: '', evidence: [], priority: 0, budgetUsd: 10, costUsd: 0, attempts: 0 }
  ];
  const settings = { maxConcurrent: 2, defaultBudgetUsd: 10, maxAttempts: 8, maxNoProgress: 3, leaseMs: 60000, preferredStrategy: 'auto' };
  const { BotGoals } = loadComponent('./bot-work/BotGoals.tsx', async () => ({ goals, settings }));
  installMatch(false);
  const view = await mount(() => BotGoals({
    botId: 'bot-a',
    sessionId: 'sess-1',
    initialSnapshot: { goals, settings }
  }) as React.ReactElement);
  try {
    const panel = find(view.tree, (props) => props['data-testid'] === 'bot-goals');
    assert.ok(panel);
    assert.equal(panel.open, undefined);
    assert.equal(find(view.tree, (props) => props.className === 'bot-goals__phone'), null);
    assert.match(view.html, /<summary>目标与进展 \(2\)<\/summary>/);
    assert.doesNotMatch(view.html, /bot-goals__phone/);
  } finally {
    view.stop();
  }
});
