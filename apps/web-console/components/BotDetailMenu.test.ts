import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);
const copy: Record<string, string> = {};
function walk(value: unknown, prefix: string) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') copy[path] = child;
    else walk(child, path);
  }
}
walk(zh.play, 'play');

function loadMenu() {
  const source = readFileSync(new URL('./BotDetailMenu.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as { BotDetailMenu?: React.ComponentType<Record<string, unknown>> } };
  const requireComponent = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === './RoutineSchedule') {
      const routine = ts.transpileModule(readFileSync(new URL('./RoutineSchedule.tsx', import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
      }).outputText;
      const module = { exports: {} };
      new Function('require', 'module', 'exports', routine)(requireComponent, module, module.exports);
      return module.exports;
    }
    if (id === './BotDetailSkills') return { BotDetailSkills: () => null };
    if (id === 'react') return React;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => {
      let text = copy[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
      return text;
    } }) };
    if (id === '@/lib/api') return { api: async () => ({}) };
    if (id === '@/lib/bot-chat-header') return localRequire('../lib/bot-chat-header.ts');
    if (id === '@/lib/bot-detail-menu') return localRequire('../lib/bot-detail-menu.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(requireComponent, mod, mod.exports);
  return mod.exports.BotDetailMenu!;
}

const secret = 'sk-live-secret-token';
const botA = {
  botId: 'bot-a',
  botName: '甲',
  open: true,
  preview: {
    jobs: [{ id: 'job-a', name: '甲的晨报', enabled: false, nextRunAt: '2026-10-20T01:00:00.000Z' }],
    files: [{ id: 'file-a', name: '甲的纪要.txt', kind: 'artifact' as const, createdAt: '2026-10-19T00:00:00.000Z' }],
    memories: [{ id: 'mem-a', scope: 'user.memory', key: 'city', value: '杭州' }, { id: 'mem-secret', scope: 'user.memory', key: 'api_key', value: secret }]
  }
};
const botB = {
  botId: 'bot-b',
  botName: '乙',
  open: true,
  preview: {
    jobs: [{ id: 'job-b', name: '乙的晚报', enabled: true }],
    files: [{ id: 'file-b', name: '乙的清单.txt', kind: 'working-log' as const, createdAt: '2026-10-19T00:00:00.000Z' }],
    memories: [{ id: 'mem-b', scope: 'session.long', key: 'topic', value: '发布' }]
  }
};

function render(props: Record<string, unknown>) {
  const BotDetailMenu = loadMenu();
  return renderToStaticMarkup(React.createElement(BotDetailMenu, props));
}

test('右侧菜单随当前 Bot 切换三块内容，且不显示 token [AC:bot-detail-menu#AC-1]', () => {
  const routines = render({ ...botA, initialSection: 'routines' });
  const files = render({ ...botA, initialSection: 'files' });
  const memory = render({ ...botA, initialSection: 'memory' });
  const other = render({ ...botB, initialSection: 'routines' });
  assert.match(routines, /data-testid="bot-detail-panel"/);
  assert.match(routines, /data-bot-id="bot-a"/);
  assert.match(routines, /甲的晨报/);
  assert.equal(routines.includes('乙的晚报'), false);
  assert.match(files, /甲的纪要\.txt/);
  assert.match(files, /data-testid="bot-detail-open-folder"/);
  assert.equal(files.includes('乙的清单'), false);
  assert.match(memory, /杭州/);
  assert.match(memory, /已隐藏敏感内容/);
  assert.equal(memory.includes(secret), false);
  assert.match(other, /data-bot-id="bot-b"/);
  assert.match(other, /乙的晚报/);
  assert.equal(other.includes('甲的晨报'), false);
  assert.match(routines, /data-testid="bot-detail-tab-routines"/);
  assert.match(routines, /data-testid="bot-detail-tab-files"/);
  assert.match(routines, /data-testid="bot-detail-tab-memory"/);
});

test('三块都没有数据时显示空状态 [AC:bot-detail-menu#AC-2]', () => {
  const empty = { jobs: [], files: [], memories: [] };
  const routines = render({ botId: 'bot-empty', botName: '空', open: true, initialSection: 'routines', preview: empty });
  const files = render({ botId: 'bot-empty', botName: '空', open: true, initialSection: 'files', preview: empty });
  const memory = render({ botId: 'bot-empty', botName: '空', open: true, initialSection: 'memory', preview: empty });
  assert.match(routines, /这个 Bot 还没有定时任务/);
  assert.match(files, /这个 Bot 还没有生成过文件或资料/);
  assert.match(memory, /这个 Bot 还没有记忆/);
});

test('详情卡片可以删除定时任务', () => {
  const card = render({ ...botB, open: true, initialSection: 'routines' });
  assert.match(card, /data-testid="bot-detail-routine-delete"/);
  assert.match(card, /删除/);
  assert.match(card, /data-testid="bot-detail-routine-toggle"/);
  const source = readFileSync(new URL('./BotDetailMenu.tsx', import.meta.url), 'utf8');
  assert.match(source, /commitRoutineRemoved/);
  assert.match(source, /method:\s*'DELETE'/);
  assert.match(source, /play\.botDetail\.remove/);
});

test('开启和关闭按钮反映当前状态，失败时保持原状态并说明失败 [AC:bot-detail-menu#AC-3] [AC:bot-detail-menu#AC-4]', () => {
  const off = render({
    ...botA,
    open: true,
    initialSection: 'routines'
  });
  assert.match(off, /data-enabled="false"/);
  assert.match(off, /已关闭/);
  assert.match(off, /开启/);
  const on = render({ ...botB, open: true, initialSection: 'routines' });
  assert.match(on, /data-enabled="true"/);
  assert.match(on, /已开启/);
  assert.match(on, /关闭/);
  const failed = render({ ...botB, open: true, initialSection: 'routines', showToggleError: true });
  assert.match(failed, /data-enabled="true"/);
  assert.match(failed, /没能切换，状态保持原样/);
  assert.equal(failed.includes('已关闭'), false);
  const source = readFileSync(new URL('./BotDetailMenu.tsx', import.meta.url), 'utf8');
  assert.match(source, /commitRoutineEnabled/);
  assert.match(source, /\/api\/cron\/jobs\//);
  assert.match(source, /method:\s*'PATCH'/);
  assert.equal(source.includes('secretEnv'), false);
});

test('详情菜单可打开收起，窄屏改为覆盖而不挤占对话 [AC:bot-detail-menu#AC-7]', () => {
  const open = render({ ...botA, open: true, initialSection: 'routines' });
  const closed = render({ ...botA, open: false, initialSection: 'routines' });
  assert.match(open, /data-testid="bot-detail-section-routines"/);
  assert.match(open, /data-testid="bot-detail-tab-files"/);
  assert.match(open, /data-testid="bot-detail-tab-memory"/);
  assert.equal(closed.includes('data-testid="bot-detail-panel"'), false);
  const panel = readFileSync(new URL('./PlayPanel.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
  const details = readFileSync(new URL('./BotDetailMenu.tsx', import.meta.url), 'utf8');
  assert.match(panel, /BotDetailToggle/);
  assert.match(details, /data-testid="bot-detail-toggle"/);
  assert.match(details, /is-bot-detail-open/);
  assert.match(panel, /BotDetailMenu/);
  assert.match(css, /max-width:\s*1100px/);
  assert.match(css, /\.bot-detail-menu/);
  assert.match(css, /position:\s*absolute/);
});

const researcherTasks = [
  { id: 'child-1', title: '整理本周纪要' },
  { id: 'child-2', title: '对照竞品价格' }
];
const writerTasks = [{ id: 'child-3', title: '写发布说明' }];

test('详情菜单只列出当前 Bot 的子任务，换 Bot 后看不到另一只的 [AC:bot-fork-sessions-in-detail#AC-2]', () => {
  const first = render({
    botId: 'researcher',
    botName: '资料员',
    open: true,
    initialSection: 'tasks',
    preview: { jobs: [], files: [], memories: [] },
    childTasks: researcherTasks
  });
  const second = render({
    botId: 'writer',
    botName: '写作者',
    open: true,
    initialSection: 'tasks',
    preview: { jobs: [], files: [], memories: [] },
    childTasks: writerTasks
  });
  assert.match(first, /data-testid="bot-detail-child-tasks"/);
  assert.match(first, /data-bot-id="researcher"/);
  assert.match(first, /整理本周纪要/);
  assert.match(first, /对照竞品价格/);
  assert.equal(first.includes('写发布说明'), false);
  assert.equal(first.includes('目前没有子任务'), false);
  assert.match(second, /data-bot-id="writer"/);
  assert.match(second, /写发布说明/);
  assert.equal(second.includes('整理本周纪要'), false);
  assert.equal(second.includes('对照竞品价格'), false);
});

test('没有子任务时详情里说明目前没有子任务 [AC:bot-fork-sessions-in-detail#AC-3]', () => {
  const html = render({
    botId: 'bot-empty',
    botName: '空',
    open: true,
    initialSection: 'tasks',
    preview: { jobs: [], files: [], memories: [] },
    childTasks: []
  });
  assert.match(html, /data-testid="bot-detail-child-tasks"/);
  assert.match(html, /目前没有子任务/);
  assert.equal(html.includes('data-testid="bot-detail-child-task"'), false);
});

test('点开详情里的子任务会打开这条子任务会话 [AC:bot-fork-sessions-in-detail#AC-4]', () => {
  const opened: string[] = [];
  const clicks: Array<() => void> = [];
  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
  };
  const originalJsx = jsxRuntime.jsx;
  const originalJsxs = jsxRuntime.jsxs;
  const spy = (original: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: string) => {
    if (props?.['data-testid'] === 'bot-detail-child-task' && props['data-session-id'] === 'child-1' && typeof props.onClick === 'function') {
      clicks.push(props.onClick as () => void);
    }
    return original(type, props, key);
  };
  jsxRuntime.jsx = spy(originalJsx);
  jsxRuntime.jsxs = spy(originalJsxs);
  try {
    const html = render({
      botId: 'researcher',
      botName: '资料员',
      open: true,
      initialSection: 'tasks',
      preview: { jobs: [], files: [], memories: [] },
      childTasks: researcherTasks,
      onOpenChildTask: (id: string) => opened.push(id)
    });
    assert.match(html, /data-session-id="child-1"/);
    assert.match(html, /整理本周纪要/);
    assert.equal(clicks.length > 0, true);
    clicks[0]!();
    assert.deepEqual(opened, ['child-1']);
  } finally {
    jsxRuntime.jsx = originalJsx;
    jsxRuntime.jsxs = originalJsxs;
  }
  const panel = readFileSync(new URL('./PlayPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /onOpenChildTask/);
  assert.match(panel, /onSelectSession\(sessionId\)/);
});

const emptyPreview = { jobs: [], files: [], memories: [] };

function tabIds(html: string): string[] {
  return [...html.matchAll(/role="tab"[^>]*data-testid="(bot-detail-tab-[^"]+)"/g)].map((match) => match[1]!);
}

function innerHtml(html: string, marker: string): string {
  const markerAt = html.indexOf(marker);
  assert.ok(markerAt >= 0, marker);
  const tagStart = html.lastIndexOf('<', markerAt);
  const tagName = /^<([A-Za-z0-9]+)/.exec(html.slice(tagStart))?.[1];
  assert.ok(tagName);
  const token = new RegExp(`<(/?)${tagName}\\b[^>]*>`, 'gi');
  token.lastIndex = tagStart;
  let depth = 0;
  let innerStart = -1;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    if (match[0].endsWith('/>')) continue;
    const closing = match[1] === '/';
    if (!closing && depth === 0) innerStart = token.lastIndex;
    depth += closing ? -1 : 1;
    if (depth === 0) return html.slice(innerStart, match.index);
  }
  assert.fail(`unclosed ${marker}`);
}

test('打开详情时子任务不铺在顶部，其它页签能直接点到 [AC:bot-detail-child-tasks-tab#AC-1]', () => {
  const longTitle = '自动在输入框填下一次可能输入的内容'.repeat(6);
  const tasks = Array.from({ length: 12 }, (_, index) => ({ id: `child-${index}`, title: `${longTitle} #${index}` }));
  const html = render({
    botId: 'researcher',
    botName: '资料员',
    open: true,
    onClose: () => {},
    preview: emptyPreview,
    childTasks: tasks
  });
  const tabs = tabIds(html);
  assert.deepEqual(tabs[0], 'bot-detail-tab-routines');
  for (const id of ['bot-detail-tab-files', 'bot-detail-tab-memory', 'bot-detail-tab-skills', 'bot-detail-tab-tasks']) {
    assert.equal(tabs.includes(id), true, id);
  }
  assert.match(html, /data-testid="bot-detail-tab-routines"[^>]*aria-selected="true"/);
  assert.equal(/data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/.test(html), false);
  const tablist = html.indexOf('role="tablist"');
  const taskBlock = html.indexOf('data-testid="bot-detail-child-tasks"');
  assert.ok(tablist > html.indexOf('data-testid="bot-detail-close"'));
  assert.equal(taskBlock === -1 || taskBlock > tablist, true);
  assert.equal(html.includes(longTitle), false);
  assert.equal(html.includes('data-testid="bot-detail-child-task"'), false);
});

test('点子任务页签能看到当前 Bot 的子任务原文标题 [AC:bot-detail-child-tasks-tab#AC-2]', () => {
  const html = render({
    botId: 'researcher',
    botName: '资料员',
    open: true,
    initialSection: 'tasks',
    preview: emptyPreview,
    childTasks: researcherTasks
  });
  assert.match(html, /data-testid="bot-detail-tab-tasks"[^>]*>子任务</);
  assert.match(html, /data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/);
  assert.match(html, /data-testid="bot-detail-child-tasks"/);
  assert.match(html, /data-session-id="child-1"/);
  assert.match(html, /整理本周纪要/);
  assert.match(html, /data-session-id="child-2"/);
  assert.match(html, /对照竞品价格/);
  assert.equal(html.includes('写发布说明'), false);
  assert.match(html, /data-bot-id="researcher"/);
});

test('没有子任务时页签里说明目前没有，顶部不留空白列表 [AC:bot-detail-child-tasks-tab#AC-3]', () => {
  const tab = render({
    botId: 'bot-empty',
    botName: '空',
    open: true,
    initialSection: 'tasks',
    preview: emptyPreview,
    childTasks: []
  });
  assert.match(tab, /data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/);
  assert.match(tab, /data-testid="bot-detail-child-tasks"/);
  assert.match(tab, /目前没有子任务/);
  assert.equal(tab.includes('data-testid="bot-detail-child-task"'), false);

  const top = render({
    botId: 'bot-empty',
    botName: '空',
    open: true,
    onClose: () => {},
    preview: emptyPreview,
    childTasks: []
  });
  const tablist = top.indexOf('role="tablist"');
  const taskBlock = top.indexOf('data-testid="bot-detail-child-tasks"');
  assert.ok(tablist > top.indexOf('data-testid="bot-detail-close"'));
  assert.equal(taskBlock, -1);
  assert.equal(top.includes('目前没有子任务'), false);
  assert.match(top, /data-testid="bot-detail-tab-routines"[^>]*aria-selected="true"/);
  assert.equal(tabIds(top).includes('bot-detail-tab-tasks'), true);
});

test('换 Bot 后页签里只有那一只的子任务 [AC:bot-detail-child-tasks-tab#AC-4]', () => {
  const first = render({
    botId: 'researcher',
    botName: '资料员',
    open: true,
    initialSection: 'tasks',
    preview: emptyPreview,
    childTasks: researcherTasks
  });
  const second = render({
    botId: 'writer',
    botName: '写作者',
    open: true,
    initialSection: 'tasks',
    preview: emptyPreview,
    childTasks: writerTasks
  });
  assert.match(first, /data-bot-id="researcher"/);
  assert.match(first, /data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/);
  assert.match(first, /整理本周纪要/);
  assert.match(first, /对照竞品价格/);
  assert.equal(first.includes('写发布说明'), false);
  assert.match(second, /data-bot-id="writer"/);
  assert.match(second, /data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/);
  assert.match(second, /写发布说明/);
  assert.equal(second.includes('整理本周纪要'), false);
  assert.equal(second.includes('对照竞品价格'), false);
});

test('在页签里点开一条，主区打开这条子任务 [AC:bot-detail-child-tasks-tab#AC-5]', () => {
  const opened: string[] = [];
  const clicks: Array<() => void> = [];
  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
  };
  const originalJsx = jsxRuntime.jsx;
  const originalJsxs = jsxRuntime.jsxs;
  const spy = (original: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: string) => {
    if (props?.['data-testid'] === 'bot-detail-child-task' && props['data-session-id'] === 'child-1' && typeof props.onClick === 'function') {
      clicks.push(props.onClick as () => void);
    }
    return original(type, props, key);
  };
  jsxRuntime.jsx = spy(originalJsx);
  jsxRuntime.jsxs = spy(originalJsxs);
  try {
    const html = render({
      botId: 'researcher',
      botName: '资料员',
      open: true,
      initialSection: 'tasks',
      preview: emptyPreview,
      childTasks: researcherTasks,
      onOpenChildTask: (id: string) => opened.push(id)
    });
    assert.match(html, /data-testid="bot-detail-tab-tasks"[^>]*aria-selected="true"/);
    assert.match(html, /整理本周纪要/);
    assert.equal(clicks.length > 0, true);
    clicks[0]!();
    assert.deepEqual(opened, ['child-1']);
  } finally {
    jsxRuntime.jsx = originalJsx;
    jsxRuntime.jsxs = originalJsxs;
  }
  const panel = readFileSync(new URL('./PlayPanel.tsx', import.meta.url), 'utf8');
  const start = panel.indexOf('onOpenChildTask=');
  const end = panel.indexOf('}}', start);
  assert.ok(start >= 0 && end > start);
  const handler = panel.slice(start, end + 2);
  assert.match(handler, /onSelectSession\(sessionId\)/);
  assert.equal(handler.includes('canonicalSessionId'), false);
});

test('子任务很多时列表在页签内滚动，页签栏和关闭按钮留在屏幕里 [AC:bot-detail-child-tasks-tab#AC-6]', () => {
  const longTitle = '很长的任务原文标题'.repeat(12);
  const tasks = Array.from({ length: 30 }, (_, index) => ({ id: `child-${index}`, title: `${longTitle}-${index}` }));
  const html = render({
    botId: 'researcher',
    botName: '资料员',
    open: true,
    initialSection: 'tasks',
    onClose: () => {},
    preview: emptyPreview,
    childTasks: tasks
  });
  const closeAt = html.indexOf('data-testid="bot-detail-close"');
  const tablistAt = html.indexOf('role="tablist"');
  const scrollAt = html.indexOf('data-testid="bot-detail-scroll"');
  assert.ok(closeAt >= 0 && tablistAt > closeAt && scrollAt > tablistAt);
  const tabs = innerHtml(html, 'role="tablist"');
  const scroll = innerHtml(html, 'data-testid="bot-detail-scroll"');
  assert.equal(tabs.includes(longTitle), false);
  assert.equal(tabs.includes('data-testid="bot-detail-close"'), false);
  assert.match(tabs, /data-testid="bot-detail-tab-tasks"/);
  assert.equal(scroll.includes('data-testid="bot-detail-close"'), false);
  assert.equal(scroll.includes('role="tablist"'), false);
  assert.match(scroll, /data-testid="bot-detail-child-tasks"/);
  assert.match(scroll, /data-session-id="child-0"/);
  assert.match(scroll, /data-session-id="child-29"/);
  assert.equal(scroll.includes(`${longTitle}-0`), true);
  assert.equal(scroll.includes(`${longTitle}-29`), true);
  const css = readFileSync(new URL('./BotDetailMenu.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.panel\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.body\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.body\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.head\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(css, /\.tabs\s*\{[^}]*flex-shrink:\s*0/);
});
