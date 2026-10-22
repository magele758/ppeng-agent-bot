import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import type { BotInfo, SessionSummary } from '../lib/types.ts';

const localRequire = createRequire(import.meta.url);
const cache = new Map<string, Record<string, unknown>>();

function ownerTemplate(play: object): string {
  const childTask = (play as { childTask?: { owner?: string } }).childTask;
  return childTask?.owner ?? '';
}

function t(key: string, vars?: Record<string, string | number>): string {
  const table: Record<string, string> = {
    'play.sidebar.noQuestion': zh.play.sidebar.noQuestion,
    'play.unnamed': zh.play.unnamed,
    'play.childTask.owner': ownerTemplate(zh.play),
    'play.sidebar.checkboxAria': '{title}',
    'play.sidebar.deleteOneAria': '{title}',
    'play.sidebar.deleteOne': zh.play.sidebar.deleteOne
  };
  const template = table[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? `{${name}}`));
}

function resolveLocal(id: string, from: URL): URL {
  const exact = new URL(id, from);
  if (existsSync(exact.pathname)) return exact;
  if (existsSync(`${exact.pathname}.ts`)) return new URL(`${exact.href}.ts`);
  if (existsSync(`${exact.pathname}.tsx`)) return new URL(`${exact.href}.tsx`);
  throw new Error(`Cannot resolve ${id} from ${from.pathname}`);
}

function loadFile(file: URL): Record<string, unknown> {
  const key = file.pathname;
  const cached = cache.get(key);
  if (cached) return cached;
  const source = readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return JsxRuntime;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t }) };
    if (id === '@/lib/bot-face') return { botFaceIdleDelay: () => '0s' };
    if (id === '@/lib/session-row') return localRequire('../lib/session-row.ts');
    if (id === './BotFace' || id.endsWith('/BotFace')) return { BotFace: () => null };
    if (id.includes('BotWorkState')) return { useBotWorkMood: () => 'idle' };
    if (id.startsWith('.')) return loadFile(resolveLocal(id, file));
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  cache.set(key, mod.exports);
  return mod.exports;
}

const { SessionListRow } = loadFile(new URL('./SessionListRow.tsx', import.meta.url)) as {
  SessionListRow: React.ComponentType<Record<string, unknown>>;
};

function bot(over: Partial<BotInfo> & Pick<BotInfo, 'id' | 'name'>): BotInfo {
  return {
    title: over.title ?? over.name,
    description: '',
    agentId: over.id,
    canonicalSessionId: '',
    hidden: false,
    createdAt: '',
    updatedAt: '',
    ...over
  };
}

const longBotId = `bot_${'cd'.repeat(16)}`;
const researcher = bot({ id: longBotId, name: '资料员', canonicalSessionId: 'sess-canon-researcher' });

function child(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    mode: 'subagent',
    status: 'idle',
    agentId: longBotId,
    metadata: { botId: longBotId, spawnSource: 'concurrent-bot-work', botGoalWorker: true }
  } as SessionSummary;
}

function renderPair(openId: string) {
  const open = child('child-open', '整理本周纪要');
  const other = child('child-other', '对照竞品价格');
  return renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(SessionListRow, {
        session: open,
        bots: [researcher],
        question: '',
        selected: open.id === openId,
        checked: false,
        selectMode: false,
        deleting: false,
        status: null,
        onOpen() {},
        onToggleChecked() {}
      }),
      React.createElement(SessionListRow, {
        session: other,
        bots: [researcher],
        question: '',
        selected: other.id === openId,
        checked: false,
        selectMode: false,
        deleting: false,
        status: null,
        onOpen() {},
        onToggleChecked() {}
      })
    )
  );
}

function rows(html: string): string[] {
  return html.split(/(?=<div class="list-item )/).filter((part) => part.startsWith('<div'));
}

function rowById(html: string, id: string): string {
  const found = rows(html).find((row) => row.includes(`data-session-id="${id}"`));
  assert.ok(found, `missing row ${id}`);
  return found!;
}

function titleText(row: string): string {
  const match = row.match(/session-item__title">([^<]*)</);
  assert.ok(match, row);
  return match[1]!;
}

test('普通会话列表里当前打开的子任务入口能被认出来 [AC:bot-child-task-chat-entry#AC-3]', () => {
  const html = renderPair('child-open');
  const open = rowById(html, 'child-open');
  const other = rowById(html, 'child-other');
  assert.match(open, /data-session-kind="child-task"/);
  assert.match(open, /\bselected\b/);
  assert.match(open, /aria-current="true"/);
  assert.equal(titleText(open), '整理本周纪要');
  assert.match(other, /data-session-kind="child-task"/);
  assert.doesNotMatch(other, /\bselected\b/);
  assert.equal(other.includes('aria-current="true"'), false);
  assert.equal(titleText(other), '对照竞品价格');
});

test('列表里的子任务标题是任务原文，行上不出现裸 bot id [AC:bot-child-task-chat-entry#AC-4]', () => {
  const html = renderToStaticMarkup(
    React.createElement(SessionListRow, {
      session: {
        ...child('child-prefixed', 'Bot Chat · 整理本周纪要'),
        title: 'Bot Chat · 整理本周纪要'
      },
      bots: [researcher],
      question: '',
      selected: false,
      checked: false,
      selectMode: false,
      deleting: false,
      status: null,
      onOpen() {},
      onToggleChecked() {}
    })
  );
  const row = rowById(html, 'child-prefixed');
  assert.equal(titleText(row), '整理本周纪要');
  assert.equal(row.includes(longBotId), false);
  assert.equal(titleText(row).includes('Bot Chat'), false);
});

test('列表里的子任务入口写着所属 Bot 的名字 [AC:bot-child-task-chat-entry#AC-5]', () => {
  assert.equal(ownerTemplate(zh.play), '属于{name}');
  assert.equal(ownerTemplate(en.play), 'From {name}');
  const html = renderPair('child-open');
  const open = rowById(html, 'child-open');
  assert.match(open, /data-testid="session-child-task-owner"/);
  assert.match(open, /属于资料员/);
  assert.equal(open.includes(longBotId), false);
  assert.equal(titleText(open), '整理本周纪要');
  assert.notEqual(titleText(open), 'child-open');
});
