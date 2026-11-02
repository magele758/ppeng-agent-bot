import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
const require = createRequire(import.meta.url);
function load(result: unknown, component = 'ApprovalExplanation') {
  const code = ts.transpileModule(readFileSync(new URL('./'+component+'.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} as Record<string, React.ComponentType<any>> };
  const dependency = (id: string) => {
    if (id === 'react') return {...React, useState: () => [result, () => {}], useEffect: () => {}};
    if (id === '@/lib/i18n') return {useI18n: () => ({locale:'zh',t:(key: string,vars?: Record<string,string>)=>translate(zh,key,vars)})};
    if (id === '@/lib/api') return {};
    if (id.startsWith('@/lib/')) return require('../lib/'+id.slice('@/lib/'.length)+'.ts');
    return require(id);
  };
  new Function('require','module','exports',code)(dependency,module,module.exports);
  return module.exports[component];
}
const props = {approval:{id:'a',toolName:'bash',args:{command:'rm -rf /tmp/review'}},face:{kind:'shell',blockReason:'Shell high risk. Prior note: Shell high risk.'}};
test('approval explains action and risk before collapsed raw reason [AC:approval-explanations#AC-1]', () => {
  const html = renderToStaticMarkup(React.createElement(load({action:'读取临时仓库，退出后清理',risk:'清理会删除临时目录，需核对路径'}),props));
  assert.match(html,/将执行什么/); assert.match(html,/为什么需要确认/);
  assert.match(html,/读取临时仓库/); assert.match(html,/核对路径/);
  assert.match(html,/<details/); assert.doesNotMatch(html,/Prior note:|<details[^>]*open/);
  assert.match(html,/递归删除/); // The model cannot remove the rule-based explanation.
});
test('model failure still leaves a usable explanation and raw facts [AC:approval-explanations#AC-3]', () => {
  const html = renderToStaticMarkup(React.createElement(load(null),props));
  assert.match(html,/具体命令和参数/); assert.match(html,/递归删除/); assert.match(html,/Shell high risk/);
  assert.doesNotMatch(html,/disabled|出错|失败/);
});

test('actual shell commands are visible without expanding JSON [AC:approval-explanations#AC-1]', () => {
  const html = renderToStaticMarkup(React.createElement(load(null,'ApprovalActionPreview'), {args:{command:'printf hello\nprintf world',verify_command:'git status',token:'secret'}}));
  assert.ok(html.indexOf('printf hello') < html.indexOf('<details'));
  assert.match(html,/printf hello\nprintf world/); assert.match(html,/git status/);
  assert.doesNotMatch(html,/secret/);
});
