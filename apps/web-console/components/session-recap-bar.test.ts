import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { SessionRecapBarProps } from './SessionRecapBar';

const require = createRequire(import.meta.url);
function loadBar() {
  const compiled = ts.transpileModule(readFileSync(new URL('./SessionRecapBar.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const module = { exports: {} as { SessionRecapBar: React.ComponentType<SessionRecapBarProps> } };
  const load = (id: string) => id === '@/lib/i18n' ? { useI18n: () => ({ t: (key: string) => key }) } : require(id);
  new Function('require', 'module', 'exports', compiled)(load, module, module.exports);
  return module.exports.SessionRecapBar;
}
const base = { shown: true, canManual: true, text: '', requestManual() {}, dismiss() {} };
test('no recap content shows only a manual retry button [AC:recap-content-only#AC-1]', () => {
  const Bar = loadBar();
  for (const state of [{status:'failed',text:'这次没回顾成'}, {status:'done',text:'  '}, {status:'hidden',shown:false}] as const) {
    const html = renderToStaticMarkup(React.createElement(Bar, { ...base, ...state }));
    assert.match(html, /data-testid="session-recap-manual"/);
    assert.doesNotMatch(html, /role="status"|这次没回顾成|disabled/);
  }
  assert.equal(renderToStaticMarkup(React.createElement(Bar, { ...base, shown:false, canManual:false, status:'hidden' })), '');
});
test('loading disables manual action and only completed text becomes a card [AC:recap-content-only#AC-2]', () => {
  const Bar = loadBar();
  const loading = renderToStaticMarkup(React.createElement(Bar, { ...base, status:'loading',text:'pending' }));
  assert.match(loading, /disabled/);
  assert.match(loading, /session-recap-manual/);
  assert.doesNotMatch(loading, /role="status"|pending/);
  const done = renderToStaticMarkup(React.createElement(Bar, { ...base, status:'done',text:'进展已整理' }));
  assert.match(done, /role="status"/);
  assert.match(done, /进展已整理/);
  assert.match(done, /play.sessionRecap.dismiss/);
  assert.doesNotMatch(done, /session-recap-manual/);
  const dismissed = renderToStaticMarkup(React.createElement(Bar, { ...base, shown:false,status:'hidden',text:'old' }));
  assert.match(dismissed, /session-recap-manual/);
  assert.doesNotMatch(dismissed, /old/);
});
