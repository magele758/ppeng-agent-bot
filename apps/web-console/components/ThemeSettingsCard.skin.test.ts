import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { translate } from '../lib/i18n/t.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function t(key: string): string {
  return translate(zh, key);
}
const nodeRequire = createRequire(import.meta.url);
function loadCard(): React.ComponentType {
  const filename = path.join(here, 'ThemeSettingsCard.tsx');
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as { ThemeSettingsCard?: React.ComponentType } };
  const req = (id: string) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime');
    if (id === '@/lib/i18n') return { useI18n: () => ({ t }) };
    if (id === '@/lib/theme') return {
      THEME_CHANGED_EVENT: 'ppeng-theme-changed',
      applyThemePreference: () => {},
      readThemePreference: () => 'dark'
    };
    if (id === '@/lib/skin') return {
      SKIN_CHANGED_EVENT: 'ppeng-skin-changed',
      SKIN_IDS: ['classic', 'sanctum', 'cyberpunk', 'demon', 'robot-stage', 'pixel', 'kindergarten', 'minimal'],
      applySkin: () => {},
      readSkin: () => 'classic'
    };
    if (id === './ui') return {
      SettingsGroup: ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) =>
        React.createElement('section', null, React.createElement('h3', null, title), React.createElement('p', null, description), children)
    };
    throw new Error(`unexpected import ${id}`);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  const Card = mod.exports.ThemeSettingsCard;
  if (!Card) throw new Error('ThemeSettingsCard missing');
  return Card;
}

test('设置里经典和圣所与深浅色分开 [AC:sanctum-skin#AC-1] [AC:sanctum-skin#AC-2]', () => {
  const html = renderToStaticMarkup(React.createElement(loadCard()));
  assert.match(html, new RegExp(`aria-label="${zh.settings.skin.label}"`));
  assert.match(html, new RegExp(`name="skin-preference"[^>]*value="classic"`));
  assert.match(html, new RegExp(`name="skin-preference"[^>]*value="sanctum"`));
  assert.match(html, />经典</);
  assert.match(html, />圣所</);
  assert.match(html, />赛博朋克</);
  assert.match(html, />恶魔的聚会</);
  assert.match(html, />机器人大舞台</);
  assert.match(html, />像素</);
  assert.match(html, />童趣幼儿园</);
  assert.match(html, />极简黑白</);
  assert.match(html, /name="theme-preference"/);
  assert.match(html, />深色</);
  assert.match(html, />浅色</);
  assert.match(html, />跟随系统</);
  assert.equal(zh.common.skinToSanctum, '切换到圣所外观');
  assert.equal(zh.common.skinToClassic, '切回经典外观');
});
