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
    if (id === 'react') return React;
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => {
      let text = copy[key] ?? key;
      for (const [name, value] of Object.entries(vars ?? {})) text = text.replaceAll(`{${name}}`, value);
      return text;
    } }) };
    if (id === '@/lib/api') return { api: async () => ({}) };
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
