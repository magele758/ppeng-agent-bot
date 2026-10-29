import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { streamChildTaskEntries } from '../lib/bot-child-task-stream.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import type { Messages } from '../lib/i18n/messages/types.ts';
import { translate } from '../lib/i18n/t.ts';

const longA = '请把上周所有客户会议纪要按主题归类，并标出还没回复的行动项，最后写成一页摘要。TAIL-A-9f3c';
const longB = '对照三家竞品的公开标价和折扣规则，整理成一张表，标出我们更贵的项目。TAIL-B-77ab';
const goalText = '继续把目标拆成可核对的步骤';
const writerTask = '写发布说明';
const userText = '这周末去爬山吗';
const assistantText = '可以，我先看天气';

const researcher = { id: 'researcher', canonicalSessionId: 'sess-researcher' };
const writer = { id: 'writer', canonicalSessionId: 'sess-writer' };
const sessions = [
  { id: 'sess-researcher', title: '资料员' },
  { id: 'sess-writer', title: '写作者' },
  { id: 'chat-plain', title: '周末去哪玩' },
  {
    id: 'child-a',
    title: longA,
    metadata: { botId: 'researcher', botGoalWorker: true, spawnSource: 'bot-goal-continuation', sourceMessageId: 'u1' }
  },
  {
    id: 'child-b',
    title: longB,
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher', sourceMessageId: 'u1' }
  },
  {
    id: 'child-goal',
    title: `Bot Chat · ${goalText}`,
    metadata: { botId: 'researcher', spawnSource: 'bot-goal-continuation', sourceMessageId: 'u1' }
  },
  {
    id: 'child-c',
    title: writerTask,
    metadata: { botId: 'writer', botGoalWorker: true, sourceMessageId: 'u1' }
  }
];

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
let catalog: Messages = zh;
const i18n = {
  useI18n: () => ({
    locale: catalog === en ? 'en' as const : 'zh' as const,
    messages: catalog,
    setLocale: () => undefined,
    t: (key: string, vars?: Record<string, string | number>) => translate(catalog, key, vars, catalog)
  })
};
const loaded = new Map<string, Record<string, unknown>>();

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${request}`);
}

function loadFile(file: string): Record<string, unknown> {
  const resolved = path.resolve(file);
  const cached = loaded.get(resolved);
  if (cached) return cached;
  if (resolved.endsWith('.css')) return {};
  const source = readFileSync(resolved, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  loaded.set(resolved, mod.exports);
  new Function('require', 'module', 'exports', compiled)((id: string) => requireId(resolved, id), mod, mod.exports);
  return mod.exports;
}

function requireId(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
  if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18n;
  if (id.endsWith('.css')) return {};
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)));
  return localRequire(id);
}

type TranscriptProps = {
  childTaskEntries?: ReadonlyArray<{ id: string; excerpt: string; title: string }>;
  onOpenChildTask?: (sessionId: string) => void;
};

function PlayTranscript(): React.ComponentType<TranscriptProps & Record<string, unknown>> {
  return (loadFile(path.join(here, 'PlayTranscript.tsx')) as {
    PlayTranscript: React.ComponentType<TranscriptProps & Record<string, unknown>>;
  }).PlayTranscript;
}

function messages() {
  return [
    { id: 'u1', role: 'user', createdAt: '2026-10-22T01:00:00.000Z', parts: [{ type: 'text', text: userText }] },
    { id: 'a1', role: 'assistant', createdAt: '2026-10-22T01:05:00.000Z', parts: [{ type: 'text', text: assistantText }] }
  ];
}

function chatStub() {
  return {
    displayMessages: messages(),
    sessionMessages: messages(),
    transcriptReady: true,
    optimisticUser: null,
    optimisticReply: null,
    streamOverlay: null,
    waitTyping: false,
    historyCursor: null,
    historyLoading: false,
    playMessagesRef: { current: null },
    playStickToBottomRef: { current: true },
    feedScrollIntentRef: { current: null },
    feedRevision: 1,
    showModelView: false,
    modelViewPayload: null,
    needsModelSetup: false,
    steerStreamPrefix: null,
    loadOlderHistory() {},
    handlePlayMessagesScroll() {}
  };
}

function renderStream(
  entries: ReadonlyArray<{ id: string; excerpt: string; title: string; sourceMessageId?: string; createdAt?: string; status?: string }>,
  onOpen?: (sessionId: string) => void,
  feedMessages?: ReturnType<typeof messages>
) {
  const chat = chatStub();
  if (feedMessages) {
    chat.displayMessages = feedMessages;
    chat.sessionMessages = feedMessages;
  }
  return renderToStaticMarkup(React.createElement(PlayTranscript(), {
    chat,
    selectedSessionId: 'sess-researcher',
    sessionApprovals: [],
    turnFeedStatLines: [],
    botSurface: true,
    footer: null,
    onOpenModelSetup() {},
    onNewSession() {},
    onApprovalsChanged() {},
    childTaskEntries: entries,
    onOpenChildTask: onOpen
  }));
}

function researcherEntries() {
  return streamChildTaskEntries({
    surface: 'bot',
    sessions,
    bot: researcher,
    current: sessions[0]
  });
}

function chipTexts(html: string): string[] {
  const texts: string[] = [];
  const re = /<button\b[^>]*data-testid="bot-child-task-stream-entry"[^>]*>([^<]*)<\/button>/g;
  for (const match of html.matchAll(re)) texts.push(match[1] ?? '');
  return texts;
}

function streamNav(html: string): string {
  const match = html.match(/<nav\b[^>]*data-testid="bot-child-task-stream"[^>]*>[\s\S]*?<\/nav>/);
  assert.ok(match, 'missing child task stream entry');
  return match[0];
}

test('对话流里能看到子任务短摘，用户和助手的话仍在 [AC:bot-child-task-stream-entry#AC-1] [AC:bot-child-task-stream-entry#AC-5]', () => {
  const html = renderStream(researcherEntries());
  const feedAt = html.indexOf('id="playMessages"');
  const nav = streamNav(html);
  const chips = chipTexts(nav);
  assert.ok(feedAt >= 0);
  assert.ok(html.indexOf('data-testid="bot-child-task-stream"') > feedAt);
  assert.equal(nav.includes('data-testid="bot-detail-child-tasks"'), false);
  assert.equal(nav.includes('TAIL-A-9f3c'), false);
  assert.equal(nav.includes('TAIL-B-77ab'), false);
  assert.equal(chips.length, 3);
  assert.match(chips[0] ?? '', /^请把上周所有客户/);
  assert.ok((chips[0] ?? '').length <= 32);
  assert.match(chips[1] ?? '', /^对照三家竞品/);
  assert.equal(chips[2], goalText);
  assert.match(html, /chat-turn--user[\s\S]*这周末去爬山吗/);
  assert.match(html, /chat-turn--assistant[\s\S]*可以，我先看天气/);
  assert.equal(nav.includes(userText), false);
  assert.equal(nav.includes(assistantText), false);
  assert.ok(html.indexOf(userText) < html.indexOf('data-testid="bot-child-task-stream"'));
  const css = readFileSync(path.join(here, 'sections/chat/chat.css'), 'utf8');
  const start = css.indexOf('.chat-feed .child-task-stream');
  assert.ok(start >= 0);
  assert.doesNotMatch(css.slice(start, start + 900), /position:\s*(absolute|fixed)/);
});

test('点击一条入口会打开对应的子任务 [AC:bot-child-task-stream-entry#AC-2] [AC:bot-child-task-chip-fill#AC-3]', () => {
  const opened: string[] = [];
  const clicks = new Map<string, () => void>();
  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: string) => unknown;
  };
  const originalJsx = jsxRuntime.jsx;
  const originalJsxs = jsxRuntime.jsxs;
  const spy = (original: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: string) => {
    if (props?.['data-testid'] === 'bot-child-task-stream-entry' && typeof props.onClick === 'function') {
      clicks.set(String(props['data-session-id']), props.onClick as () => void);
    }
    return original(type, props, key);
  };
  jsxRuntime.jsx = spy(originalJsx);
  jsxRuntime.jsxs = spy(originalJsxs);
  try {
    const html = renderStream(researcherEntries(), (id) => opened.push(id));
    assert.match(html, /data-session-id="child-b"[^>]*>对照三家竞品/);
    assert.equal(clicks.has('child-b'), true);
    clicks.get('child-b')!();
    assert.deepEqual(opened, ['child-b']);
  } finally {
    jsxRuntime.jsx = originalJsx;
    jsxRuntime.jsxs = originalJsxs;
  }
  const panel = readFileSync(path.join(here, 'PlayPanel.tsx'), 'utf8');
  const start = panel.indexOf('childTaskEntries={streamChildTasks}');
  const handlerStart = panel.indexOf('onOpenChildTask=', start);
  const handlerEnd = panel.indexOf('}}', handlerStart);
  assert.ok(start >= 0 && handlerStart > start && handlerEnd > handlerStart);
  const handler = panel.slice(handlerStart, handlerEnd + 2);
  assert.match(handler, /onSelectSession\(sessionId\)/);
  assert.equal(handler.includes('canonicalSessionId'), false);
});

test('没有子任务时对话流不出现空入口 [AC:bot-child-task-stream-entry#AC-3]', () => {
  const html = renderStream([]);
  assert.equal(html.includes('data-testid="bot-child-task-stream"'), false);
  assert.equal(html.includes('data-testid="bot-child-task-stream-entry"'), false);
  assert.match(html, /这周末去爬山吗/);
  assert.match(html, /可以，我先看天气/);
  const plain = streamChildTaskEntries({
    surface: 'chat',
    sessions,
    bot: researcher,
    current: sessions.find((session) => session.id === 'chat-plain') ?? null
  });
  assert.deepEqual(plain, []);
});

test('这场主对话的入口没有另一只 Bot 的子任务 [AC:bot-child-task-stream-entry#AC-4]', () => {
  const html = renderStream(researcherEntries());
  assert.equal(html.includes(writerTask), false);
  const theirs = streamChildTaskEntries({
    surface: 'bot',
    sessions,
    bot: writer,
    current: sessions.find((session) => session.id === 'sess-writer') ?? null
  });
  const other = renderStream(theirs);
  assert.match(streamNav(other), /写发布说明/);
  assert.equal(other.includes('TAIL-A-9f3c'), false);
  assert.equal(other.includes('请把上周所有客户'), false);
});

test('入口说法随界面语言切换 [AC:bot-child-task-stream-entry#AC-6]', () => {
  catalog = zh;
  const zhHtml = streamNav(renderStream(researcherEntries()));
  assert.match(zhHtml, /子任务/);
  assert.match(zhHtml, /打开这条子任务/);
  assert.equal(zhHtml.includes('Child tasks'), false);
  assert.equal(zhHtml.includes('Open this child task'), false);
  catalog = en;
  const enHtml = streamNav(renderStream(researcherEntries()));
  assert.match(enHtml, /Child tasks/);
  assert.match(enHtml, /Open this child task/);
  assert.equal(enHtml.includes('子任务'), false);
  assert.equal(enHtml.includes('打开这条子任务'), false);
  catalog = zh;
  assert.notEqual(zh.play.childTask.streamLabel, en.play.childTask.streamLabel);
  assert.notEqual(zh.play.childTask.streamOpen, en.play.childTask.streamOpen);
});

test('正在执行的子任务入口多一行状态，其他状态不加 [AC:bot-child-task-stream-entry#AC-9]', () => {
  const running = {
    id: 'child-running',
    title: '正在整理纪要',
    status: 'running',
    createdAt: '2026-10-22T01:06:00.000Z',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  };
  const idle = {
    id: 'child-idle',
    title: '已经整理完',
    status: 'idle',
    createdAt: '2026-10-22T01:06:01.000Z',
    metadata: { botId: 'researcher', spawnSource: 'concurrent-bot-work', parentSessionId: 'sess-researcher' }
  };
  const passed = streamChildTaskEntries({
    surface: 'bot',
    sessions: [sessions[0]!, running, idle],
    bot: researcher,
    current: sessions[0]
  });
  assert.equal(passed.find((entry) => entry.id === 'child-running')?.status, 'running');
  assert.equal(passed.find((entry) => entry.id === 'child-idle')?.status, 'idle');
  const visible = passed.map((entry) => ({
    id: entry.id,
    excerpt: entry.excerpt,
    title: entry.title,
    status: entry.status,
    createdAt: entry.id === 'child-running' ? running.createdAt : idle.createdAt
  }));
  catalog = zh;
  const zhHtml = streamNav(renderStream(visible));
  assert.match(zhHtml, /正在整理纪要/);
  assert.match(zhHtml, /已经整理完/);
  assert.equal(zhHtml.match(/data-testid="bot-child-task-stream-status"/g)?.length, 1);
  assert.match(zhHtml, /正在执行/);
  assert.equal(zhHtml.includes('Running'), false);
  catalog = en;
  const enHtml = streamNav(renderStream(visible));
  assert.equal(enHtml.match(/data-testid="bot-child-task-stream-status"/g)?.length, 1);
  assert.match(enHtml, /Running/);
  assert.equal(enHtml.includes('正在执行'), false);
  catalog = zh;
  const other = streamNav(renderStream([
    { id: 'done', excerpt: '已经整理完', title: '已经整理完', status: 'completed', createdAt: '2026-10-22T01:06:00.000Z' },
    { id: 'wait', excerpt: '还在等批准', title: '还在等批准', status: 'waiting_approval', createdAt: '2026-10-22T01:06:01.000Z' }
  ]));
  assert.equal(other.includes('data-testid="bot-child-task-stream-status"'), false);
  assert.equal(other.includes('正在执行'), false);
  assert.match(other, /已经整理完/);
  assert.match(other, /还在等批准/);
});

test('较早的子任务留在两句话之间，较晚的跟在后一句后面 [AC:bot-child-task-stream-entry#AC-7]', () => {
  const early = '先把账号换掉';
  const late = '再看一眼输入框';
  const html = renderStream([
    { id: 'early-task', excerpt: '换掉耗尽的账号', title: '换掉耗尽的账号', sourceMessageId: 'early', createdAt: '2026-10-22T01:00:01.000Z' },
    { id: 'late-task', excerpt: '补上输入提示', title: '补上输入提示', createdAt: '2026-10-22T02:00:01.000Z' }
  ], undefined, [
    { id: 'early', role: 'user', createdAt: '2026-10-22T01:00:00.000Z', parts: [{ type: 'text', text: early }] },
    { id: 'late', role: 'user', createdAt: '2026-10-22T02:00:00.000Z', parts: [{ type: 'text', text: late }] }
  ]);
  const earlyText = html.indexOf(early);
  const earlyChip = html.indexOf('data-session-id="early-task"');
  const lateText = html.indexOf(late);
  const lateChip = html.indexOf('data-session-id="late-task"');
  assert.ok(earlyText >= 0 && earlyChip > earlyText);
  assert.ok(earlyChip < lateText);
  assert.ok(lateChip > lateText);
});

test('更早生成、这段里还看不到原话的子任务不堆在末尾 [AC:bot-child-task-stream-entry#AC-8]', () => {
  const visible = '这段里能看到的话';
  const html = renderStream([
    { id: 'old-task', excerpt: '更早的子任务', title: '更早的子任务', sourceMessageId: 'not-loaded', createdAt: '2026-10-22T00:00:00.000Z' },
    { id: 'now-task', excerpt: '这段生成的', title: '这段生成的', sourceMessageId: 'visible', createdAt: '2026-10-22T03:00:01.000Z' }
  ], undefined, [
    { id: 'visible', role: 'user', createdAt: '2026-10-22T03:00:00.000Z', parts: [{ type: 'text', text: visible }] }
  ]);
  assert.equal(html.includes('更早的子任务'), false);
  assert.equal(html.includes('data-session-id="old-task"'), false);
  assert.ok(html.indexOf(visible) < html.indexOf('data-session-id="now-task"'));
});

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing ${selector}`);
  return match[1] ?? '';
}

