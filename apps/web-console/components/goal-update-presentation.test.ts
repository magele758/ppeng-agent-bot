import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';

const VERIFY_REASON = 'Completion verification unavailable; evidence retained for review';
const NUDGE_TELL = 'Briefly tell the user this meaningful change.';
const NUDGE_RESTART = 'Do not restart this goal or treat this notification as a new user task.';
const GOAL_ID = 'goal_84377e09-043c-4a93-86de-3e834e1678be';
const CURRENT = 'sess-current';
const OTHER = 'sess-other';

type Role = 'user' | 'assistant' | 'tool' | 'system';
type Turn = { role: Role; text: string; sessionId?: string };

function goalUpdateText(fields: {
  id: string;
  title: string;
  status: string;
  progress?: string;
  reason?: string;
  nextStep?: string;
}): string {
  const payload: Record<string, string> = { id: fields.id, title: fields.title, status: fields.status };
  if (fields.progress !== undefined) payload.progress = fields.progress;
  if (fields.reason !== undefined) payload.reason = fields.reason;
  if (fields.nextStep !== undefined) payload.nextStep = fields.nextStep;
  return `[goal update] ${JSON.stringify(payload)}\n${NUDGE_TELL} ${NUDGE_RESTART}`;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const localRequire = createRequire(import.meta.url);
const i18n = {
  useI18n: () => ({
    locale: 'zh' as const,
    messages: zh,
    setLocale: () => undefined,
    t: (key: string, vars?: Record<string, string | number>) => translate(zh, key, vars)
  })
};

const loaded = new Map<string, Record<string, unknown>>();

function resolveFile(request: string): string {
  const candidates = [request, `${request}.ts`, `${request}.tsx`, `${request}.js`, path.join(request, 'index.ts'), path.join(request, 'index.tsx'), path.join(request, 'index.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith('.css')) return candidate;
    if (candidate.endsWith('.css') && existsSync(candidate)) return candidate;
  }
  const css = candidates.find((candidate) => candidate.endsWith('.css'));
  if (css && existsSync(css)) return css;
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
  const requireFrom = (id: string) => requireId(resolved, id);
  new Function('require', 'module', 'exports', compiled)(requireFrom, mod, mod.exports);
  return mod.exports;
}

function requireId(fromFile: string, id: string): unknown {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return localRequire(id);
  if (id === '@/lib/i18n' || id.startsWith('@/lib/i18n/')) return i18n;
  if (id.endsWith('.css')) return new Proxy({}, { get: (_target, prop) => String(prop) });
  if (id.startsWith('@/')) return loadFile(resolveFile(path.join(webRoot, id.slice(2))));
  if (id.startsWith('.')) return loadFile(resolveFile(path.resolve(path.dirname(fromFile), id)));
  return localRequire(id);
}

const ui = loadFile(path.join(here, 'ChatTurns.tsx')) as {
  ChatTurnPlain: React.ComponentType<Record<string, unknown>>;
  ChatTurnFromMessage: React.ComponentType<Record<string, unknown>>;
};

function renderTurns(turns: readonly Turn[], conversationId: string): string {
  return renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-testid': 'conversation' },
      turns.map((turn, index) =>
        React.createElement(ui.ChatTurnPlain, {
          key: String(index),
          role: turn.role,
          text: turn.text,
          messageSessionId: turn.sessionId,
          conversationId
        })
      )
    )
  );
}

function textOf(html: string, testId: string): string {
  const match = new RegExp(`data-testid="${testId}"[^>]*>([\\s\\S]*?)<`).exec(html);
  assert.ok(match, `missing ${testId} in ${html}`);
  return match[1] ?? '';
}

function cards(html: string): string[] {
  return [...html.matchAll(/<article\b[^>]*data-testid="goal-update-card"[^>]*>[\s\S]*?<\/article>/g)].map((match) => match[0]);
}

const blockedNotice = goalUpdateText({
  id: GOAL_ID,
  title: '可以考虑让bo',
  status: 'blocked',
  progress: 'probe-progress-9f3a',
  reason: VERIFY_REASON,
  nextStep: 'probe-next-step-9f3a'
});

