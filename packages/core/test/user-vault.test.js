import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorySecretVault,
  createMemoryUserVault,
  fillByReferences,
  assertModelFacingHasNoUserVaultSecrets,
  makeUserVaultFillRef,
  parseUserVaultFillRef,
  isUserVaultFillRef,
  USER_VAULT_KEY,
  SECRET_VAULT_KEY
} from '../dist/secrets/index.js';

test('secret-vault role unchanged: env-name injection, list never leaks values [AC:user-vault-ref-fill#AC-1]', () => {
  assert.notEqual(SECRET_VAULT_KEY, USER_VAULT_KEY);
  const vault = createMemorySecretVault();
  vault.set('CONNECTOR_TOKEN', 'env-secret-value');
  const injected = vault.resolveNamed(['CONNECTOR_TOKEN']);
  assert.equal(injected.CONNECTOR_TOKEN, 'env-secret-value');
  assert.ok(!JSON.stringify(vault.list()).includes('env-secret-value'));
});

test('user-vault types distinct: login/card/contact summaries expose fill refs not secrets [AC:user-vault-ref-fill#AC-2]', () => {
  const vault = createMemoryUserVault();
  const login = vault.upsertLogin({
    label: 'GitHub',
    username: 'lei',
    password: 'p@ss-NEVER-IN-MODEL',
    sites: ['https://github.com']
  });
  const card = vault.upsertCard({
    label: 'Travel',
    holderName: 'Lei Peng',
    expiry: '12/30',
    number: '4111111111111111',
    cvv: '123'
  });
  const contact = vault.upsertContact({
    label: 'Me',
    email: 'me@example.com',
    phone: '+86-100'
  });

  assert.equal(login.kind, 'login');
  assert.equal(card.kind, 'card');
  assert.equal(contact.kind, 'contact');
  assert.ok(isUserVaultFillRef(login.fillRefs.password));
  assert.ok(isUserVaultFillRef(card.fillRefs.cardNumber));
  assert.ok(isUserVaultFillRef(card.fillRefs.cvv));
  assert.equal(card.card.last4, '1111');

  const listed = JSON.stringify(vault.list());
  assert.ok(!listed.includes('p@ss-NEVER-IN-MODEL'));
  assert.ok(!listed.includes('4111111111111111'));
  assert.ok(!listed.includes('"123"') && !listed.includes(':123'));
  assert.ok(listed.includes('uvref:'));
  assert.ok(listed.includes('me@example.com'));
});

test('fill-by-ref resolves for forms but model report never contains raw secrets [AC:user-vault-ref-fill#AC-3]', async () => {
  const vault = createMemoryUserVault();
  const login = vault.upsertLogin({ label: 'Bank', username: 'lei', password: 'SuperSecretPw99!' });
  const card = vault.upsertCard({
    label: 'Visa',
    number: '5555555555554444',
    cvv: '999',
    holderName: 'Lei',
    expiry: '01/29'
  });
  const pwRef = login.fillRefs.password;
  const numRef = card.fillRefs.cardNumber;
  const cvvRef = card.fillRefs.cvv;
  assert.ok(pwRef && numRef && cvvRef);

  const typed = [];
  const outcome = await fillByReferences(vault, [pwRef, numRef, cvvRef], async (resolved) => {
    typed.push(resolved[pwRef], resolved[numRef], resolved[cvvRef]);
    return { typed: typed.length };
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(typed, ['SuperSecretPw99!', '5555555555554444', '999']);
  assert.equal(outcome.modelReport.filled, 3);
  assert.ok(outcome.modelReport.text.includes(pwRef));
  assert.ok(!outcome.modelReport.text.includes('SuperSecretPw99!'));
  assert.ok(!outcome.modelReport.text.includes('5555555555554444'));
  assert.ok(!outcome.modelReport.text.includes('999'));
  assertModelFacingHasNoUserVaultSecrets(outcome.modelReport.text, vault);
  assert.throws(() => assertModelFacingHasNoUserVaultSecrets(`leak SuperSecretPw99!`, vault));
});

test('fill refs parse round-trip; invalid ref fails closed', async () => {
  const ref = makeUserVaultFillRef('login_abc', 'password');
  assert.deepEqual(parseUserVaultFillRef(ref), { id: 'login_abc', field: 'password' });
  const vault = createMemoryUserVault();
  const bad = await fillByReferences(vault, ['not-a-ref'], async () => null);
  assert.equal(bad.ok, false);
});
