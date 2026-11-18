import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { translate } from './i18n/t.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { groupSessionsWithFavorites, sessionListEmptyText } from './session-favorite.ts';
import { reasoningFoldProps, sessionListWhen, sessionListWhenText } from './chat-page-redesign.ts';
import { screenLiveTurn, steerUiAfterSend } from './live-turn-session.ts';

const chatCss = readFileSync(new URL('../components/sections/chat/chat.css', import.meta.url), 'utf8');
const playPanel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../components/sections/chat/SessionSettingsPanel.tsx', import.meta.url), 'utf8');
const turns = readFileSync(new URL('../components/ChatTurns.tsx', import.meta.url), 'utf8');

const now = new Date(2026, 10, 17, 15, 0).getTime();

test('会话按收藏和日期分组，今天显示钟点、昨天显示昨天 [AC:chat-page-redesign#AC-1]', () => {
  const sessions = [
    { id: 'fav', updatedAt: new Date(2026, 10, 17, 9, 5).toISOString(), metadata: { favorited: true } },
    { id: 'today', updatedAt: new Date(2026, 10, 17, 10, 12).toISOString(), metadata: {} },
    { id: 'yesterday', updatedAt: new Date(2026, 10, 16, 18, 0).toISOString(), metadata: {} },
    { id: 'week', updatedAt: new Date(2026, 10, 12, 12, 0).toISOString(), metadata: {} },
    { id: 'month', updatedAt: new Date(2026, 9, 20, 12, 0).toISOString(), metadata: {} }
  ];
  const groups = groupSessionsWithFavorites(sessions, now);
  assert.deepEqual(groups.map((group) => group.bucket), ['favorites', 'today', 'yesterday', 'week', 'month']);
  assert.equal(translate(zh, 'play.sessionGroup.favorites'), '收藏');
  assert.equal(translate(zh, 'play.sessionGroup.today'), '今天');
  assert.equal(translate(zh, 'play.sessionGroup.yesterday'), '昨天');
  assert.equal(translate(zh, 'play.sessionGroup.week'), '近 7 天');
  assert.equal(translate(zh, 'play.sessionGroup.month'), '近 30 天');
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(zh, key, vars);
  assert.equal(sessionListWhenText(sessionListWhen(new Date(2026, 10, 17, 10, 12).getTime(), now), t), '10:12');
  assert.equal(sessionListWhenText(sessionListWhen(new Date(2026, 10, 16, 18, 0).getTime(), now), t), '昨天');
  assert.equal(sessionListEmptyText({ botSurface: false, favoritesOnly: true }, {
    noBots: '无 Bot',
    noSessions: '无会话',
    noFavorites: '没有收藏的会话'
  }), '没有收藏的会话');
  assert.match(chatCss, /\.play-layout\[data-play-surface="chat"\][^{]*\.session-item__when/);
});

test('会话设置给出执行模式、Agent 和验收条件，没有本会话始终允许 [AC:chat-page-redesign#AC-2]', () => {
  assert.equal(translate(zh, 'play.assembly.chat'), '通用对话');
  assert.equal(translate(zh, 'play.assembly.task'), '任务工区');
  assert.equal(translate(zh, 'play.assembly.orchestrator'), '主控编排');
  assert.equal(translate(zh, 'play.settings.hint'), '只影响当前会话；全局默认在「设置」页。');
  assert.equal(translate(zh, 'chatPage.goalPlaceholder'), '验收条件，留空即不启用');
  assert.equal(translate(en, 'chatPage.goalPlaceholder'), 'Done-when condition; empty turns it off');
  const advancedAt = settings.indexOf('session-settings__advanced');
  const modesAt = settings.indexOf('session-settings__seg');
  const goalAt = settings.indexOf('chatPage.goalPlaceholder');
  assert.ok(modesAt > 0 && modesAt < advancedAt);
  assert.ok(goalAt > 0 && goalAt < advancedAt);
  assert.match(settings, /aria-label="Agent"/);
  assert.equal(settings.includes('本会话始终允许'), false);
  assert.equal(settings.includes('Always allow'), false);
});

test('发送后用户气泡留在鼠尾草绿浅底，思考折叠规则和 Markdown 正文还在 [AC:chat-page-redesign#AC-3]', () => {
  const screen = screenLiveTurn({
    selectedSessionId: 's',
    loadedSessionId: 's',
    messages: [],
    liveSessionId: 's',
    optimisticUser: '列出目录',
    hasStream: false,
    waitTyping: true,
    playSending: true
  });
  assert.equal(screen.optimisticUser, '列出目录');
  assert.equal(screen.waitTyping, true);
  assert.deepEqual(steerUiAfterSend({ rejected: false, text: '列出目录', optimistic: '列出目录' }), {
    bubble: '列出目录',
    composer: null
  });
  assert.deepEqual(reasoningFoldProps(false), {});
  assert.deepEqual(reasoningFoldProps(true), { open: true });
  assert.match(turns, /reasoningFoldProps\(Boolean\(streaming\)\)/);
  assert.match(turns, /chat-bubble__md/);
  assert.match(turns, /function ToolCallFold/);
  const toolCall = turns.slice(turns.indexOf('function ToolCallFold'), turns.indexOf('function ReasoningFold'));
  assert.equal(toolCall.includes('open'), false);
  assert.equal(chatCss.includes('--chat-sage'), false);
  assert.equal(chatCss.includes('--ui-sage'), false);
  assert.match(chatCss, /background:\s*var\(--ui-home-accent-soft,\s*#E1ECE4\)/);
  assert.match(chatCss, /background:\s*var\(--ui-home-accent,\s*#3D6A4D\)/);
  assert.match(chatCss, /color:\s*var\(--ui-home-on-accent,\s*#FFFFFF\)/);
  assert.match(chatCss, /background:\s*var\(--ui-home-accent-soft,\s*#1F2F25\)/);
  assert.match(chatCss, /background:\s*var\(--ui-home-accent,\s*#82BD95\)/);
  assert.match(chatCss, /\.play-layout\[data-play-surface="chat"\] \.chat-panel-body \.chat-turn--user \.chat-bubble[\s\S]*background:\s*var\(--ui-home-accent-soft/);
});

test('普通会话顶栏写出助手名称和空闲或正在工作，并且标在会话页上 [AC:chat-page-redesign#AC-4]', () => {
  assert.equal(translate(zh, 'chatPage.quietStatus', { name: '通用助手', id: 'general', state: '空闲' }), '通用助手 general · 空闲');
  assert.equal(translate(zh, 'chatPage.statusWorking'), '正在工作');
  assert.equal(translate(en, 'chatPage.quietStatus', { name: 'General agent', id: 'general', state: 'Idle' }), 'General agent general · Idle');
  assert.match(playPanel, /data-play-surface=\{playSurface\}/);
  assert.match(playPanel, /ChatPlainHeaderStatus/);
  assert.equal(playPanel.includes('本会话始终允许'), false);
});