test('目标更新不再显示花括号原文和英文叮嘱 [AC:goal-update-presentation#AC-1]', () => {
  const html = renderTurns([{ role: 'system', text: blockedNotice, sessionId: CURRENT }], CURRENT);
  assert.equal(cards(html).length, 1);
  assert.equal(cards(html).join('').includes('[goal update]'), false);
  assert.equal(cards(html).join('').includes(NUDGE_TELL), false);
  assert.equal(cards(html).join('').includes(NUDGE_RESTART), false);
  assert.equal(cards(html).join('').includes('{"id"'), false);
  assert.equal(cards(html).join('').includes('probe-progress-9f3a'), false);
  assert.equal(cards(html).join('').includes('probe-next-step-9f3a'), false);
  assert.match(html, /可以考虑让bo/);
});

test('目标更新显示为带标题、可读状态和人话原因的状态卡 [AC:goal-update-presentation#AC-2]', () => {
  const cases = [
    { status: 'blocked', label: '受阻', title: '周报草稿' },
    { status: 'running', label: '进行中', title: '整理资料' },
    { status: 'completed', label: '完成', title: '发出周报' }
  ] as const;
  for (const item of cases) {
    const html = renderTurns(
      [{
        role: 'system',
        sessionId: CURRENT,
        text: goalUpdateText({
          id: GOAL_ID,
          title: item.title,
          status: item.status,
          reason: '证据已经对齐',
          progress: 'probe-progress-9f3a'
        })
      }],
      CURRENT
    );
    assert.equal(cards(html).length, 1);
    assert.equal(textOf(html, 'goal-update-title'), item.title);
    assert.equal(textOf(html, 'goal-update-status'), item.label);
    assert.match(html, new RegExp(`data-status="${item.status}"`));
    assert.equal(textOf(html, 'goal-update-reason'), '证据已经对齐');
    assert.equal(cards(html).join('').includes(GOAL_ID), false);
    assert.equal(cards(html).join('').includes('probe-progress-9f3a'), false);
  }

  const untitled = renderTurns(
    [{
      role: 'system',
      sessionId: CURRENT,
      text: goalUpdateText({
        id: 'goal_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        title: '',
        status: 'blocked',
        reason: '先停一下'
      })
    }],
    CURRENT
  );
  const fallbackTitle = textOf(untitled, 'goal-update-title');
  assert.equal(fallbackTitle, '目标有更新');
  assert.equal(cards(untitled).join('').includes('goal_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), false);

  const unknown = renderTurns(
    [{
      role: 'system',
      sessionId: CURRENT,
      text: goalUpdateText({
        id: GOAL_ID,
        title: '整理资料',
        status: 'running',
        reason: 'worker lease expired before verification'
      })
    }],
    CURRENT
  );
  assert.equal(textOf(unknown, 'goal-update-status'), '进行中');
  assert.equal(textOf(unknown, 'goal-update-reason'), '这次变化已记下，细节留待查看');
  assert.equal(cards(unknown).join('').includes('worker lease expired before verification'), false);
});

test('受阻原因写成完成核验不可用、证据留着待查 [AC:goal-update-presentation#AC-3]', () => {
  const html = renderTurns([{ role: 'system', text: blockedNotice, sessionId: CURRENT }], CURRENT);
  assert.equal(textOf(html, 'goal-update-status'), '受阻');
  assert.equal(textOf(html, 'goal-update-reason'), '完成核验不可用、证据留着待查');
  assert.equal(cards(html).join('').includes(VERIFY_REASON), false);
  assert.equal(cards(html).join('').includes('Completion verification unavailable'), false);
  assert.equal(cards(html).join('').includes('evidence retained for review'), false);
});

test('没有目标更新时不出现空的目标状态卡 [AC:goal-update-presentation#AC-4]', () => {
  const html = renderTurns(
    [
      { role: 'user', text: '今天天气怎么样', sessionId: CURRENT },
      { role: 'assistant', text: '我看不到窗外，但可以查。', sessionId: CURRENT },
      {
        role: 'system',
        text: '[goal coordination] Ask which goal should change priority; keep other goals unchanged.',
        sessionId: CURRENT
      }
    ],
    CURRENT
  );
  assert.equal(html.includes('goal-update-card'), false);
  assert.equal(html.includes('goal-status-card'), false);
  assert.match(html, /今天天气怎么样/);
  assert.match(html, /我看不到窗外，但可以查。/);
  assert.match(html, /Ask which goal should change priority/);
  assert.equal(renderTurns([], CURRENT).includes('goal-update-card'), false);
});

test('用户消息和助手回复仍按原样显示 [AC:goal-update-presentation#AC-5]', () => {
  const userText = '请把结论写短一点';
  const assistantText = '好，我改成三句话。';
  const html = renderTurns(
    [
      { role: 'user', text: userText, sessionId: CURRENT },
      { role: 'assistant', text: assistantText, sessionId: CURRENT },
      { role: 'system', text: blockedNotice, sessionId: CURRENT }
    ],
    CURRENT
  );
  assert.equal(cards(html).length, 1);
  assert.match(html, /chat-turn--user[\s\S]*请把结论写短一点/);
  assert.match(html, /chat-turn--assistant[\s\S]*好，我改成三句话。/);
  const card = cards(html)[0] ?? '';
  assert.equal(card.includes(userText), false);
  assert.equal(card.includes(assistantText), false);
  assert.match(html, /可以考虑让bo/);
});

test('不属于当前对话的目标更新不出现 [AC:goal-update-presentation#AC-6]', () => {
  const html = renderTurns(
    [
      { role: 'user', text: '继续看这个目标', sessionId: CURRENT },
      {
        role: 'system',
        sessionId: CURRENT,
        text: goalUpdateText({ id: 'goal_current', title: '可以考虑让bo', status: 'blocked', reason: '证据已经对齐' })
      },
      {
        role: 'system',
        sessionId: CURRENT,
        text: goalUpdateText({ id: 'goal_same_chat', title: '同一段对话的另一件事', status: 'running', reason: '还在做' })
      },
      {
        role: 'system',
        sessionId: OTHER,
        text: goalUpdateText({
          id: 'goal_other_session',
          title: '隔壁会话的目标',
          status: 'completed',
          reason: 'shipped in the other session'
        })
      }
    ],
    CURRENT
  );
  assert.match(html, /可以考虑让bo/);
  assert.match(html, /同一段对话的另一件事/);
  assert.equal(html.includes('隔壁会话的目标'), false);
  assert.equal(html.includes('goal_other_session'), false);
  assert.equal(html.includes('shipped in the other session'), false);

  const other = renderTurns(
    [
      { role: 'assistant', text: '这边还没有目标通知。', sessionId: OTHER },
      {
        role: 'system',
        sessionId: CURRENT,
        text: goalUpdateText({ id: GOAL_ID, title: '可以考虑让bo', status: 'blocked', reason: VERIFY_REASON })
      },
      {
        role: 'system',
        sessionId: OTHER,
        text: goalUpdateText({ id: 'goal_other_goal', title: '另一个目标的标题', status: 'completed', reason: '已经做完' })
      }
    ],
    OTHER
  );
  assert.match(other, /另一个目标的标题/);
  assert.match(other, /这边还没有目标通知。/);
  assert.equal(other.includes('可以考虑让bo'), false);
  assert.equal(other.includes(GOAL_ID), false);
  assert.equal(other.includes(VERIFY_REASON), false);
});


test('system cards cover immediate, historical, mixed and model-view text [AC:system-message-ui#AC-1] [AC:system-message-ui#AC-3]', () => {
  const text = '[recovery] Stopped: test-only';
  const immediate = renderTurns([{ role: 'system', text, sessionId: CURRENT }], CURRENT);
  assert.match(immediate, /data-kind="stopped"/);
  const message = { role: 'system', parts: [{ type: 'text', text }] };
  const render = (m: unknown, modelView = false) => renderToStaticMarkup(React.createElement(ui.ChatTurnFromMessage, { m, sessionId: CURRENT, modelView }));
  assert.match(render(message), /data-kind="stopped"/);
  assert.doesNotMatch(render(message, true), /data-testid="system-notice-card"/);
  assert.match(render(message, true), /chat-bubble__pre/);
  const mixed = render({ role: 'system', parts: [{ type: 'text', text }, { type: 'tool_result', toolCallId: 'synthetic-call', name: 'example', content: 'PRESERVED_TOOL_RESULT', isError: false }] });
  assert.match(mixed, /data-kind="stopped"/);
  assert.match(mixed, /PRESERVED_TOOL_RESULT/);
  assert.doesNotMatch(renderTurns([{ role: 'user', text }], CURRENT), /data-testid="system-notice-card"/);
});

test('raw goal-update details remain available in a closed disclosure [AC:system-message-ui#AC-2]', () => {
  const html = renderTurns([{ role: 'system', text: blockedNotice, sessionId: CURRENT }], CURRENT);
  assert.match(html, /<details><summary>原始详情<\/summary><pre>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.match(html, /probe-progress-9f3a/);
  assert.match(html, /Briefly tell the user/);
});
