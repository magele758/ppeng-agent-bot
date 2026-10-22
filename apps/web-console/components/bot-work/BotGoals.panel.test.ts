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
    if (id === 'react') return React;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: translate }) };
    if (id === '@/lib/api') return { api: async () => ({}) };
    if (id === '@/lib/bot-goals') return localRequire('../../lib/bot-goals.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports.BotGoals!;
}

const BotGoals = loadPanel();

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
