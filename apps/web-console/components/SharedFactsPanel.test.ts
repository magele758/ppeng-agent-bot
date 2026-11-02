import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load() {
  const code = ts.transpileModule(readFileSync(new URL('./SharedFactsPanel.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as { SharedFactsPanel: React.ComponentType<any> } };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === 'react') return {...React, useState: () => [{}, () => {}], useEffect: () => {}};
    if (id === 'react-dom') return {createPortal: (children: React.ReactNode) => children};
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => key }) };
    if (id === './BotEntryDialog') return { BotEntryDialog: ({children}: any) => React.createElement('div', {role:'dialog'}, children) };
    if (id.endsWith('.module.css')) return { default: new Proxy({}, {get: (_, key) => key}) };
    return require(id);
  }, module, module.exports);
  return module.exports.SharedFactsPanel;
}
test('closed shared facts occupies only an entry [AC:shared-info-compact#AC-1]', () => {
  const html = renderToStaticMarkup(React.createElement(load(), {open:false,busy:false,onOpen:()=>{},onClose:()=>{}}, React.createElement('input')));
  assert.match(html,/aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<input|role="dialog"/);
});
test('open shared facts presents independent scrollable editor and close [AC:shared-info-compact#AC-2]', () => {
  const html = renderToStaticMarkup(React.createElement(load(), {open:true,busy:false,onOpen:()=>{},onClose:()=>{}}, React.createElement('textarea')));
  assert.match(html,/role="dialog"/); assert.match(html,/<textarea/);
  assert.match(html,/common.close/); assert.match(html,/sharedBody/);
});
