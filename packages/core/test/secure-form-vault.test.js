import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryUserVault } from '../dist/secrets/user-vault.js';
import { createSecureFormPort } from '../dist/secrets/secure-form.js';

function memoryStore() {
  const map = new Map();
  return {
    getDaemonControl: (key) => map.get(key),
    setDaemonControl: (key, value) => map.set(key, value)
  };
}

test('single-field secure form can fill from vault login entry [AC:secure-form-vault#AC-1]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  // Create a login entry in vault
  const login = vault.upsertLogin({ label: 'Bank App', username: 'alice', password: 'secret123' });

  // Request a password form
  const opened = port.request({ sessionId: 's1', field: 'password', label: 'Bank Password' });
  assert.equal(opened.card.kind, 'secure_form');
  assert.equal(opened.card.field, 'password');

  // Submit using vaultEntryId instead of typing value
  const done = port.submit({ sessionId: 's1', id: opened.card.id, vaultEntryId: login.id });

  assert.equal(done.status, 'filled');
  assert.ok(done.fillRef);
  assert.match(done.fillRef, /^uvref:/);
  assert.match(done.fillRef, new RegExp(`:${login.id}:password$`));
  assert.equal(done.text.includes('secret123'), false); // No plaintext leak
});

test('single-field secure form can fill username from vault login [AC:secure-form-vault#AC-2]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const login = vault.upsertLogin({ label: 'GitHub', username: 'bob', password: 'pass456' });

  const opened = port.request({ sessionId: 's2', field: 'username', label: 'GitHub Username' });
  const done = port.submit({ sessionId: 's2', id: opened.card.id, vaultEntryId: login.id });

  assert.equal(done.status, 'filled');
  assert.ok(done.fillRef);
  assert.match(done.fillRef, new RegExp(`:${login.id}:username$`));
  assert.equal(done.text.includes('bob'), false);
});

test('single-field secure form can fill from vault card entry [AC:secure-form-vault#AC-3]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const card = vault.upsertCard({ label: 'Visa', number: '4111111111111111', cvv: '123' });

  const opened = port.request({ sessionId: 's3', field: 'cardNumber', label: 'Card Number' });
  const done = port.submit({ sessionId: 's3', id: opened.card.id, vaultEntryId: card.id });

  assert.equal(done.status, 'filled');
  assert.ok(done.fillRef);
  assert.match(done.fillRef, new RegExp(`:${card.id}:cardNumber$`));
  assert.equal(done.text.includes('4111'), false);
});

test('multi-field secure form can fill from vault login [AC:secure-form-vault#AC-4]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const login = vault.upsertLogin({ label: 'Admin Panel', username: 'admin', password: 'admin123' });

  const opened = port.request({
    sessionId: 's4',
    fields: [
      { field: 'username', label: 'Username' },
      { field: 'password', label: 'Password' }
    ]
  });

  const done = port.submit({ sessionId: 's4', id: opened.card.id, vaultEntryId: login.id });

  assert.equal(done.status, 'filled');
  assert.ok(done.fields);
  assert.equal(done.fields.length, 2);

  const usernameFill = done.fields.find((f) => f.field === 'username');
  const passwordFill = done.fields.find((f) => f.field === 'password');

  assert.ok(usernameFill);
  assert.ok(usernameFill.fillRef);
  assert.match(usernameFill.fillRef, new RegExp(`:${login.id}:username$`));

  assert.ok(passwordFill);
  assert.ok(passwordFill.fillRef);
  assert.match(passwordFill.fillRef, new RegExp(`:${login.id}:password$`));

  assert.equal(done.text.includes('admin'), false);
  assert.equal(done.text.includes('admin123'), false);
});

test('multi-field secure form can fill card fields from vault [AC:secure-form-vault#AC-5]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const card = vault.upsertCard({ label: 'MasterCard', number: '5555555555554444', cvv: '456' });

  const opened = port.request({
    sessionId: 's5',
    fields: [
      { field: 'cardNumber', label: 'Card Number' },
      { field: 'cvv', label: 'CVV' }
    ]
  });

  const done = port.submit({ sessionId: 's5', id: opened.card.id, vaultEntryId: card.id });

  assert.equal(done.status, 'filled');
  assert.equal(done.fields.length, 2);

  const numberFill = done.fields.find((f) => f.field === 'cardNumber');
  const cvvFill = done.fields.find((f) => f.field === 'cvv');

  assert.ok(numberFill);
  assert.match(numberFill.fillRef, new RegExp(`:${card.id}:cardNumber$`));

  assert.ok(cvvFill);
  assert.match(cvvFill.fillRef, new RegExp(`:${card.id}:cvv$`));

  assert.equal(done.text.includes('5555'), false);
  assert.equal(done.text.includes('456'), false);
});

test('vaultEntryId submission rejects non-existent entry [AC:secure-form-vault#AC-6]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const opened = port.request({ sessionId: 's6', field: 'password' });

  assert.throws(
    () => port.submit({ sessionId: 's6', id: opened.card.id, vaultEntryId: 'nonexistent_id' }),
    /vault entry nonexistent_id not found/
  );
});

test('vaultEntryId submission rejects incompatible field types [AC:secure-form-vault#AC-7]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  // Create a card entry
  const card = vault.upsertCard({ label: 'Amex', number: '378282246310005' });

  // Try to fill a username field from card (incompatible)
  const opened = port.request({ sessionId: 's7', field: 'username' });

  assert.throws(
    () => port.submit({ sessionId: 's7', id: opened.card.id, vaultEntryId: card.id }),
    /field username not available in card entry/
  );
});

test('legacy value submission still works alongside vaultEntryId [AC:secure-form-vault#AC-8]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const opened = port.request({ sessionId: 's8', field: 'otp' });

  // Submit with legacy value path (not vaultEntryId)
  const done = port.submit({ sessionId: 's8', id: opened.card.id, value: '123456' });

  assert.equal(done.status, 'filled');
  assert.ok(done.fillRef);
  assert.match(done.fillRef, /^uvref:/);
  // The value was stored in a new vault entry
  const entries = vault.list();
  assert.ok(entries.length > 0);
});

test('legacy multi-field values submission still works [AC:secure-form-vault#AC-9]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const opened = port.request({
    sessionId: 's9',
    fields: [
      { field: 'username', label: 'User' },
      { field: 'password', label: 'Pass' }
    ]
  });

  // Submit with legacy values (not vaultEntryId)
  const done = port.submit({
    sessionId: 's9',
    id: opened.card.id,
    values: { username: 'testuser', password: 'testpass' }
  });

  assert.equal(done.status, 'filled');
  assert.equal(done.fields.length, 2);
  assert.ok(done.fields.every((f) => f.fillRef));
});

test('otp field maps to password in vault login [AC:secure-form-vault#AC-10]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });

  const login = vault.upsertLogin({ label: 'Bank OTP', password: '654321' });

  const opened = port.request({ sessionId: 's10', field: 'otp', label: 'One-Time Code' });
  const done = port.submit({ sessionId: 's10', id: opened.card.id, vaultEntryId: login.id });

  assert.equal(done.status, 'filled');
  assert.ok(done.fillRef);
  // otp maps to password field in vault
  assert.match(done.fillRef, new RegExp(`:${login.id}:password$`));
});
