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

const localRequire = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cardFile = path.join(webRoot, 'components/ConnectorGrantCard.tsx');
const chatFile = path.join(webRoot, 'components/ChatTurns.tsx');
const bannerFile = path.join(webRoot, 'components/ApprovalBanner.tsx');

const SECRET = 'super-secret-acme-value';

const NEEDS_GRANT = JSON.stringify({
  card: {
    kind: 'connector_grant',
    id: 'plugin:acme',
    title: 'Acme',
    authKind: 'bearer',
    secretEnv: 'ACME_TOKEN',
    authState: 'needsGrant',
    note: SECRET
  }
});

interface GrantCall {
  path: string;
  body: unknown;
}

function resolveModule(fromFile: string, id: string): string | null {
  if (!id.startsWith('.') && !id.startsWith('@/')) return null;
  const base = id.startsWith('@/') ? path.join(webRoot, id.slice(2)) : path.resolve(path.dirname(fromFile), id);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function loadCard(): {
  html: (content: string) => string;
  click: (id: string) => void;
  grants: GrantCall[];
} {
  const grants: GrantCall[] = [];
  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
  };
  const clicks = new Map<string, () => void>();
  const watch = (orig: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
    if (props && typeof props.onClick === 'function' && typeof props['data-grant'] === 'string') {
      clicks.set(props['data-grant'], props.onClick as () => void);
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
      return { useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(en, key, vars) }) };
    }
    if (id === '@/lib/api') {
      return {
        api: async (resourcePath: string, init?: RequestInit) => {
          if (init?.method === 'POST' && resourcePath.includes('/grant')) {
            grants.push({ path: resourcePath, body: init.body ? JSON.parse(String(init.body)) : {} });
          }
          return {};
        }
      };
    }
    const resolved = resolveModule(fromFile, id);
    if (!resolved || resolved.endsWith('.css')) return resolved ? {} : localRequire(id);
    return loadFile(resolved);
  };
  function loadFile(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
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
  const loaded = loadFile(cardFile);
  const Fill = loaded.ConnectorGrantFill as (props: { content: string }) => React.ReactElement;
  return {
    grants,
    html(content: string) {
      clicks.clear();
      return renderToStaticMarkup(React.createElement(Fill, { content }));
    },
    click(id: string) {
      const click = clicks.get(id);
      if (!click) throw new Error(`no grant button for ${id}`);
      click();
    }
  };
}

test('chat grant card mounts and Grant posts a SecretVault name [AC:connector-authorization#AC-5]', async () => {
  const chat = readFileSync(chatFile, 'utf8');
  const banner = readFileSync(bannerFile, 'utf8');
  assert.match(chat, /<ConnectorGrantFill content=\{content\} modelView=\{modelView\} \/>/);
  assert.match(banner, /approvalBannerShowsGrant\(kind\)/);
  assert.match(banner, /<ConnectorGrantApproval toolName="connector_grant" args=\{args\} \/>/);

  const card = loadCard();
  const html = card.html(NEEDS_GRANT);
  assert.match(html, /data-auth-state="needsGrant"/);
  assert.match(html, /data-grant="plugin:acme"/);
  assert.match(html, />Grant</);
  assert.equal(html.includes(SECRET), false);
  assert.doesNotMatch(html, /type="password"/);

  const zhPrompt = translate(zh, 'play.approval.connectorGrantPrompt', { title: 'Acme' });
  assert.match(zhPrompt, /授权 Acme/);
  const enPrompt = translate(en, 'play.approval.connectorGrantPrompt', { title: 'Acme' });
  assert.match(enPrompt, /Grant Acme/);

  card.click('plugin:acme');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(card.grants.length, 1);
  assert.deepEqual(card.grants[0], { path: '/api/connectors/plugin%3Aacme/grant', body: { secretEnv: 'ACME_TOKEN' } });
  assert.equal(JSON.stringify(card.grants).includes(SECRET), false);
});
