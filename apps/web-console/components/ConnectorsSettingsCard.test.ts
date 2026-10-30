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
import { connectorViews, type ConnectorView } from '../lib/connectors-grant.ts';
import { matchesQuery } from '../lib/settings-search.ts';
import type { Messages } from '../lib/i18n/messages/types.ts';

const localRequire = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cardFile = path.join(webRoot, 'components/ConnectorsSettingsCard.tsx');
const toolsFile = path.join(webRoot, 'components/sections/settings/categories/tools.tsx');
const fieldsFile = path.join(webRoot, 'components/sections/settings/categories/kit/fields.tsx');

const SECRET = 'super-secret-acme-value';

const wire = [
  { id: 'plugin:plain', title: 'Plain', source: 'plugin', authKind: 'header', granted: false, authState: 'needsAuth' },
  {
    id: 'plugin:acme',
    title: 'Acme',
    source: 'plugin',
    authKind: 'bearer',
    secretEnv: 'ACME_TOKEN',
    granted: false,
    authState: 'needsGrant'
  },
  { id: 'domain:sre', title: 'SRE', source: 'domain', authKind: 'none', granted: true, authState: 'granted' }
];

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

function loadList(messages: Messages): {
  html: (rows: ConnectorView[], secrets?: Array<{ name: string }>, onGrant?: (row: ConnectorView) => void) => string;
  click: (id: string) => void;
  grants: GrantCall[];
  postConnectorGrant: (
    row: ConnectorView,
    pickedName: string | undefined,
    post: (path: string, body: { secretEnv?: string; credRef?: string }) => Promise<unknown>
  ) => Promise<void>;
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
      return { useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(messages, key, vars) }) };
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
  const List = loaded.ConnectorAuthList as (props: Record<string, unknown>) => React.ReactElement;
  const postConnectorGrant = loaded.postConnectorGrant as (
    row: ConnectorView,
    pickedName: string | undefined,
    post: (path: string, body: { secretEnv?: string; credRef?: string }) => Promise<unknown>
  ) => Promise<void>;
  const cardSource = readFileSync(cardFile, 'utf8');
  assert.match(cardSource, /ConnectorAuthList/);
  assert.match(cardSource, /postConnectorGrant\(row, name\)/);
  assert.match(cardSource, /export async function postConnectorGrant/);
  return {
    grants,
    postConnectorGrant,
    html(rows, secrets = [{ name: 'ACME_TOKEN' }], onGrant) {
      clicks.clear();
      const html = renderToStaticMarkup(React.createElement(List, {
        rows,
        secrets,
        picks: {},
        busyId: null,
        rowError: null,
        onPick() {},
        onGrant: onGrant ?? (() => undefined),
        onRevoke() {},
        onRefresh() {}
      }));
      return html;
    },
    click(id: string) {
      const click = clicks.get(id);
      if (!click) throw new Error(`no grant button for ${id}`);
      click();
    }
  };
}

test('Connectors card shows needsAuth, needsGrant, and granted in zh and en [AC:connector-authorization#AC-4]', () => {
  const tools = readFileSync(toolsFile, 'utf8');
  const fields = readFileSync(fieldsFile, 'utf8');
  assert.match(tools, /id:\s*'connectors'/);
  assert.match(tools, /ConnectorsSettingsCard/);
  assert.match(fields, /settingsEntries\.common\.loadFailed/);
  const zhHay = [zh.settingsEntries.connectors.title, zh.settingsEntries.connectors.keywords].join(' ');
  const enHay = [en.settingsEntries.connectors.title, en.settingsEntries.connectors.keywords].join(' ');
  assert.equal(matchesQuery(zhHay, '连接器'), true);
  assert.equal(matchesQuery(enHay, 'grant'), true);

  const rows = connectorViews({ connectors: wire });
  const zhCard = loadList(zh);
  const html = zhCard.html(rows);
  assert.match(html, /data-state="needsAuth"/);
  assert.match(html, /data-state="needsGrant"/);
  assert.match(html, /data-state="granted"/);
  assert.match(html, /需要密钥引用/);
  assert.match(html, /可以授权/);
  assert.match(html, /data-auth-state="needsAuth"/);
  assert.match(html, /data-auth-state="needsGrant"/);
  assert.match(html, /data-auth-state="granted"/);
  assert.match(html, /ACME_TOKEN/);
  assert.match(html, /id="connector-secret-plugin:plain"/);
  assert.equal(html.includes(SECRET), false);
  assert.doesNotMatch(html, /type="password"/);

  const enHtml = loadList(en).html(rows);
  assert.match(enHtml, /Needs a vault reference/);
  assert.match(enHtml, /Ready to grant/);
  assert.match(enHtml, />Grant</);
  assert.doesNotMatch(enHtml, /需要密钥引用/);
});

test('one-click grant posts the SecretVault name and not a secret value [AC:connector-authorization#AC-3]', async () => {
  const rows = connectorViews({ connectors: wire });
  const card = loadList(en);
  const posted: Array<{ path: string; body: unknown }> = [];
  const html = card.html(rows, [{ name: 'ACME_TOKEN' }], (row) => {
    void card.postConnectorGrant(row, row.secretEnv, async (path, body) => {
      posted.push({ path, body });
    });
  });
  card.click('plugin:acme');
  await Promise.resolve();
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { path: '/api/connectors/plugin%3Aacme/grant', body: { secretEnv: 'ACME_TOKEN' } });
  assert.equal(JSON.stringify(posted).includes(SECRET), false);
  assert.doesNotMatch(html, /id="connector-secret-plugin:acme"/);
});

test('a failed connector list shows the error and no fake grant [AC:connector-authorization#AC-4]', () => {
  const failed = translate(zh, 'settingsEntries.connectors.loadFailed');
  const gate = translate(zh, 'settingsEntries.common.loadFailed', { error: 'offline' });
  assert.match(failed, /无法读取连接器/);
  assert.match(gate, /设置加载失败：offline/);
  assert.equal(connectorViews(null).length, 0);
  assert.equal(JSON.stringify(connectorViews({ connectors: wire })).includes(SECRET), false);
});
