import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../lib/i18n/t.ts';
import { en } from '../lib/i18n/messages/en/index.ts';
import { zh } from '../lib/i18n/messages/zh/index.ts';
import { matchesQuery } from '../lib/settings-search.ts';
import type { Messages } from '../lib/i18n/messages/types.ts';
import type { QuietHoursDraft, QuietHoursSettings } from '../lib/delivery-quiet-hours-form.ts';

const localRequire = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cardFile = path.join(webRoot, 'components/DeliveryQuietHoursSettingsCard.tsx');
const behaviorFile = path.join(webRoot, 'components/sections/settings/categories/behavior.tsx');

const savedSettings: QuietHoursSettings = {
  enabled: false,
  startHour: 22,
  endHour: 8,
  timezone: 'Asia/Shanghai',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

interface SaveCall {
  path: string;
  patch: Record<string, unknown>;
}

interface Harness {
  html: string;
  saves: SaveCall[];
  state: { reloads: number; errors: Partial<Record<keyof QuietHoursDraft, string>> | null };
  toggle?: (enabled: boolean) => void;
  save?: () => void;
  retry?: () => void;
}

function inputTag(html: string, id: string): string {
  const tag = (html.match(/<input\b[^>]*>/g) ?? []).find((item) => item.includes(`id="${id}"`));
  assert.ok(tag, `missing input ${id}`);
  return tag ?? '';
}

function resolveModule(fromFile: string, id: string): string | null {
  if (!id.startsWith('.') && !id.startsWith('@/')) return null;
  const base = id.startsWith('@/') ? path.join(webRoot, id.slice(2)) : path.resolve(path.dirname(fromFile), id);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

function loadCard(options: {
  messages: Messages;
  settings: QuietHoursSettings | null;
  loadError?: string | null;
  draft?: QuietHoursDraft;
}): Harness {
  const saves: SaveCall[] = [];
  const state = { reloads: 0, errors: null as Harness['state']['errors'] };
  const captured: Harness = { html: '', saves, state };
  const jsxRuntime = localRequire('react/jsx-runtime') as {
    jsx: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
    jsxs: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => unknown;
  };
  const watch = (orig: typeof jsxRuntime.jsx) => (type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
    if (props?.id === 'field-quietEnabled' && props.type !== 'checkbox' && typeof props.onChange === 'function') {
      captured.toggle = props.onChange as (enabled: boolean) => void;
    }
    if (typeof props?.onSave === 'function' && typeof props.onReset === 'function') {
      captured.save = props.onSave as () => void;
    }
    if (typeof props?.onRetry === 'function' && props.ready === false) {
      captured.retry = props.onRetry as () => void;
    }
    return orig(type, props, key);
  };
  const wrappedJsx = { ...jsxRuntime, jsx: watch(jsxRuntime.jsx), jsxs: watch(jsxRuntime.jsxs) };
  const cache = new Map<string, Record<string, unknown>>();

  const reqFrom = (fromFile: string) => (id: string) => {
    if (id === 'react' || id === 'react-dom' || id === 'react-dom/server') return localRequire(id);
    if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') return wrappedJsx;
    if (id.endsWith('.css')) return {};
    if (id === '@/lib/i18n') {
      return {
        useI18n: () => ({
          t: (key: string, vars?: Record<string, string | number>) => translate(options.messages, key, vars)
        })
      };
    }
    if (id.includes('settings-store')) {
      return {
        useSettingsResource: (resourcePath: string) => ({
          settings: options.settings,
          effective: null,
          loadError: options.loadError ?? null,
          busy: false,
          status: null,
          reload: async () => { state.reloads += 1; },
          save: async (patch: Record<string, unknown>) => {
            saves.push({ path: resourcePath, patch });
            return true;
          },
          setStatus() {},
          run: async () => undefined
        })
      };
    }
    if (options.draft && id.includes('useDraftForm')) {
      return {
        useDraftForm: () => ({
          draft: options.draft,
          set() {},
          reset() {},
          dirty: true,
          errors: {},
          setErrors(next: Harness['state']['errors']) { state.errors = next; },
          setError() {}
        })
      };
    }
    const resolved = resolveModule(fromFile, id);
    if (!resolved) return localRequire(id);
    if (resolved.endsWith('.css')) return {};
    return loadFile(resolved);
  };

  function loadFile(file: string): Record<string, unknown> {
    const hit = cache.get(file);
    if (hit) return hit;
    const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true
      },
      fileName: file
    }).outputText;
    const mod = { exports: {} as Record<string, unknown> };
    cache.set(file, mod.exports);
    const runner = new Function('require', 'module', 'exports', compiled) as (
      require: (id: string) => unknown,
      module: { exports: Record<string, unknown> },
      exports: Record<string, unknown>
    ) => void;
    runner(reqFrom(file), mod, mod.exports);
    return mod.exports;
  }

  const card = loadFile(cardFile).DeliveryQuietHoursSettingsCard as () => React.ReactElement;
  captured.html = renderToStaticMarkup(React.createElement(card));
  return captured;
}

