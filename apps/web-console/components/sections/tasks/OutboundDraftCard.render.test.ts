import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { translate } from '../../../lib/i18n/t.ts';
import { zh } from '../../../lib/i18n/messages/zh/index.ts';

const localRequire = createRequire(import.meta.url);

function load(): Record<string, any> {
  const source = readFileSync(new URL('./OutboundDraftCard.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  const req = (id: string) => {
    if (id.endsWith('.css')) return {};
    if (id === '@/lib/i18n') return { useI18n: () => ({ t: (key: string, vars?: Record<string, string>) => translate(zh, key, vars) }) };
    if (id === '@/lib/outbound-draft-preview') return localRequire('../../../lib/outbound-draft-preview.ts');
    return localRequire(id);
  };
  new Function('require', 'module', 'exports', compiled)(req, mod, mod.exports);
  return mod.exports;
}

const { OutboundDraftCard, OutboundDraftActions, OutboundDraftBody, OutboundIdentityBar } = load();
const noop = () => undefined;

const draft = {
  id: 'draft_1',
  channelId: 'out',
  text: 'hello team',
  status: 'pending_approval',
  createdAt: '2026-10-29T00:00:00Z',
  identity: { channelId: 'out', kind: 'slack', resolved: true, sender: 'env:SLACK_BOT_TOKEN', recipient: 'C123' }
};

test('card shows the identity bar, the text, an Edit button, and a still-required approve [AC:outbound-draft-edit-identity#AC-5] [AC:outbound-draft-edit-identity#AC-7]', () => {
  const html = renderToStaticMarkup(
    React.createElement(OutboundDraftCard, { draft, onSave: async () => true, onApprove: noop, onReject: noop })
  );
  assert.match(html, /data-testid="outbound-identity"/);
  assert.match(html, /发送身份/);
  assert.match(html, /Slack/);
  assert.match(html, /env:SLACK_BOT_TOKEN/);
  assert.match(html, /C123/);
  assert.match(html, /hello team/);
  assert.match(html, /编辑/);
  assert.match(html, /批准并发送/);
  assert.doesNotMatch(html, /<textarea/);
  assert.doesNotMatch(html, /现在发不出去/);
});

test('identity bar flags an unsendable draft and tolerates a missing sender [AC:outbound-draft-edit-identity#AC-5]', () => {
  const html = renderToStaticMarkup(
    React.createElement(OutboundIdentityBar, { identity: { channelId: 'x', kind: 'unknown', resolved: false } })
  );
  assert.match(html, /data-resolved="false"/);
  assert.match(html, /未知渠道/);
  assert.match(html, /未识别发送账号/);
  assert.match(html, /现在发不出去/);
});

test('while editing, the textarea shows and Approve is disabled until saved [AC:outbound-draft-edit-identity#AC-7]', () => {
  const body = renderToStaticMarkup(
    React.createElement(OutboundDraftBody, { draft, editing: true, value: 'edited text', onChange: noop })
  );
  assert.match(body, /<textarea/);
  assert.match(body, /edited text/);
  assert.match(body, /保存或放弃修改后才能批准并发送/);

  const actions = renderToStaticMarkup(
    React.createElement(OutboundDraftActions, {
      draft, editing: true, canSave: true, onEdit: noop, onSave: noop, onCancel: noop, onApprove: noop, onReject: noop
    })
  );
  assert.match(actions, /<button[^>]*disabled=""[^>]*aria-label="批准并发送 out"|aria-label="批准并发送 out"[^>]*disabled=""/);
  assert.match(actions, /保存修改/);
  assert.match(actions, /放弃修改/);
  assert.doesNotMatch(actions, />编辑</);
});

test('edited drafts say so, and sending drafts expose no actions [AC:outbound-draft-edit-identity#AC-1]', () => {
  const edited = { ...draft, revision: 1, originalText: 'old' };
  const body = renderToStaticMarkup(
    React.createElement(OutboundDraftBody, { draft: edited, editing: false, value: '', onChange: noop })
  );
  assert.match(body, /原文已保留/);
  const sending = renderToStaticMarkup(
    React.createElement(OutboundDraftActions, {
      draft: { ...draft, status: 'sending' }, editing: false, canSave: false,
      onEdit: noop, onSave: noop, onCancel: noop, onApprove: noop, onReject: noop
    })
  );
  assert.equal(sending, '');
  const failed = renderToStaticMarkup(
    React.createElement(OutboundDraftActions, {
      draft: { ...draft, status: 'failed' }, editing: false, canSave: false,
      onEdit: noop, onSave: noop, onCancel: noop, onApprove: noop, onReject: noop
    })
  );
  assert.match(failed, /编辑/);
  assert.doesNotMatch(failed, /disabled/);
});
