import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import * as favoriteLib from '../lib/session-favorite.ts';

const cache = new Map<string, Record<string, unknown>>();

function t(key: string): string {
  const table: Record<string, string> = {
    'play.favorite.save': zh.play.favorite.save,
    'play.favorite.saved': zh.play.favorite.saved,
    'play.sidebar.favoritesOnly': zh.play.sidebar.favoritesOnly
  };
  return table[key] ?? key;
}

function loadFile(file: URL): Record<string, unknown> {
  const cached = cache.get(file.pathname);
  if (cached) return cached;
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const requireComponent = (id: string) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t }) };
    if (id === '@/lib/api') return { api: async () => ({}) };
    if (id === '@/lib/session-favorite') return favoriteLib;
    throw new Error(`unexpected import ${id}`);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  cache.set(file.pathname, mod.exports);
  return mod.exports;
}

const favorite = loadFile(new URL('./SessionFavorite.tsx', import.meta.url)) as {
  SessionFavoriteButton: React.ComponentType<{ session: { id: string; metadata?: Record<string, unknown> } | null }>;
  SessionFavoriteMark: React.ComponentType<{ session: { id: string; metadata?: Record<string, unknown> } }>;
  SessionFavoriteFilter: React.ComponentType<{ pressed: boolean; onChange?: (next: boolean) => void }>;
};

test('当前会话的收藏按钮和列表标记一起出现 [AC:session-favorite#AC-1]', () => {
  const plain = renderToStaticMarkup(React.createElement(favorite.SessionFavoriteButton, { session: { id: 's1', metadata: {} } }));
  assert.match(plain, /data-testid="session-favorite"/);
  assert.match(plain, /aria-pressed="false"/);
  assert.match(plain, /收藏/);
  const row = renderToStaticMarkup(React.createElement(favorite.SessionFavoriteMark, { session: { id: 's1', metadata: {} } }));
  assert.equal(row, '');
  const saved = renderToStaticMarkup(React.createElement(favorite.SessionFavoriteMark, {
    session: { id: 's1', metadata: { favorited: true } }
  }));
  assert.match(saved, /data-testid="session-favorite-mark"/);
  assert.match(saved, /已收藏/);
});

test('已收藏后再看按钮是取消，只看收藏开关能按下 [AC:session-favorite#AC-2] [AC:session-favorite#AC-3]', () => {
  const button = renderToStaticMarkup(React.createElement(favorite.SessionFavoriteButton, {
    session: { id: 's1', metadata: { favorited: true } }
  }));
  assert.match(button, /aria-pressed="true"/);
  assert.match(button, /已收藏/);
  const filter = renderToStaticMarkup(React.createElement(favorite.SessionFavoriteFilter, { pressed: true, onChange: () => undefined }));
  assert.match(filter, /data-testid="session-favorite-filter"/);
  assert.match(filter, /aria-pressed="true"/);
  assert.match(filter, /只看收藏/);
  assert.equal(renderToStaticMarkup(React.createElement(favorite.SessionFavoriteButton, { session: null })), '');
});
