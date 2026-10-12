import test from 'node:test';
import assert from 'node:assert/strict';
import { loginFailureLocksLab, loginRequiredEventLocksLab } from './api.ts';

test('draft release with login off does not lock the Lab', () => {
  assert.equal(loginFailureLocksLab(403, { error: 'human_login_required', loginRequired: false }), false);
  assert.equal(loginFailureLocksLab(401, { error: 'login_required', loginRequired: false }), false);
  assert.equal(loginRequiredEventLocksLab({ loginRequired: false }), false);
});

test('a missing session still locks the Lab when login is on', () => {
  assert.equal(loginFailureLocksLab(401, { error: 'login_required', loginRequired: true }), true);
  assert.equal(loginFailureLocksLab(401, { error: 'login_required' }), true);
  assert.equal(loginRequiredEventLocksLab(undefined), true);
  assert.equal(loginRequiredEventLocksLab({ loginRequired: true }), true);
});
