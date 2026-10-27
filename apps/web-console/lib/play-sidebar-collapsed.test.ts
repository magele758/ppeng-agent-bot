import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import {
  parsePlaySidebarCollapsed,
  PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY,
  readPlaySidebarCollapsed,
  writePlaySidebarCollapsed
} from './play-sidebar-collapsed.ts';

const panel = readFileSync(new URL('../components/PlayPanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../styles/shell.css', import.meta.url), 'utf8');
const lib = readFileSync(new URL('./play-sidebar-collapsed.ts', import.meta.url), 'utf8');

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    data
  };
}

function toggleBody(): string {
  const start = panel.indexOf('const togglePlaySidebar = () => {');
  assert.ok(start > 0, 'togglePlaySidebar');
  const end = panel.indexOf('};', start);
  return panel.slice(start, end);
}

test('会话列表有可收起的控制 [AC:play-sidebar-collapse#AC-1]', () => {
  assert.match(panel, /data-testid="play-sidebar-toggle"/);
  assert.match(panel, /aria-controls="mobile-session-list"/);
  assert.match(panel, /aria-expanded=\{!collapsed\}/);
  assert.match(panel, /aria-label=\{label\}/);
  assert.match(panel, /t\(collapsed \? 'play\.sidebar\.expand' : 'play\.sidebar\.collapse'\)/);
  assert.match(panel, /\{sidebarCollapsed \? null : <PlaySidebarToggle collapsed=\{false\} onToggle=\{togglePlaySidebar\} \/>\}/);
  assert.equal(panel.includes('id="nav-rail-toggle"'), false);
  assert.equal(panel.includes('writeRailCollapsed'), false);
  assert.equal(panel.includes('readRailCollapsed'), false);
  assert.equal(zh.play.sidebar.collapse, '收起会话列表');
  assert.equal(zh.play.sidebar.expand, '展开会话列表');
  assert.equal(en.play.sidebar.collapse, 'Collapse session list');
  assert.equal(en.play.sidebar.expand, 'Expand session list');
  const body = toggleBody();
  assert.match(body, /writePlaySidebarCollapsed\(next\)/);
  assert.equal(parsePlaySidebarCollapsed('1'), true);
  assert.equal(parsePlaySidebarCollapsed('0'), false);
});

test('收起后会话列表不再占对话旁边的宽度 [AC:play-sidebar-collapse#AC-2]', () => {
  assert.match(
    css,
    /\.play-layout--rail\.is-sidebar-collapsed \{ grid-template-columns: minmax\(0, 1fr\) clamp\(240px, 280px, 320px\); \}/
  );
  assert.match(
    css,
    /\.play-layout--rail\.is-sidebar-collapsed\.is-rail-collapsed \{ grid-template-columns: minmax\(0, 1fr\); \}/
  );
  assert.match(
    css,
    /@media \(max-width: 1100px\) \{\s*\.play-layout--rail\.is-sidebar-collapsed,\s*\.play-layout--rail\.is-sidebar-collapsed\.is-rail-collapsed \{ grid-template-columns: minmax\(0, 1fr\); \}/
  );
  const collapsedRule = css.match(
    /\.play-layout--rail\.is-sidebar-collapsed \{ grid-template-columns: ([^;]+); \}/
  );
  assert.ok(collapsedRule);
  assert.equal(collapsedRule[1].includes('220px'), false);
  assert.equal(collapsedRule[1].includes('200px'), false);
  assert.match(panel, /sidebarCollapsed && !mobileSessionsOpen \? ' is-sidebar-collapsed' : ''/);
  assert.match(panel, /hidden=\{sidebarCollapsed && !mobileSessionsOpen\}/);
  assert.match(css, /\.play-layout--rail \{\s*grid-template-columns: clamp\(200px, 220px, 260px\) minmax\(0, 1fr\) clamp\(240px, 280px, 320px\);/);
  assert.equal(panel.includes('lab-rail'), false);
  assert.match(shell, /\.lab-rail \{\s*width: var\(--ui-rail-width\)/);
  assert.equal(shell.includes('is-sidebar-collapsed'), false);
  assert.equal(shell.includes('play-sidebar-toggle'), false);
});

test('再展开后列表和选中项还在 [AC:play-sidebar-collapse#AC-3]', () => {
  assert.match(panel, /\{sidebarCollapsed \? <PlaySidebarToggle collapsed onToggle=\{togglePlaySidebar\} \/> : null\}/);
  const asideAt = panel.indexOf('<aside className="play-sidebar" id="mobile-session-list"');
  assert.ok(asideAt > 0);
  const aside = panel.slice(asideAt, panel.indexOf('</aside>', asideAt));
  assert.match(aside, /<BotPinArea/);
  assert.match(aside, /<PlayBotGroupList/);
  assert.match(aside, /<BotFunctionalGroups/);
  assert.match(aside, /id="sessionListMini"/);
  assert.equal(/\{!sidebarCollapsed &&/.test(aside), false);
  assert.match(panel, /selected=\{!openGroupId && selectedSessionId === s\.id\}/);
  const body = toggleBody();
  assert.equal(body.includes('onSelectSession'), false);
  assert.equal(body.includes('setOpenGroupId'), false);
  assert.equal(body.includes('setBots'), false);
  assert.match(
    css,
    /\.play-layout--rail \{\s*grid-template-columns: clamp\(200px, 220px, 260px\) minmax\(0, 1fr\) clamp\(240px, 280px, 320px\);/
  );
});

test('收起偏好记在本机，刷新后还在 [AC:play-sidebar-collapse#AC-4]', () => {
  const storage = memoryStorage();
  assert.equal(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY, 'lab.playSidebarCollapsed');
  assert.notEqual(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY, 'lab.railCollapsed');
  assert.equal(readPlaySidebarCollapsed(storage), false);
  writePlaySidebarCollapsed(true, storage);
  assert.equal(storage.getItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY), '1');
  assert.equal(readPlaySidebarCollapsed(storage), true);
  writePlaySidebarCollapsed(false, storage);
  assert.equal(storage.getItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY), '0');
  assert.equal(readPlaySidebarCollapsed(storage), false);
  storage.setItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');
  assert.equal(readPlaySidebarCollapsed(storage), true);
  storage.setItem(PLAY_SIDEBAR_COLLAPSED_STORAGE_KEY, 'nope');
  assert.equal(readPlaySidebarCollapsed(storage), false);
  assert.equal(storage.data.has('lab.railCollapsed'), false);
  assert.equal(readPlaySidebarCollapsed(null), false);
  writePlaySidebarCollapsed(true, null);
  assert.equal(readPlaySidebarCollapsed(null), false);
  assert.match(panel, /setSidebarCollapsed\(readPlaySidebarCollapsed\(\)\)/);
  assert.match(lib, /window\.localStorage/);
  assert.equal(lib.includes('RAW_AGENT_'), false);
  assert.equal(panel.includes('RAW_AGENT_'), false);
});
