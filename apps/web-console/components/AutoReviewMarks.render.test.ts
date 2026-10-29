import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);

function load(): Record<string, any> {
  const source = readFileSync(new URL('./AutoReviewMarks.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => {
    if (id === '@/lib/i18n') {
      return { useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => translate(zh, key, vars) }) };
    }
    if (id === '@/lib/auto-review-card') return localRequire('../lib/auto-review-card.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

const { ApprovalReasonLine } = load();
const SHELL_BLOCK = 'Shell command matches a high-risk pattern and was blocked until you approve it.';
const MCP_BLOCK = 'MCP tool call can change external state and was blocked until you approve it.';

test('chat approval card shows a Shell badge and the block reason [AC:auto-review-shell-mcp#AC-6]', () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalReasonLine, {
      approval: {
        toolName: 'bash',
        reason: `Auto-review (shell) blocked high-risk bash: ${SHELL_BLOCK}`
      }
    })
  );
  assert.match(html, /data-kind="shell"/);
  assert.match(html, /Shell/);
  assert.match(html, /拦截原因/);
  assert.match(html, new RegExp(SHELL_BLOCK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /data-kind="mcp"/);
});

test('chat approval card shows an MCP badge and that block reason [AC:auto-review-shell-mcp#AC-7]', () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalReasonLine, {
      approval: {
        toolName: 'mcp_invoke',
        reason: `Auto-review (mcp) blocked high-risk mcp_invoke: ${MCP_BLOCK}`
      }
    })
  );
  assert.match(html, /data-kind="mcp"/);
  assert.match(html, />MCP</);
  assert.match(html, /拦截原因/);
  assert.match(html, new RegExp(MCP_BLOCK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /data-kind="shell"/);
});

test('an ask-user card does not show an Auto-review kind badge [AC:auto-review-shell-mcp#AC-8]', () => {
  const html = renderToStaticMarkup(
    React.createElement(ApprovalReasonLine, {
      approval: { toolName: 'ask_user', reason: 'Needs more information from you' },
      fallback: 'Needs more information from you'
    })
  );
  assert.doesNotMatch(html, /data-auto-review/);
  assert.doesNotMatch(html, /data-kind/);
  assert.doesNotMatch(html, /拦截原因/);
  assert.match(html, /Needs more information from you/);
});
