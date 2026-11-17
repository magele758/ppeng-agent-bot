import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { botListPhase } from './bot-list-phase.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const localRequire = createRequire(import.meta.url);

test('Bot 列表保持置顶、未置顶群聊、功能分组、未分组、共享信息 [AC:console-bot-visual#AC-1]', () => {
  const panel = read('./PlayPanel.tsx');
  const pin = panel.indexOf('<BotPinArea');
  const rooms = panel.indexOf('<PlayBotGroupList');
  const groups = panel.indexOf('<BotFunctionalGroups');
  assert.ok(pin > 0 && rooms > pin && groups > rooms);
  const view = read('./BotFunctionalGroups.tsx');
  const mapped = view.indexOf('groups.map(');
  const ungrouped = view.indexOf('section(null)');
  const shared = view.indexOf('<SharedFacts');
  assert.ok(mapped > 0 && ungrouped > mapped && shared > ungrouped);
  assert.match(view, /moveBotInGroups\(/);
  assert.match(view, /moveRoomInGroups\(/);
});

test('加载中是骨架，失败可重试，空列表才说无 Bot [AC:console-bot-visual#AC-2] [AC:console-bot-visual#AC-3] [AC:console-bot-visual#AC-4]', () => {
  assert.equal(botListPhase(false, '', 0, 0, 0), 'loading');
  assert.equal(botListPhase(false, 'down', 2, 1, 1), 'error');
  assert.equal(botListPhase(true, 'save failed', 2, 1, 1), 'keep');
  assert.equal(botListPhase(true, '', 0, 0, 0), 'empty');
  assert.equal(botListPhase(true, '', 1, 0, 0), null);
  assert.equal(botListPhase(true, '', 0, 1, 0), null);
  assert.equal(botListPhase(true, '', 0, 0, 1), null);
  const html = {
    loading: renderStatus('loading'),
    error: renderStatus('error'),
    empty: renderStatus('empty'),
    keep: renderStatus('keep')
  };
  assert.match(html.loading, /data-testid="bot-list-loading"/);
  assert.equal(html.loading.includes(zh.play.botHome.emptyTitle), false);
  assert.match(html.error, /data-testid="bot-list-error"/);
  assert.match(html.error, /play\.botHome\.retry|重试/);
  assert.equal(html.error.includes('data-testid="bot-list-empty"'), false);
  assert.match(html.empty, /data-testid="bot-list-empty"/);
  assert.match(html.empty, new RegExp(zh.play.botHome.emptyTitle));
  assert.match(html.empty, new RegExp(zh.play.botHome.emptyHint));
  assert.equal(html.keep.includes('data-testid="bot-list-empty"'), false);
  assert.notEqual(zh.play.botHome.emptyTitle, en.play.botHome.emptyTitle);
  assert.notEqual(zh.play.botHome.errorTitle, en.play.botHome.errorTitle);
});

test('行菜单可置顶和移动分组，新建仍是 Bot、群聊和功能分组 [AC:console-bot-visual#AC-5]', () => {
  const menu = read('./BotRowMenu.tsx');
  const rooms = read('./play-group/PlayBotGroupList.tsx');
  const panel = read('./PlayPanel.tsx');
  assert.match(menu, /BotPinMenuItem/);
  assert.match(menu, /play\.rowMenu\.group/);
  assert.match(rooms, /RoomRowActions/);
  assert.match(panel, /play\.newBot/);
  assert.match(panel, /play\.group\.create/);
  assert.match(panel, /play\.functionalGroups\.create/);
  assert.match(zh.play.rowMenu.pin, /置顶/);
  assert.match(zh.play.rowMenu.unpin, /取消置顶/);
  assert.match(en.play.rowMenu.pin, /Pin/);
  assert.notEqual(zh.play.rowMenu.moveTo, en.play.rowMenu.moveTo);
});

test('Bot 页用鼠尾草绿，并跟随浅色深色变量 [AC:console-bot-visual#AC-6]', () => {
  const css = read('./bot-home.css');
  const groups = read('./BotFunctionalGroups.module.css');
  const detail = read('./BotDetailMenu.module.css');
  assert.match(css, /var\(--ui-home-accent,\s*light-dark\(#3D6A4D,\s*#82BD95\)\)/);
  assert.match(css, /var\(--ui-home-panel,/);
  assert.match(css, /var\(--ui-home-text,/);
  assert.match(css, /var\(--ui-home-danger,/);
  assert.equal(css.includes('--ui-home-accent:'), false);
  assert.equal(css.includes('--bot-accent:'), false);
  assert.match(groups, /var\(--ui-home-accent,/);
  assert.match(detail, /var\(--ui-home-accent,/);
  assert.equal(groups.includes('--bot-'), false);
  assert.equal(detail.includes('--bot-'), false);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /html\[data-theme="light"\]/);
  assert.equal(css.includes('data-bot-theme'), false);
  assert.equal(css.includes('box-shadow'), false);
  const tokens = read('../styles/tokens.css');
  const nav = read('../lib/nav.ts');
  assert.equal(tokens.includes('bot-home'), false);
  assert.equal(nav.includes('bot-home'), false);
});

function renderStatus(phase: 'loading' | 'error' | 'empty' | 'keep'): string {
  const source = read('./BotListStatus.tsx');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const mod = { exports: {} as { BotListNotices?: React.ComponentType<Record<string, unknown>> } };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === 'react') return React;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string) => zhCopy(key) }) };
    if (id === './bot-list-phase') return { botListPhase };
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  const props = phase === 'loading'
    ? { loaded: false, error: '', botCount: 0, roomCount: 0, groupCount: 0 }
    : phase === 'error'
      ? { loaded: false, error: 'down', botCount: 1, roomCount: 0, groupCount: 0 }
      : phase === 'empty'
        ? { loaded: true, error: '', botCount: 0, roomCount: 0, groupCount: 0 }
        : { loaded: true, error: 'save failed', botCount: 1, roomCount: 0, groupCount: 0 };
  return renderToStaticMarkup(React.createElement(mod.exports.BotListNotices!, { ...props, onRetry: () => undefined }));
}

function zhCopy(key: string): string {
  const parts = key.split('.');
  let value: unknown = zh;
  for (const part of parts) value = (value as Record<string, unknown>)[part];
  return typeof value === 'string' ? value : key;
}
