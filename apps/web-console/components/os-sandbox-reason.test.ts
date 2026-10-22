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

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
const i18n = {
  useI18n: () => ({
    locale: 'zh' as const,
    messages: zh,
    setLocale: () => undefined,
    t: (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars)
  })
};
const loaded = new Map<string, Record<string, unknown>>();

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
  }
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = loaded.get(resolved);
  if (cached) return cached;
  if (resolved.endsWith('.css')) return {};
  const compiled = ts.transpileModule(readFileSync(resolved, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  loaded.set(resolved, mod.exports);
  const requireFrom = (id: string) => requireId(resolved, id);
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

function requireId(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
  if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18n;
  if (id.endsWith('.css')) return {};
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)));
  return localRequire(id);
}

const ui = loadFile(path.join(here, 'ChatTurns.tsx')) as {
  ChatTurnFromMessage: React.ComponentType<Record<string, unknown>>;
};

function renderResult(content: string): string {
  return renderToStaticMarkup(
    React.createElement(ui.ChatTurnFromMessage, {
      m: {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'ssh-1', name: 'bash', ok: false, content }]
      }
    })
  );
}

test('the conversation shows why this shell stayed in the OS sandbox [AC:saved-sandbox-mode-constrains-shell#AC-2] [AC:saved-sandbox-mode-constrains-shell#AC-3]', () => {
  const saved = renderResult('[os-sandbox:saved-os] This command ran inside the OS sandbox because the saved isolation mode is OS-level.');
  assert.match(saved, /data-testid="os-sandbox-reason"/);
  assert.match(saved, /系统级隔离/);
  assert.match(saved, /没有改成直接执行/);

  const auto = renderResult('ssh: Permission denied\n[os-sandbox:auto-strongest] strongest');
  assert.match(auto, /自动/);
  assert.match(auto, /没有改成直接执行/);

  const picked = renderResult('{"os_sandbox_note":"[os-sandbox:auto-model-os] picked"}');
  assert.match(picked, /这次命令选了系统级隔离/);

  const direct = renderResult('OpenSSH_9.0');
  assert.equal(direct.includes('data-testid="os-sandbox-reason"'), false);
  assert.equal(direct.includes('系统沙箱'), false);
});
