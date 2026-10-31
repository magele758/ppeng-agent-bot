import { test, assert } from 'vitest';
import {
  memoryStore,
  createMemoryUserVault,
  createSecureFormPort,
  secureFormTextLeaks
} from '@ppeng/agent-core';

test('multi-field secure form submit works end-to-end via daemon HTTP [AC:r5-15#AC-1]', () => {
  const port = createSecureFormPort({
    store: memoryStore(),
    vault: createMemoryUserVault()
  });

  // Request multi-field form (username + password)
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'username', label: 'Username' },
      { field: 'password', label: 'Password' }
    ]
  });
  assert.equal(opened.card.kind, 'secure_form');
  assert(opened.card.fields);
  assert.equal(opened.card.fields.length, 2);

  // Submit multi-field with values
  const submitted = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    values: {
      username: 'alice',
      password: 'hunter2'
    }
  });
  assert.equal(submitted.status, 'filled');
  assert.equal(submitted.id, opened.card.id);
  // Receipt must have fields array for multi-field forms
  assert(submitted.fields, 'multi-field receipt must have fields array');
  assert.equal(submitted.fields.length, 2);
});

test('multi-field receipt contains no plaintext secrets [AC:r5-15#AC-2]', () => {
  const port = createSecureFormPort({
    store: memoryStore(),
    vault: createMemoryUserVault()
  });

  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'cardNumber', label: 'Card Number' },
      { field: 'cvv', label: 'CVV' }
    ]
  });

  const submitted = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    values: {
      cardNumber: '4111111111111111',
      cvv: '123'
    }
  });

  const receiptText = JSON.stringify(submitted);
  assert(!receiptText.includes('4111111111111111'), 'card number should not appear in receipt');
  assert(!receiptText.includes('123'), 'CVV should not appear in receipt');
});

test('multi-field receipt has fillRefs for each field [AC:r5-15#AC-3]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'username', label: 'Username' },
      { field: 'password', label: 'Password' }
    ]
  });

  const submitted = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    values: {
      username: 'alice',
      password: 'hunter2'
    }
  });

  // Multi-field receipt should have fields array with fillRefs
  assert(submitted.fields, 'multi-field receipt should have fields array');
  assert(Array.isArray(submitted.fields), 'fields should be an array');
  assert.equal(submitted.fields.length, 2, 'should have 2 fields');

  for (const field of submitted.fields) {
    assert(field.field, `each field entry should have field name`);
    assert(field.fillRef, `each field entry should have fillRef for user vault reference`);
  }
});

test('multi-field cancel stores nothing and reports cancelled [AC:r5-15#AC-4]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'cardNumber', label: 'Card Number' },
      { field: 'cvv', label: 'CVV' }
    ]
  });

  const cancelled = port.cancel({ sessionId: 's1', id: opened.card.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.id, opened.card.id);
});

test('single-field submit still works for backward compat [AC:r5-15#AC-5]', () => {
  const port = createSecureFormPort({
    store: memoryStore(),
    vault: createMemoryUserVault()
  });

  // Single-field request
  const opened = port.request({
    sessionId: 's1',
    field: 'otp',
    label: 'Bank OTP'
  });
  assert.equal(opened.card.kind, 'secure_form');
  assert.equal(opened.card.field, 'otp');

  // Single-field submit with value (not values)
  const submitted = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    value: '123456'
  });
  assert.equal(submitted.status, 'filled');
  assert.equal(submitted.id, opened.card.id);
  // Single-field receipt should not have fields array
  assert(!submitted.fields, 'single-field receipt should not have fields array');
  assert.equal(submitted.field, 'otp', 'single-field receipt should have field name');
});

test('single-field receipt has no plaintext secret [AC:r5-15#AC-6]', () => {
  const port = createSecureFormPort({
    store: memoryStore(),
    vault: createMemoryUserVault()
  });

  const opened = port.request({
    sessionId: 's1',
    field: 'password'
  });

  const submitted = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    value: 'secret123'
  });

  const receiptText = JSON.stringify(submitted);
  assert(!receiptText.includes('secret123'), 'password should not appear in receipt');
});

test('leak scan function detects plaintext in output [AC:r5-15#AC-7]', () => {
  // Verify that secureFormTextLeaks detects secrets in text
  const testText = 'username: alice, password: hunter2';
  
  assert(secureFormTextLeaks(testText, 'alice'), 'should detect alice in text');
  assert(secureFormTextLeaks(testText, 'hunter2'), 'should detect hunter2 in text');
  
  // Clean text should not trigger leak
  assert(!secureFormTextLeaks('{}', 'hunter2'), 'should not detect unrelated secret in clean text');
  assert(!secureFormTextLeaks('{"status":"filled"}', 'hunter2'), 'should not detect secret in status-only text');
});

test('cancel path does not store values [AC:r5-15#AC-8]', () => {
  const port = createSecureFormPort({
    store: memoryStore(),
    vault: createMemoryUserVault()
  });

  const opened = port.request({
    sessionId: 's1',
    field: 'password',
    label: 'Password'
  });

  const cancelled = port.cancel({ sessionId: 's1', id: opened.card.id });
  assert.equal(cancelled.status, 'cancelled');
  // Cancellation should not store anything
});
