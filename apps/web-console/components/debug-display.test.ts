import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
test('debug gate does not mount hidden diagnostics and restores them when enabled [AC:global-debug-visibility#AC-1]', () => {
  let enabled = false;
  let mounts = 0;
  const source = readFileSync(new URL('./DebugDisplay.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as { DebugOnly: React.ComponentType<React.PropsWithChildren> } };
  const load = (id: string) => {
    if (id === 'react') return { ...React, useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => snapshot() };
    if (id === '@/lib/debug-display') return { readDebugDisplay: () => enabled, subscribeDebugDisplay: () => () => {} };
    if (id === '@/lib/api' || id === '@/lib/i18n' || id === './ui') return {};
    return require(id);
  };
  new Function('require', 'module', 'exports', compiled)(load, module, module.exports);
  const Child = () => { mounts++; return React.createElement('span', null, 'diagnostic'); };
  const render = () => renderToStaticMarkup(React.createElement(module.exports.DebugOnly, null, React.createElement(Child)));
  assert.equal(render(), '');
  assert.equal(mounts, 0);
  enabled = true;
  assert.match(render(), /diagnostic/);
  assert.equal(mounts, 1);
  enabled = false;
  assert.equal(render(), '');
  assert.equal(mounts, 1);
});
