import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);
const copy: Record<string, string> = {};
function walk(value: unknown, prefix: string) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') copy[path] = child;
    else walk(child, path);
  }
}
walk(zh, '');

const settings = {
  maxConcurrent: 2,
  defaultBudgetUsd: 10,
  maxAttempts: 8,
  maxNoProgress: 3,
  leaseMs: 60000,
  preferredStrategy: 'auto',
};

function goal(id: string, title: string, status: string) {
  return {
    id,
    title,
    status,
    progress: '',
    evidence: [],
    priority: 0,
    budgetUsd: 10,
    costUsd: 0,
    attempts: 0,
  };
}

function translate(key: string, vars?: Record<string, string>) {
  let text = copy[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
  return text;
}

const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

function loadPanel() {
  const source = readFileSync(new URL('./BotGoals.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} as { BotGoals?: React.ComponentType<Record<string, unknown>> } };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return new Proxy(React, { get: (target, key) => (React as unknown as Record<PropertyKey, unknown>)[key] ?? (target as unknown as Record<PropertyKey, unknown>)[key] });
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: translate }) };
    if (id === '@/lib/api') return { api: async (path: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') posted.push({ path, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      return {};
    } };
    if (id === '@/lib/bot-goals') return localRequire('../../lib/bot-goals.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports.BotGoals!;
}

let BotGoals = loadPanel();

function render(goals: ReturnType<typeof goal>[]) {
  return renderToStaticMarkup(React.createElement(BotGoals, {
    botId: 'bot-a',
    sessionId: 'sess-current',
    initialSnapshot: { goals, settings },
  }));
}

test('two running goals render the progress panel', () => {
  const html = render([
    goal('g-1', 'Fix login', 'running'),
    goal('g-2', 'Watch deployment', 'waiting'),
  ]);
  assert.match(html, /目标与进展 \(2\)/);
  assert.match(html, /Fix login/);
  assert.match(html, /Watch deployment/);
});

test('completed goals stay out of the list and the count [AC:bot-goals-panel-rules#AC-4]', () => {
  const html = render([
    goal('g-1', 'Fix login', 'running'),
    goal('g-2', 'Watch deployment', 'waiting'),
    goal('g-3', 'Ship notes', 'completed'),
  ]);
  assert.match(html, /目标与进展 \(2\)/);
  assert.match(html, /Fix login/);
  assert.match(html, /Watch deployment/);
  assert.equal(html.includes('Ship notes'), false);
  assert.equal(html.includes('已完成'), false);
});

test('fewer than two in-progress goals hide the panel even when old goals remain [AC:bot-goals-panel-rules#AC-5]', () => {
  const one = render([
    goal('g-1', 'Fix login', 'running'),
    goal('g-2', 'Ship notes', 'completed'),
    goal('g-3', 'Restore backup', 'failed'),
    goal('g-4', 'Retire job', 'cancelled'),
  ]);
  assert.equal(one, '');
  const none = render([
    goal('g-2', 'Ship notes', 'completed'),
    goal('g-3', 'Restore backup', 'failed'),
    goal('g-4', 'Retire job', 'cancelled'),
  ]);
  assert.equal(none, '');
  assert.equal(render([]), '');
});

test('at least two in-progress goals are listed alone and the count matches [AC:bot-goals-panel-rules#AC-6]', () => {
  const html = render([
    goal('g-q', 'Queue the rollout', 'queued'),
    goal('g-r', 'Fix login', 'running'),
    goal('g-w', 'Watch deployment', 'waiting'),
    goal('g-b', 'Need a decision', 'blocked'),
    goal('g-p', 'Hold the migration', 'paused'),
    goal('g-c', 'Ship notes', 'completed'),
    goal('g-f', 'Restore backup', 'failed'),
    goal('g-x', 'Retire job', 'cancelled'),
  ]);
  assert.match(html, /目标与进展 \(5\)/);
  for (const title of ['Queue the rollout', 'Fix login', 'Watch deployment', 'Need a decision', 'Hold the migration']) {
    assert.match(html, new RegExp(title));
  }
  for (const title of ['Ship notes', 'Restore backup', 'Retire job']) {
    assert.equal(html.includes(title), false, title);
  }
  assert.match(html, /已阻塞/);
  assert.match(html, /已暂停/);
  assert.equal(html.includes('已完成'), false);
  assert.equal(html.includes('失败'), false);
  assert.equal(html.includes('已取消'), false);
});

test('the panel follows the in-progress count without a reload [AC:bot-goals-panel-rules#AC-7]', () => {
  const running = goal('g-r', 'Fix login', 'running');
  const queued = goal('g-q', 'Queue the rollout', 'queued');
  const done = goal('g-c', 'Ship notes', 'completed');
  assert.equal(render([running, done]), '');
  const shown = render([running, queued, done]);
  assert.match(shown, /目标与进展 \(2\)/);
  assert.match(shown, /Fix login/);
  assert.match(shown, /Queue the rollout/);
  assert.equal(shown.includes('Ship notes'), false);
  assert.equal(render([done, queued]), '');
  assert.match(render([running, queued]), /目标与进展 \(2\)/);
  assert.equal(render([running]), '');
});

const slots: Array<{ value: unknown }> = [];
const realUseState = React.useState;
const realUseRef = React.useRef;
const realUseEffect = React.useEffect;
let replay = false;

function memoryUseState<T,>(initial: T): [T, (action: T | ((value: T) => T)) => void] {
  const slot = replay ? slots[memoryUseState.cursor++]! : (() => { const created = { value: initial as unknown }; slots.push(created); return created; })();
  const set = (action: T | ((value: T) => T)) => {
    slot.value = typeof action === 'function' ? (action as (value: T) => T)(slot.value as T) : action;
  };
  return [slot.value as T, set];
}
memoryUseState.cursor = 0;

function installMemoryState() {
  slots.length = 0;
  replay = false;
  React.useState = memoryUseState as typeof React.useState;
  React.useRef = ((initial: unknown) => ({ current: initial })) as typeof React.useRef;
  React.useEffect = (() => undefined) as typeof React.useEffect;
}

function renderReview(): React.ReactElement {
  memoryUseState.cursor = 0;
  if (slots.length === 0) replay = false;
  React.useState = memoryUseState as typeof React.useState;
  const element = (BotGoals as unknown as (props: Record<string, unknown>) => React.ReactElement)({
    botId: 'bot-a',
    sessionId: 'sess-current',
    initialSnapshot: {
      goals: [goal('g-review', 'Check the report', 'pending_review'), goal('g-run', 'Keep watching', 'running')],
      settings,
    },
  });
  replay = true;
  return element;
}

type SubmitEvent = { preventDefault(): void; currentTarget: { elements: { namedItem(name: string): { value?: string } | null } } };

function controls(node: React.ReactNode, found: { accept?: () => void | Promise<void>; openReject?: () => void; submit?: (event: SubmitEvent) => void | Promise<void> } = {}): typeof found {
  if (!React.isValidElement(node)) return found;
  const element = node as React.ReactElement<{ 'data-testid'?: string; onClick?: () => void; onSubmit?: (event: SubmitEvent) => void; children?: React.ReactNode }>;
  const id = element.props['data-testid'];
  if (id === 'bot-goal-verify-g-review' && element.props.onClick) found.accept = element.props.onClick;
  if (id === 'bot-goal-reject-g-review' && element.props.onClick) found.openReject = element.props.onClick;
  if (id === 'bot-goal-reject-form-g-review' && element.props.onSubmit) found.submit = element.props.onSubmit;
  React.Children.forEach(element.props.children, child => controls(child, found));
  return found;
}

test('pending review can accept or send the completion back', async () => {
  const html = render([
    goal('g-review', 'Check the report', 'pending_review'),
    goal('g-run', 'Keep watching', 'running'),
  ]);
  assert.match(html, /核对完成/);
  assert.match(html, /打回/);
  assert.equal(html.includes('bot-goal-reject-g-run'), false);
  posted.length = 0;
  installMemoryState();
  BotGoals = loadPanel();
  try {
    const first = controls(renderReview());
    assert.equal(typeof first.openReject, 'function');
    assert.equal(first.submit, undefined);
    await first.accept!();
    assert.deepEqual(posted.at(-1), {
      path: '/api/bots/bot-a/goals/g-review/actions',
      body: { sessionId: 'sess-current', action: 'verify', accepted: true },
    });
    first.openReject!();
    const opened = controls(renderReview());
    assert.equal(typeof opened.submit, 'function');
    await opened.submit!({
      preventDefault() {},
      currentTarget: { elements: { namedItem: (name: string) => name === 'reason' ? { value: '还差最后一项核对' } : null } },
    });
    assert.deepEqual(posted.at(-1), {
      path: '/api/bots/bot-a/goals/g-review/actions',
      body: { sessionId: 'sess-current', action: 'verify', accepted: false, reason: '还差最后一项核对' },
    });
  } finally {
    React.useState = realUseState;
    React.useRef = realUseRef;
    React.useEffect = realUseEffect;
  }
});

test('a single review or blocked goal has an independent actionable card [AC:bot-goal-lifecycle-boundaries#AC-3]', () => {
 const html=render([goal('review','Review result','pending_review')]);
 assert.match(html,/bot-goal-attention/);assert.match(html,/bot-goal-verify-review/);assert.match(html,/bot-goal-reject-review/);
 assert.doesNotMatch(html,/data-testid="bot-goals"/);
 assert.match(render([goal('blocked','Budget stop','blocked')]),/bot-goal-extend-blocked/);
 assert.doesNotMatch(render([goal('running','Work','running')]),/bot-goal-attention/);
});
