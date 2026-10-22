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
import { zh } from '../lib/i18n/messages/zh/index.ts';
import type { SessionSummary } from '../lib/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

function t(key: string, vars?: Record<string, string | number>): string {
  return translate(zh, key, vars);
}

const jsx = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
} as const;

function loadTsx(filename: string): Record<string, unknown> {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: jsx }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => resolveImport(filename, id);
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

function resolveImport(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return createRequire(fromFile)(id);
  if (id.endsWith('.css')) return {};
  if (id === '@/lib/i18n') return { useI18n: () => ({ t, locale: 'zh' }) };
  if (id === './ui') {
    return {
      EmptyState: (props: { title?: string; description?: string; action?: React.ReactNode }) =>
        React.createElement('div', null, props.title, props.description, props.action)
    };
  }
  if (id === './TrajectoryPanel') return { TrajectoryPanel: () => null };
  if (id.startsWith('@/')) {
    const base = path.join(webRoot, id.slice(2));
    const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.tsx`) ? `${base}.tsx` : base;
    if (file.endsWith('.tsx')) return loadTsx(file);
    return createRequire(fromFile)(file);
  }
  const resolved = path.resolve(path.dirname(fromFile), id);
  const tsxFile = existsSync(`${resolved}.tsx`) ? `${resolved}.tsx` : resolved.endsWith('.tsx') ? resolved : '';
  if (tsxFile) return loadTsx(tsxFile);
  const tsFile = existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved;
  return createRequire(fromFile)(tsFile);
}

const { OpsPanel } = loadTsx(path.join(here, 'OpsPanel.tsx')) as {
  OpsPanel: React.ComponentType<Record<string, unknown>>;
};
const { TraceTurnList } = loadTsx(path.join(here, 'TraceTurnList.tsx')) as {
  TraceTurnList: React.ComponentType<Record<string, unknown>>;
};
const { groupTraceEvents } = createRequire(import.meta.url)('../lib/trace-groups.ts') as {
  groupTraceEvents: (rows: Array<{ kind: string; ts: string; payload?: unknown }>) => unknown[];
};

const session = {
  id: 's1',
  title: 'long',
  agentId: 'general',
  status: 'idle',
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z'
} as SessionSummary;

test('[AC:ops-session-trace-repair#AC-5] ops page says earlier records are hidden', () => {
  const html = renderToStaticMarkup(
    React.createElement(OpsPanel, {
      active: true,
      sessions: [session],
      selectedSessionId: 's1',
      onSelectSession: () => {},
      traceRows: [{ kind: 'turn_start', ts: '2026-10-22T00:00:00.000Z', payload: { userText: '开头还在' } }],
      omittedEarlier: 12,
      traceError: false,
      traceLoaded: true
    })
  );
  assert.match(html, /还有 12 条更早的记录没有显示/);
  assert.match(html, /开头还在/);
});

test('[AC:ops-session-trace-repair#AC-6] an unmet goal is visible in the error row', () => {
  const groups = groupTraceEvents([
    { kind: 'turn_start', ts: '2026-10-22T00:00:00.000Z' },
    {
      kind: 'goal_eval',
      ts: '2026-10-22T00:00:01.000Z',
      payload: { met: false, reason: 'goal not met', goal: '把登录修到能打开' }
    },
    { kind: 'turn_end', ts: '2026-10-22T00:00:02.000Z' }
  ]);
  const html = renderToStaticMarkup(
    React.createElement(TraceTurnList, { groups, bulk: { version: 0, open: false } })
  );
  assert.match(html, /目标还没达成/);
  assert.match(html, /把登录修到能打开/);
  assert.match(html, /goal not met/);
});
