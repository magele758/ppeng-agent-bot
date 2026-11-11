import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
const require = createRequire(import.meta.url);
function load(messages: typeof zh | typeof en) {
  const code = ts.transpileModule(readFileSync(new URL('./LangfuseDeliveryStatus.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const module = { exports: {} as { LangfuseDeliveryStatus: (props: any) => React.ReactElement | null } };
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id === '@/lib/i18n') return {useI18n:()=>({t:(key:string,vars:any)=>translate(messages,key,vars)})};
    return require(id);
  }, module, module.exports);
  return module.exports.LangfuseDeliveryStatus;
}
const snapshot={attempted:5,succeeded:1,failed:4,inFlight:0,lastSuccessAt:'2026-11-11T08:00:00Z',lastFailureAt:'2026-11-11T08:01:00Z',lastError:'HTTP 401'};
test('Lab shows actual delivery counters, safe translated reasons and refresh [AC:langfuse-delivery-health#AC-1]',async()=>{
  for(const messages of [zh,en]) {
    let refreshed=0;
    const View=load(messages);
    const props={status:snapshot,busy:false,onRefresh:async()=>{refreshed++;}};
    const html=renderToStaticMarkup(React.createElement(View,props));
    assert.match(html,/5/);assert.match(html,/4/);assert.match(html,/401/);
    assert.match(html,/2026-11-11T08:00:00Z/);
    assert.doesNotMatch(html,/settingsEntries|invalid_response|ingestion_errors/);
    const element=View(props)!;
    const button=(element.props as any).children.find((child:any)=>child?.type==='button');
    await button.props.onClick();assert.equal(refreshed,1);
    for(const lastError of ['network','timeout','invalid_response','ingestion_errors']) {
      const errorHtml=renderToStaticMarkup(React.createElement(View,{...props,status:{...snapshot,lastError}}));
      assert.doesNotMatch(errorHtml, /settingsEntries|invalid_response|ingestion_errors/);
    }
    assert.match(renderToStaticMarkup(React.createElement(View,{...props,busy:true})),/disabled/);
  }
  const card=readFileSync(new URL('./LangfuseSettingsCard.tsx',import.meta.url),'utf8');
  assert.match(card,/status=\{r\.effective\?\.delivery\}/);
  assert.match(card,/onRefresh=\{r\.reload\}/);
});
