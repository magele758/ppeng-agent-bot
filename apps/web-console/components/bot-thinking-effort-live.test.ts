import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GLOBAL_PATH = '/api/thinking-effort/settings';

type Level = 'off' | 'low' | 'medium' | 'high';

/** The daemon's global thinking effort setting, as the fake `api` sees it. */
interface Server {
  level: Level;
  reads: number;
}

function resolveModule(fromFile: string, id: string): string | null {
  if (!id.startsWith('.') && !id.startsWith('@/')) return null;
  const base = id.startsWith('@/') ? path.join(webRoot, id.slice(2)) : path.resolve(path.dirname(fromFile), id);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/**
 * Loads the real Bot setting, the real global card and the real shared settings store into
 * one module graph. React effects run only while `mounting` (as on a real mount), and the
 * external store is read directly, so a fresh render shows what the page would re-render to.
 */
function lab(server: Server) {
  const state = { mounting: true, pickLevel: undefined as undefined | ((level: string) => void) };
  const react = {
    ...React,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useEffect: (effect: () => void | (() => void)) => {
      if (state.mounting) effect();
    }
  };
  const api = async (url: string, init?: { method?: string; body?: string }) => {
    assert.equal(url, GLOBAL_PATH);
    if (init?.method === 'PATCH') server.level = (JSON.parse(init.body ?? '{}') as { level: Level }).level;
    else server.reads += 1;
    return { settings: { level: server.level, updatedAt: 'now' }, effective: { level: server.level, source: 'ui' } };
  };
  const stubs: Record<string, unknown> = {
    react,
    'react/jsx-runtime': localRequire('react/jsx-runtime'),
    '@/lib/api': { api },
    '@/lib/i18n': {
      useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars) })
    },
    './ConfigGroup': {
      ConfigGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('section', null, children),
      FieldLabel: ({ children }: { children?: React.ReactNode }) => React.createElement('span', null, children)
    },
    './ui': {
      SettingsGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children)
    },
    './sections/settings/categories/kit/fields': {
      LoadGate: ({ ready, children }: { ready: boolean; children?: React.ReactNode }) => (ready ? children : null),
      SelectField: (props: { id: string; onChange: (value: string) => void }) => {
        if (props.id === 'thinking-effort') state.pickLevel = props.onChange;
        return React.createElement('select', { id: props.id });
      },
      SourceBadge: () => null,
      StatusLine: () => null
    }
  };
  const cache = new Map<string, Record<string, unknown>>();
  const requireFrom = (fromFile: string) => (id: string) => {
    if (id in stubs) return stubs[id];
    const resolved = resolveModule(fromFile, id);
    assert.ok(resolved, `unexpected import ${id} from ${fromFile}`);
    return load(resolved);
  };
  function load(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
      fileName: file
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    cache.set(file, mod.exports);
    new Function('require', 'module', 'exports', compiled)(requireFrom(file), mod, mod.exports);
    return mod.exports;
  }
  const BotSetting = load(path.join(webRoot, 'components/BotThinkingEffortSetting.tsx')).BotThinkingEffortSetting as React.FC<{
    botId: string;
    pinned: Level | null;
    onSave: (next: Level | null) => Promise<void>;
  }>;
  const GlobalCard = load(path.join(webRoot, 'components/ThinkingEffortSettingsCard.tsx')).ThinkingEffortSettingsCard as React.FC;
  return {
    state,
    botSetting: () =>
      renderToStaticMarkup(React.createElement(BotSetting, { botId: 'bot-1', pinned: null, onSave: async () => {} })),
    globalCard: () => renderToStaticMarkup(React.createElement(GlobalCard))
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function followText(html: string): string {
  return html.match(/<option value=""[^>]*>([^<]*)<\/option>/)?.[1] ?? '';
}

test('the Bot setting follows the global card on the same page and refreshes when the page comes back [AC:bot-thinking-effort#AC-9]', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.assign(globalThis, { window: win, document: doc });
  try {
    const server: Server = { level: 'low', reads: 0 };
    const page = lab(server);
    page.botSetting();
    page.globalCard();
    await settle();
    page.state.mounting = false;
    assert.equal(followText(page.botSetting()), '跟随全局（当前：低）');
    assert.match(page.botSetting(), /当前生效：低（跟随全局）/);

    page.globalCard();
    assert.ok(page.state.pickLevel, 'the global card offers its level picker');
    const readsBeforeSave = server.reads;
    page.state.pickLevel('high');
    await settle();
    assert.equal(server.level, 'high');
    assert.equal(followText(page.botSetting()), '跟随全局（当前：高）', 'saving the global card updates the Bot setting at once');
    assert.match(page.botSetting(), /当前生效：高（跟随全局）/);
    assert.equal(server.reads, readsBeforeSave, 'the update comes from the save itself, not another read');

    server.level = 'medium';
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(server.reads, readsBeforeSave, 'nothing polls while the page stays put');
    assert.equal(followText(page.botSetting()), '跟随全局（当前：高）');

    win.dispatchEvent(new Event('focus'));
    await settle();
    assert.equal(followText(page.botSetting()), '跟随全局（当前：中）', 'focusing the window reads the global level again');

    server.level = 'off';
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(followText(page.botSetting()), '跟随全局（当前：中）', 'a hidden page does not read');
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    assert.equal(followText(page.botSetting()), '跟随全局（当前：关闭）', 'the page turning visible reads again');
  } finally {
    Object.assign(globalThis, previous);
  }
});
