import test from 'node:test';
import assert from 'node:assert/strict';
import { en } from './i18n/messages/en/index.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { translate } from './i18n/t.ts';
import { approvalInboxNote, approvalInboxStatusText } from './approval-inbox.ts';

const expired = {
  status: 'rejected',
  expireReason: 'Denied: nobody answered within 10 minutes of an unattended wake, so the tool was not run.',
  reason: 'Approval required for bash'
};

test('inbox shows an unattended timeout deny in zh and en [AC:unattended-approval-expiry#AC-6]', () => {
  assert.equal(approvalInboxNote(expired), 'expired');
  const zhText = approvalInboxStatusText(expired, (key) => translate(zh, key));
  const enText = approvalInboxStatusText(expired, (key) => translate(en, key));
  assert.match(zhText ?? '', /拒绝/);
  assert.match(zhText ?? '', /10 分钟/);
  assert.match(zhText ?? '', /未执行/);
  assert.match(enText ?? '', /Denied/);
  assert.match(enText ?? '', /10 minutes/);
  assert.match(enText ?? '', /did not run/);
  assert.notEqual(zhText, enText);

  const pending = approvalInboxStatusText(
    { status: 'pending', expiresAt: '2026-10-10T00:10:00.000Z', reason: 'Approval required for bash' },
    (key) => translate(en, key)
  );
  assert.match(pending ?? '', /10 minutes/);
  assert.equal(approvalInboxNote({ status: 'pending', reason: 'human' }), null);
});
