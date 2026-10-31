import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryUserVault } from '../dist/secrets/user-vault.js';
import { createSecureFormPort, secureFormTextLeaks } from '../dist/secrets/secure-form.js';

const PASSWORD = 'hunter2';
const CVV = '123';

function memoryStore() {
  const rows = new Map();
  return {
    getDaemonControl(key) {
      return rows.get(key);
    },
    setDaemonControl(key, value) {
      rows.set(key, value);
    }
  };
}

test('multi-field card opens multiple masked fields and the receipt has no secrets [AC:secure-form-multi#AC-1]', () => {
  const port = createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() });
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'password', label: 'Username' },
      { field: 'password', label: 'Password' }
    ]
  });
  assert.equal(opened.card.kind, 'secure_form');
  assert.equal(opened.card.masked, true);
  assert.equal(opened.card.status, 'pending');
  assert.ok(Array.isArray(opened.card.fields));
  assert.equal(opened.card.fields.length, 2);
  assert.equal(opened.card.fields[0].field, 'password');
  assert.equal(opened.card.fields[0].label, 'Username');
  assert.equal(opened.card.fields[1].field, 'password');
  assert.equal(opened.card.fields[1].label, 'Password');
  assert.equal(opened.receipt.status, 'pending');
  assert.equal('value' in opened.card, false);
  assert.equal(secureFormTextLeaks(JSON.stringify(opened), PASSWORD), false);
});

test('multi-field submit stores all fields in UserVault and returns multiple uvrefs [AC:secure-form-multi#AC-2]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'cardNumber' },
      { field: 'cvv' }
    ]
  });
  const done = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    values: { cardNumber: '4111111111111111', cvv: CVV }
  });
  assert.equal(done.status, 'filled');
  assert.ok(Array.isArray(done.fields));
  assert.equal(done.fields.length, 2);
  assert.match(done.fields[0].fillRef, /^uvref:sf_/);
  assert.match(done.fields[1].fillRef, /^uvref:sf_/);
  assert.match(done.text, /filled with 2 field/);
  assert.equal(secureFormTextLeaks(JSON.stringify(done), '4111111111111111'), false);
  assert.equal(secureFormTextLeaks(JSON.stringify(done), CVV), false);
  assert.equal(secureFormTextLeaks(done.text, CVV), false);

  // Verify refs work
  const cardNumRef = done.fields.find((f) => f.field === 'cardNumber')?.fillRef;
  const cvvRef = done.fields.find((f) => f.field === 'cvv')?.fillRef;
  assert.ok(cardNumRef);
  assert.ok(cvvRef);
  assert.equal(vault.resolveFillReference(cardNumRef), '4111111111111111');
  assert.equal(vault.resolveFillReference(cvvRef), CVV);
});

test('single-field backward compat still works [AC:secure-form-multi#AC-3]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({ sessionId: 's1', field: 'otp', label: 'Bank OTP' });
  assert.equal(opened.card.kind, 'secure_form');
  assert.equal(opened.card.field, 'otp');
  assert.equal(opened.card.label, 'Bank OTP');
  assert.equal(opened.card.masked, true);
  assert.equal(opened.card.status, 'pending');

  const done = port.submit({ sessionId: 's1', id: opened.card.id, value: '918273' });
  assert.equal(done.status, 'filled');
  assert.equal(done.field, 'otp');
  assert.match(done.fillRef, /^uvref:sf_/);
  assert.equal(secureFormTextLeaks(JSON.stringify(done), '918273'), false);
});

test('multi-field cancel stores nothing and reports cancelled [AC:secure-form-multi#AC-4]', () => {
  const port = createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() });
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'password' },
      { field: 'password' }
    ]
  });
  const done = port.cancel({ sessionId: 's1', id: opened.card.id });
  assert.equal(done.status, 'cancelled');
  assert.match(done.text, /cancelled/);
  assert.equal('fillRef' in done, false);
  assert.equal(done.fields === undefined || done.fields.length === 0, true);
});

test('multi-field submit rejects empty fields [AC:secure-form-multi#AC-5]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'password' },
      { field: 'cvv' }
    ]
  });
  assert.throws(() => {
    port.submit({
      sessionId: 's1',
      id: opened.card.id,
      values: { password: 'hunter2' }
      // missing cvv
    });
  }, /value for field cvv is required/);
});

test('multi-field request rejects unknown field names [AC:secure-form-multi#AC-6]', () => {
  const port = createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() });
  assert.throws(() => {
    port.request({
      sessionId: 's1',
      fields: [{ field: 'invalidField' }]
    });
  }, /field must be one of/);
});

test('multi-field request rejects empty fields array [AC:secure-form-multi#AC-7]', () => {
  const port = createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() });
  assert.throws(() => {
    port.request({
      sessionId: 's1',
      fields: []
    });
  }, /fields array must not be empty/);
});

test('assertModelFacingHasNoUserVaultSecrets passes for multi-field receipt [AC:secure-form-multi#AC-8]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({
    sessionId: 's1',
    fields: [
      { field: 'password' },
      { field: 'password' }
    ]
  });
  const done = port.submit({
    sessionId: 's1',
    id: opened.card.id,
    values: { password: 'secret1', cvv: 'secret2' }
  });
  // assertModelFacingHasNoUserVaultSecrets is called inside submit
  // If it throws, submit would have failed
  assert.equal(done.status, 'filled');
  assert.equal(JSON.stringify(done).includes('secret1'), false);
  assert.equal(JSON.stringify(done).includes('secret2'), false);
});