function bracedBlock(css: string, selector: string): string {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, selector);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  assert.fail(`unclosed ${selector}`);
}

function customHex(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  assert.ok(match, name);
  return (match[1] ?? '').toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
  const value = Number.parseInt(full, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrast(fg: string, bg: string): number {
  const lum = (hex: string) => {
    const { r, g, b } = hexToRgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const a = lum(fg);
  const b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbDistance(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b);
}

function mixHex(fg: string, bg: string, fgPercent: number): string {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  const weight = fgPercent / 100;
  const mix = (from: number, to: number) => Math.round(from * weight + to * (1 - weight));
  const byte = (n: number) => n.toString(16).padStart(2, '0');
  return `#${byte(mix(a.r, b.r))}${byte(mix(a.g, b.g))}${byte(mix(a.b, b.b))}`;
}

function themeColors(): { text: string; page: string; surface: string; stroke: string }[] {
  const palette = readFileSync(path.join(here, '../legacy-vanilla/styles.css'), 'utf8');
  const tokens = readFileSync(path.join(here, '../styles/tokens.css'), 'utf8');
  assert.match(tokens, /--ui-bg:\s*var\(--color-surface-base\)/);
  assert.match(tokens, /--ui-surface:\s*var\(--color-surface-strong\)/);
  assert.match(tokens, /--ui-text:\s*var\(--color-text-primary\)/);
  assert.match(tokens, /--ui-focus:\s*2px solid var\(--color-text-secondary\)/);
  return [bracedBlock(palette, ':root {'), bracedBlock(palette, "[data-theme='light'] {")].map((block) => ({
    text: customHex(block, '--color-text-primary'),
    page: customHex(block, '--color-surface-base'),
    surface: customHex(block, '--color-surface-strong'),
    stroke: customHex(block, '--color-text-secondary')
  }));
}

test('子任务芯片有和对话正文不同的底色，短摘仍可读 [AC:bot-child-task-chip-fill#AC-1]', () => {
  const css = readFileSync(path.join(here, 'sections/chat/chat.css'), 'utf8');
  const chip = cssRule(css, '.chat-feed .child-task-stream__chip');
  const label = cssRule(css, '.chat-feed .child-task-stream__label');
  assert.match(chip, /background:\s*var\(--ui-surface\)/);
  assert.doesNotMatch(chip, /background:\s*(?:transparent|none|var\(--ui-bg\))/);
  assert.match(chip, /color:\s*var\(--ui-text\)/);
  assert.doesNotMatch(chip, /#[0-9a-fA-F]{3,8}/);
  assert.equal(/\bbackground\s*:/.test(label), false);
  for (const theme of themeColors()) {
    assert.ok(rgbDistance(theme.surface, theme.page) >= 24);
    assert.ok(contrast(theme.text, theme.surface) >= 4.5);
  }
  const chips = chipTexts(streamNav(renderStream(researcherEntries())));
  assert.match(chips[0] ?? '', /^请把上周所有客户/);
  assert.match(chips[1] ?? '', /^对照三家竞品/);
});

test('悬停或键盘聚焦时子任务芯片的底色或描边会变，字仍读得清 [AC:bot-child-task-chip-fill#AC-2]', () => {
  const css = readFileSync(path.join(here, 'sections/chat/chat.css'), 'utf8');
  const hover = cssRule(css, '.chat-feed .child-task-stream__chip:hover');
  const focus = cssRule(css, '.chat-feed .child-task-stream__chip:focus-visible');
  const hoverFill = 'color-mix(in srgb, var(--ui-text) 8%, var(--ui-surface))';
  assert.match(hover, new RegExp(`background:\\s*${hoverFill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(hover, /border-color:\s*color-mix\(in srgb, var\(--ui-text\) 28%, var\(--ui-border\)\)/);
  assert.doesNotMatch(hover, /#[0-9a-fA-F]{3,8}/);
  assert.match(focus, /outline:\s*var\(--ui-focus\)/);
  assert.match(focus, /background:\s*color-mix\(in srgb, var\(--ui-text\) 8%, var\(--ui-surface\)\)/);
  assert.doesNotMatch(focus, /#[0-9a-fA-F]{3,8}/);
  for (const theme of themeColors()) {
    const hovered = mixHex(theme.text, theme.surface, 8);
    assert.ok(rgbDistance(hovered, theme.surface) >= 30);
    assert.ok(contrast(theme.text, hovered) >= 4.5);
    assert.ok(rgbDistance(theme.stroke, theme.surface) >= 24);
  }
});