test('设置里能看到静默时段的开关和窗口，中英文都有文案 [AC:delivery-quiet-hours#AC-6]', () => {
  const behavior = readFileSync(behaviorFile, 'utf8');
  assert.match(behavior, /id:\s*'deliveryQuietHours'/);
  assert.match(behavior, /category:\s*'behavior'/);
  assert.match(behavior, /DeliveryQuietHoursSettingsCard/);
  const zhHay = [zh.settingsEntries.deliveryQuietHours.title, zh.settingsEntries.deliveryQuietHours.keywords].join(' ');
  const enHay = [en.settingsEntries.deliveryQuietHours.title, en.settingsEntries.deliveryQuietHours.keywords].join(' ');
  assert.equal(matchesQuery(zhHay, '静默'), true);
  assert.equal(matchesQuery(enHay, 'quiet hours'), true);

  const zhCard = loadCard({ messages: zh, settings: savedSettings });
  assert.match(zhCard.html, /id="card-delivery-quiet-hours"/);
  assert.match(zhCard.html, /静默时段/);
  assert.match(zhCard.html, /发给别人的内容先暂存/);
  assert.match(inputTag(zhCard.html, 'field-quietEnabled'), /type="checkbox"/);
  assert.doesNotMatch(inputTag(zhCard.html, 'field-quietEnabled'), /checked/);
  assert.match(inputTag(zhCard.html, 'field-quietStart'), /value="22"/);
  assert.match(inputTag(zhCard.html, 'field-quietEnd'), /value="8"/);
  assert.match(inputTag(zhCard.html, 'field-quietTimezone'), /value="Asia\/Shanghai"/);
  assert.equal(zhCard.toggle !== undefined, true);

  const enCard = loadCard({ messages: en, settings: { ...savedSettings, enabled: true, startHour: 1, endHour: 6, timezone: 'UTC' } });
  assert.match(enCard.html, /Quiet hours/);
  assert.match(enCard.html, /Enable quiet hours/);
  assert.match(enCard.html, /Start hour/);
  assert.match(enCard.html, /End hour/);
  assert.match(enCard.html, /Timezone/);
  assert.match(inputTag(enCard.html, 'field-quietStart'), /value="1"/);
  assert.match(inputTag(enCard.html, 'field-quietTimezone'), /value="UTC"/);
  assert.match(inputTag(enCard.html, 'field-quietEnabled'), /\bchecked=""/);
  assert.doesNotMatch(enCard.html, /静默时段/);
});

test('开关和合法窗口都交给静默时段接口 [AC:delivery-quiet-hours#AC-7]', async () => {
  const card = loadCard({
    messages: zh,
    settings: savedSettings,
    draft: { startHour: '23', endHour: '8', timezone: 'Asia/Shanghai' }
  });
  assert.equal(card.toggle !== undefined, true);
  card.toggle?.(true);
  card.save?.();
  await Promise.resolve();
  assert.deepEqual(card.saves, [
    { path: '/api/delivery/quiet-hours', patch: { enabled: true } },
    { path: '/api/delivery/quiet-hours', patch: { startHour: 23 } }
  ]);
});

test('卡片上的非法小时和空白时区不会提交 [AC:delivery-quiet-hours#AC-8]', async () => {
  const card = loadCard({
    messages: zh,
    settings: savedSettings,
    draft: { startHour: '99', endHour: '8', timezone: '  ' }
  });
  card.save?.();
  await Promise.resolve();
  assert.deepEqual(card.saves, []);
  assert.match(card.state.errors?.startHour ?? '', /0/);
  assert.match(card.state.errors?.startHour ?? '', /23/);
  assert.equal(card.state.errors?.timezone, '请填写时区');
});

test('读不到静默时段时提示失败且不展示假窗口 [AC:delivery-quiet-hours#AC-9]', () => {
  const card = loadCard({ messages: zh, settings: null, loadError: 'offline' });
  assert.match(card.html, /设置加载失败：offline/);
  assert.match(card.html, /重试/);
  assert.doesNotMatch(card.html, /field-quietStart/);
  assert.doesNotMatch(card.html, /Asia\/Shanghai/);
  card.retry?.();
  assert.equal(card.state.reloads, 1);
});
