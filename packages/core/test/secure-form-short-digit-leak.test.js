import test from 'node:test';
import assert from 'node:assert/strict';
import { secureFormTextLeaks } from '../dist/secrets/secure-form.js';

const CVV = '918';
const CARD = '4111111111111111';
const PASSWORD = 'http-vault-PASSWORD-sentinel';

test('short digit secret inside an id or timestamp is not a leak [AC:secure-form-short-digit-leak#AC-1]', () => {
  assert.equal(secureFormTextLeaks(`sform_${'a'.repeat(8)}918${'b'.repeat(8)}`, CVV), false);
  assert.equal(secureFormTextLeaks('2026-11-10T01:22:44.918Z', CVV), false);
  assert.equal(secureFormTextLeaks('1739180000000', CVV), false);
  assert.equal(secureFormTextLeaks(`sform_${'a'.repeat(8)}918273${'b'.repeat(8)}`, '918273'), false);
});

test('short digit secret as its own value is still a leak [AC:secure-form-short-digit-leak#AC-2]', () => {
  assert.equal(secureFormTextLeaks(JSON.stringify({ cvv: CVV }), CVV), true);
  assert.equal(secureFormTextLeaks('{"cvv":918}', CVV), true);
  assert.equal(secureFormTextLeaks('value is 918.', CVV), true);
});

test('card number and longer password still leak anywhere in the text [AC:secure-form-short-digit-leak#AC-3]', () => {
  assert.equal(secureFormTextLeaks(`xx${CARD}yy`, CARD), true);
  assert.equal(secureFormTextLeaks(`token-${PASSWORD}-token`, PASSWORD), true);
  assert.equal(secureFormTextLeaks('xx1234567yy', '1234567'), true);
  assert.equal(secureFormTextLeaks('filled. Values not included.', CARD), false);
  assert.equal(secureFormTextLeaks('filled. Values not included.', PASSWORD), false);
});
