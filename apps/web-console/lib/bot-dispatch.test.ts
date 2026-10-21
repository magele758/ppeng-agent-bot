import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotDispatchIdentity } from './bot-dispatch.ts';

test('uncertain submissions keep their key, while edited and confirmed work get new keys [AC:bot-product-p0#AC-1]', () => {
  let sequence = 0;
  const identity = createBotDispatchIdentity(() => `request-${++sequence}`);
  const first = identity.forInput('bot-a', 'once');
  assert.equal(identity.forInput('bot-a', 'once'), first);
  assert.notEqual(identity.forInput('bot-b', 'once'), first);
  const changed = identity.forInput('bot-b', 'revised');
  assert.equal(identity.forInput('bot-b', 'revised'), changed);
  identity.accepted();
  assert.notEqual(identity.forInput('bot-b', 'revised'), changed);
});
