import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalPreview } from './approval-preview.ts';

test('approval preview preserves actual recipients and content while hiding credential fields [AC:bot-product-p0#AC-4]', () => {
  const preview = approvalPreview({ receiveId: 'project-team', text: 'Actual message', config: { apiKey: 'secret', enabled: true }, authorization: 'Bearer secret' });
  assert.equal(preview.target, 'project-team');
  assert.equal(preview.content, 'Actual message');
  assert.equal(JSON.stringify(preview).includes('secret'), false);
  assert.deepEqual(preview.details.config, { apiKey: '[REDACTED]', enabled: true });
});

test('approval preview does not invent a target or a before value [AC:bot-product-p0#AC-4]', () => {
  const preview = approvalPreview({ patch: { name: 'New name' } });
  assert.equal(preview.target, null);
  assert.equal(preview.content, null);
  assert.deepEqual(preview.details, { patch: { name: 'New name' } });
});
