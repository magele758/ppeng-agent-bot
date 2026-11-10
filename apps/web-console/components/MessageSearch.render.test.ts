import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import {
  formatMessageSearchTime,
  messageSearchErrorText,
  messageSearchPath,
  subscribeMessageSearch,
  type MessageSearchHit,
  type MessageSearchView
} from '../lib/message-search.ts';

const localRequire = createRequire(import.meta.url);
const t = (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars);

function loadPanel(): { MessageSearchPanel: React.ComponentType<Record<string, unknown>> } {
  const source = readFileSync(new URL('./MessageSearch.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => {
    if (id === '@/lib/i18n') return { useI18n: () => ({ t }) };
    if (id === '@/lib/message-search') return localRequire('../lib/message-search.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports as { MessageSearchPanel: React.ComponentType<Record<string, unknown>> };
}

const { MessageSearchPanel } = loadPanel();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const hit: MessageSearchHit = {
  sessionId: 'sess-budget',
  messageId: 'msg-1',
  role: 'user',
  snippet: '把预算改成每月两千',
  createdAt: '2026-11-10T01:02:03.000Z',
  sessionTitle: '家庭预算',
  agentId: 'general'
};

test('对话正文搜索展示标题、摘录和时间，空关键词不请求 [AC:message-search-ui#AC-2] [AC:message-search-ui#AC-3]', async () => {
  assert.equal(messageSearchPath('   '), null);
  assert.equal(messageSearchPath('预算'), '/api/search/messages?q=%E9%A2%84%E7%AE%97&limit=20');

  const blankCalls: string[] = [];
  const stopBlank = subscribeMessageSearch('   ', () => undefined, async (path) => {
    blankCalls.push(path);
    return { hits: [] };
  }, 0);
  await wait(20);
  stopBlank();
  assert.deepEqual(blankCalls, []);

  const calls: string[] = [];
  const views: MessageSearchView[] = [];
  const stop = subscribeMessageSearch('预算', (view) => views.push(view), async (path) => {
    calls.push(path);
    return { hits: [hit] };
  }, 0);
  assert.deepEqual(calls, []);
  await wait(30);
  stop();
  assert.deepEqual(calls, [messageSearchPath('预算')]);
  assert.equal(views.at(-1)?.phase, 'ready');
  assert.equal(views.at(-1)?.hits[0]?.sessionId, 'sess-budget');

  const html = renderToStaticMarkup(
    React.createElement(MessageSearchPanel, {
      query: '预算',
      view: { phase: 'ready', hits: [hit], errorDetail: '' },
      onQuery: () => undefined,
      onOpen: () => undefined
    })
  );
  assert.match(html, /搜索对话正文/);
  assert.match(html, /家庭预算/);
  assert.match(html, /把预算改成每月两千/);
  assert.match(html, new RegExp(formatMessageSearchTime(hit.createdAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /dateTime="2026-11-10T01:02:03.000Z"/);
  assert.match(html, /data-session-id="sess-budget"/);
  assert.match(html, /打开会话 家庭预算/);
});

test('搜索失败或 404 只显示错误，不编造命中 [AC:message-search-ui#AC-4]', async () => {
  const views: MessageSearchView[] = [];
  const stop = subscribeMessageSearch('missing', (view) => views.push(view), async () => {
    throw new Error('HTTP 404');
  }, 0);
  await wait(30);
  stop();
  const failed = views.at(-1);
  assert.equal(failed?.phase, 'error');
  assert.deepEqual(failed?.hits, []);
  assert.equal(messageSearchErrorText(failed?.errorDetail ?? '', t), '对话搜索暂不可用');

  const html = renderToStaticMarkup(
    React.createElement(MessageSearchPanel, {
      query: 'missing',
      view: failed,
      onQuery: () => undefined,
      onOpen: () => undefined
    })
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /对话搜索暂不可用/);
  assert.doesNotMatch(html, /data-testid="message-search-hit"/);
  assert.doesNotMatch(html, /家庭预算/);

  const emptyViews: MessageSearchView[] = [];
  const stopEmpty = subscribeMessageSearch('none', (view) => emptyViews.push(view), async () => ({ hits: [] }), 0);
  await wait(30);
  stopEmpty();
  assert.equal(emptyViews.at(-1)?.phase, 'empty');
  assert.deepEqual(emptyViews.at(-1)?.hits, []);

  const broken = renderToStaticMarkup(
    React.createElement(MessageSearchPanel, {
      query: 'x',
      view: { phase: 'error', hits: [], errorDetail: 'invalid' },
      onQuery: () => undefined,
      onOpen: () => undefined
    })
  );
  assert.match(broken, /对话搜索结果无法读取/);
  assert.doesNotMatch(broken, /data-testid="message-search-hit"/);

  const empty = renderToStaticMarkup(
    React.createElement(MessageSearchPanel, {
      query: 'none',
      view: { phase: 'empty', hits: [], errorDetail: '' },
      onQuery: () => undefined,
      onOpen: () => undefined
    })
  );
  assert.match(empty, /没有匹配的对话/);
  assert.doesNotMatch(empty, /data-testid="message-search-hit"/);
});

test('正文搜索和 Bot 名字搜索、会话筛选分开，点击绑定会话 [AC:message-search-ui#AC-1] [AC:message-search-ui#AC-5]', () => {
  const bots = readFileSync(new URL('./sections/agents/BotsView.tsx', import.meta.url), 'utf8');
  const chat = readFileSync(new URL('./sections/chat/ChatSection.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('./PlayPanel.tsx', import.meta.url), 'utf8');
  assert.match(bots, /agents\.bots\.searchAria/);
  assert.match(bots, /filterBots/);
  assert.match(chat, /filterSessionsByQuery/);
  assert.match(panel, /play\.sidebar\.filterAria/);
  assert.match(panel, /<MessageSearch onOpenSession=\{openSearchedSession\} \/>/);
  assert.match(panel, /const openSearchedSession = \(sessionId: string\) => \{[\s\S]*onSelectSession\(sessionId\);/);
});
