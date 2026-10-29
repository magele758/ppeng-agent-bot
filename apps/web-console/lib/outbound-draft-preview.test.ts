import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveInit,
  canApproveDraft,
  canSaveDraftText,
  draftActionError,
  draftRevisionOf,
  editInit,
  identityKindKey,
  isDraftEditable,
  OUTBOUND_DRAFT_MAX_TEXT,
  type OutboundIdentityKind
} from './outbound-draft-preview.ts';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';

const KINDS: OutboundIdentityKind[] = [
  'webhook', 'http_post', 'feishu_bot', 'wecom_group_bot', 'slack', 'telegram', 'email', 'feishu_app', 'unknown'
];

test('every identity kind has a zh and en label [AC:outbound-draft-edit-identity#AC-5]', () => {
  for (const kind of KINDS) {
    const leaf = identityKindKey(kind).split('.').slice(1);
    for (const messages of [zh, en]) {
      const value = leaf.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], messages.tasks);
      assert.equal(typeof value, 'string', `${kind} missing`);
    }
  }
});

test('approve is blocked while the editor holds unsaved edits and the body pins the revision [AC:outbound-draft-edit-identity#AC-7]', () => {
  assert.equal(canApproveDraft(true), false);
  assert.equal(canApproveDraft(false), true);

  const draft = { id: 'draft_1', text: 'hello', status: 'pending_approval', revision: 2 };
  const approve = approveInit(draft);
  assert.equal(approve.method, 'POST');
  assert.deepEqual(JSON.parse(String(approve.body)), { revision: 2 });
  assert.deepEqual(JSON.parse(String(approveInit({ ...draft, revision: undefined }).body)), { revision: 0 });

  const edit = editInit(draft, 'changed');
  assert.equal(edit.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(edit.body)), { text: 'changed', revision: 2 });
  assert.equal(draftRevisionOf({}), 0);
});

test('save needs non-empty, changed, bounded text; only pending or failed drafts are editable [AC:outbound-draft-edit-identity#AC-4]', () => {
  const draft = { text: 'hello' };
  assert.equal(canSaveDraftText(draft, 'hello'), false);
  assert.equal(canSaveDraftText(draft, '   '), false);
  assert.equal(canSaveDraftText(draft, 'x'.repeat(OUTBOUND_DRAFT_MAX_TEXT + 1)), false);
  assert.equal(canSaveDraftText(draft, 'hello!'), true);
  for (const status of ['pending_approval', 'failed']) assert.equal(isDraftEditable(status), true);
  for (const status of ['confirmed', 'sending', 'sent', 'rejected']) assert.equal(isDraftEditable(status), false);
});

test('login-off 403 is told apart from other failures', () => {
  assert.deepEqual(draftActionError(new Error('human_login_required')), { loginRequired: true, message: 'human_login_required' });
  assert.deepEqual(draftActionError(new Error('boom')), { loginRequired: false, message: 'boom' });
  assert.deepEqual(draftActionError('plain'), { loginRequired: false, message: 'plain' });
});
