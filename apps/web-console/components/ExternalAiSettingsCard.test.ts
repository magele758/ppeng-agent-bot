import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { matchesQuery } from '../lib/settings-search.ts';
import type { Messages } from '../lib/i18n/messages/types.ts';

const localRequire = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cardFile = path.join(webRoot, 'components/ExternalAiSettingsCard.tsx');
const toolsCategoryFile = path.join(webRoot, 'components/sections/settings/categories/tools.tsx');

interface ExternalAiSettingsView {
  enabled: boolean;
  allowInBotChats: boolean;
  preferredTool: 'auto' | 'claude_code' | 'codex_exec' | 'cursor_agent';
  cursorAgentModel: string;
}

interface DetectedAgentView {
  toolName: 'claude_code' | 'codex_exec' | 'cursor_agent';
  label: string;
  command: string;
  installed: boolean;
  resolvedBinary?: string;
}

function resolveModule(fromFile: string, id: string): string | null {
  if (!id.startsWith('.') && !id.startsWith('@/')) return null;
  const base = id.startsWith('@/') ? path.join(webRoot, id.slice(2)) : path.resolve(path.dirname(fromFile), id);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function loadCard(options: {
  messages: Messages;
  settings: ExternalAiSettingsView | null;
  detectedAgents?: DetectedAgentView[];
  loadError?: string | null;
}) {
  const saves: Array<{ path: string; patch: Record<string, unknown> }> = [];
  const captured: {
    html: string;
    saves: typeof saves;
    toggles: Record<string, (v: boolean) => void>;
    selects: Record<string, (v: string) => void>;
  } = { html: '', saves, toggles: {}, selects: {} };

  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
  };
  const watch = (orig: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
    if (typeof props?.id === 'string' && typeof props.onChange === 'function') {
      if (props.id.startsWith('field-externalAi-') && props.type !== 'checkbox' && 'checked' in props) {
        captured.toggles[props.id] = props.onChange as (v: boolean) => void;
      }
      if (props.id === 'field-externalAi-preferredTool' && 'options' in props) {
        captured.selects[props.id] = props.onChange as (v: string) => void;
      }
    }
    return orig(type, props, key);
  };
  const wrappedJsx = { ...jsxRuntime, jsx: watch(jsxRuntime.jsx), jsxs: watch(jsxRuntime.jsxs) };
  const cache = new Map<string, Record<string, unknown>>();

  const reqFrom = (fromFile: string) => (id: string) => {
    if (id === 'react' || id === 'react-dom' || id === 'react-dom/server') return localRequire(id);
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return wrappedJsx;
    if (id.endsWith('.css')) return {};
    if (id === '@/lib/i18n') {
      return {
        useI18n: () => ({
          t: (key: string, vars?: Record<string, string | number>) => translate(options.messages, key, vars)
        })
      };
    }
    if (id.includes('settings-store')) {
      return {
        useSettingsResource: (resourcePath: string) => ({
          settings: options.settings,
          effective: options.detectedAgents ? { detectedAgents: options.detectedAgents, source: 'lab', applyAt: 'next-step' } : null,
          loadError: options.loadError ?? null,
          busy: false,
          status: null,
          reload: async () => undefined,
          save: async (patch: Record<string, unknown>) => {
            saves.push({ path: resourcePath, patch });
            return true;
          },
          setStatus() {},
          run: async () => undefined
        })
      };
    }
    const resolved = resolveModule(fromFile, id);
    if (!resolved) return localRequire(id);
    if (resolved.endsWith('.css')) return {};
    return loadFile(resolved);
  };

  function loadFile(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      },
      fileName: file
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    cache.set(file, mod.exports);
    const runner = new Function('require', 'module', 'exports', compiled) as (
      require: (id: string) => unknown,
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>
    ) => void;
    runner(reqFrom(file), mod, mod.exports);
    return mod.exports;
  }

  const card = loadFile(cardFile).ExternalAiSettingsCard as () => React.ReactElement;
  captured.html = renderToStaticMarkup(React.createElement(card));
  return captured;
}

test('设置工具分类挂载本机编程助手卡片，中英文完整展示检测结果与可保存项 [AC:bot-coding-agent-tools#AC-5]', () => {
  const toolsCategory = readFileSync(toolsCategoryFile, 'utf8');
  assert.match(toolsCategory, /id:\s*'externalAi'/);
  assert.match(toolsCategory, /ExternalAiSettingsCard/);

  const zhEntry = zh.settingsEntries.externalAi;
  const enEntry = en.settingsEntries.externalAi;
  assert.equal(matchesQuery(`${zhEntry.title} ${zhEntry.keywords}`, '编程助手'), true);
  assert.equal(matchesQuery(`${enEntry.title} ${enEntry.keywords}`, 'coding agent'), true);

  const detected: DetectedAgentView[] = [
    { toolName: 'claude_code', label: 'Claude Code', command: 'claude', installed: true, resolvedBinary: 'claude' },
    { toolName: 'codex_exec', label: 'Codex CLI', command: 'codex', installed: true, resolvedBinary: 'codex' },
    { toolName: 'cursor_agent', label: 'Cursor Agent CLI', command: 'agent', installed: false }
  ];

  const zhCard = loadCard({
    messages: zh,
    settings: { enabled: true, allowInBotChats: true, preferredTool: 'codex_exec', cursorAgentModel: '' },
    detectedAgents: detected
  });
  assert.match(zhCard.html, /id="card-externalAi"/);
  assert.match(zhCard.html, /本机编程助手/);
  assert.match(zhCard.html, /Claude Code/);
  assert.match(zhCard.html, /已安装/);
  assert.match(zhCard.html, /未安装/);
  zhCard.toggles['field-externalAi-enabled']?.(false);
  zhCard.toggles['field-externalAi-allowInBotChats']?.(false);
  zhCard.selects['field-externalAi-preferredTool']?.('claude_code');
  assert.deepEqual(zhCard.saves, [
    { path: '/api/external-ai/settings', patch: { enabled: false } },
    { path: '/api/external-ai/settings', patch: { allowInBotChats: false } },
    { path: '/api/external-ai/settings', patch: { preferredTool: 'claude_code' } }
  ]);

  const enCard = loadCard({
    messages: en,
    settings: { enabled: false, allowInBotChats: true, preferredTool: 'auto', cursorAgentModel: 'composer-2-fast' },
    detectedAgents: detected
  });
  assert.match(enCard.html, /Local coding agents/);
  assert.match(enCard.html, /Installed/);
  assert.match(enCard.html, /Not installed/);
  assert.doesNotMatch(enCard.html, /本机编程助手/);
});
