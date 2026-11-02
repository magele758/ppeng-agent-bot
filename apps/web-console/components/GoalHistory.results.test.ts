import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const require = createRequire(import.meta.url);
test('history keeps unverified results and evidence without approval prompts [AC:quiet-goal-results#AC-2]', async () => {
  const states: unknown[] = [true, null, false];
  let cursor = 0;
  let effect: (() => (() => void) | void) | undefined;
  const fakeReact = new Proxy(React, { get(target, key) {
    if (key === 'useState') return () => { const index = cursor++; return [states[index], (value: unknown) => { states[index] = value; }]; };
    if (key === 'useEffect') return (fn: typeof effect) => { effect = fn; };
    return Reflect.get(target, key);
  } });
  const goals = [
    { id: 'old', title: 'Old result', status: 'pending_review', progress: 'Delivered report', evidence: ['report.txt'], blockedReason: 'Completion evidence requires verification' },
    { id: 'active', title: 'Still running', status: 'running' },
    { id: 'done', title: 'Finished task', status: 'completed' }
  ];
  const compiled = ts.transpileModule(readFileSync(new URL('./GoalHistory.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const mod = { exports: {} as { GoalHistory: (props: unknown) => React.ReactElement } };
  const load = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return fakeReact;
    if (id === '@/lib/api') return { api: async () => ({ goals }) };
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key.split('.').reduce((value: any, part: string) => value[part], zh) }) };
    return require(id);
  };
  new Function('require', 'module', 'exports', compiled)(load, mod, mod.exports);
  mod.exports.GoalHistory({ sessionId: 's', botId: 'b' });
  const cleanup = effect!();
  try {
    await new Promise(resolve => setImmediate(resolve));
    cursor = 0;
    const html = renderToStaticMarkup(mod.exports.GoalHistory({ sessionId: 's', botId: 'b' }));
    assert.match(html, /结果已返回（未自动核验）/);
    assert.match(html, /Delivered report/);
    assert.match(html, /report.txt/);
    assert.match(html, /Finished task/);
    assert.doesNotMatch(html, /Still running|requires verification|核对完成|打回|审批/);
    assert.equal(goals[0].status, 'pending_review');
  } finally { cleanup?.(); }
});
