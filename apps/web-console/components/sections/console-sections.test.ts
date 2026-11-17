import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../../lib/i18n/t.ts';
import { zh } from '../../lib/i18n/messages/zh/index.ts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localRequire = createRequire(import.meta.url);

test('其余页面只用外壳的 --ui-home-*，不另起色板 [AC:console-sections-redesign#AC-4]', () => {
  const css = readFileSync(path.join(webRoot, 'components/sections/console-sections.css'), 'utf8');
  const frame = readFileSync(path.join(webRoot, 'components/sections/SectionFrame.tsx'), 'utf8');
  const settings = readFileSync(path.join(webRoot, 'components/sections/settings/SettingsSection.tsx'), 'utf8');
  const nav = readFileSync(path.join(webRoot, 'lib/nav.ts'), 'utf8');
  const tokens = readFileSync(path.join(webRoot, 'styles/tokens.css'), 'utf8');
  const shell = readFileSync(path.join(webRoot, 'styles/shell.css'), 'utf8');
  for (const name of ['accent', 'bg', 'surface', 'line', 'danger', 'shadow', 'title']) {
    assert.match(css, new RegExp(`var\\(--ui-home-${name},`));
  }
  assert.match(css, /var\(--ui-home-accent, var\(--ui-accent\)\)/);
  assert.match(css, /\.ui-empty/);
  assert.match(css, /\[role='alert'\]/);
  assert.match(css, /\.settings-load/);
  assert.match(css, /box-shadow:\s*var\(--ui-home-shadow, none\)/);
  assert.doesNotMatch(css, /#(?:3D6A4D|82BD95|F4F5F2|111411)/i);
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(css, /⌘K|command-k|CommandPalette/i);
  assert.match(frame, /console-sections\.css/);
  assert.match(frame, /console-section/);
  assert.match(settings, /console-sections\.css/);
  assert.match(settings, /console-section/);
  assert.equal(css.includes('--ui-home-accent:'), false);
  assert.doesNotMatch(tokens, /console-sections/);
  assert.doesNotMatch(shell, /console-sections/);
  assert.match(nav, /SECTION_IDS = \['bot', 'chat', 'agents', 'tasks', 'knowledge', 'settings'\]/);
  assert.match(nav, /tasks: \['queue', 'bots', 'flows', 'runs', 'inbox'\]/);
  assert.match(nav, /settings: \['general', 'models', 'behavior', 'safety', 'tools', 'integrations', 'experimental', 'ops'\]/);
  assert.equal(nav.includes("'ops'") && nav.includes("section: 'ops'"), false);
  assert.doesNotMatch(readFileSync(path.join(webRoot, 'components/sections/chat/ChatSection.tsx'), 'utf8'), /console-sections/);
});

test('审批卡有本会话始终允许，提问没有 [AC:console-sections-redesign#AC-1]', () => {
  const source = readFileSync(path.join(webRoot, 'components/SessionAllowButton.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => {
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => translate(zh, key, vars) }) };
    if (id === '@/lib/session-tool-grant') return {
      isolationClass: (mode: string) => mode,
      isolationLabel: (mode: string) => mode,
      isolationModeOf: () => 'os'
    };
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  const Button = mod.exports.SessionAllowButton as (props: { approval: { id: string; toolName: string }; onAllow: (id: string) => void }) => React.ReactElement | null;
  const allowed = renderToStaticMarkup(React.createElement(Button, { approval: { id: 'a', toolName: 'bash' }, onAllow: () => undefined }));
  const ask = renderToStaticMarkup(React.createElement(Button, { approval: { id: 'q', toolName: 'ask_user' }, onAllow: () => undefined }));
  assert.match(allowed, /本会话始终允许/);
  assert.equal(ask, '');
  assert.match(readFileSync(path.join(webRoot, 'components/sections/tasks/InboxView.tsx'), 'utf8'), /SessionAllowButton/);
  assert.match(readFileSync(path.join(webRoot, 'components/sections/tasks/InboxView.tsx'), 'utf8'), /SessionGrantList/);
  assert.match(readFileSync(path.join(webRoot, 'components/ApprovalBanner.tsx'), 'utf8'), /sessionGrant: true|approvalPostInit\(sessionGrant\)|approvalPostInit\(true\)|sessionGrant/);
});
