import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorySecretVault,
  createMemoryUserVault,
  UserVault,
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
  // Refs embed random ids that can contain '999' by chance; scan the prose with refs masked.
  const prose = outcome.modelReport.refs.reduce((out, ref) => out.split(ref).join('<ref>'), outcome.modelReport.text);
  assert.ok(!prose.includes('SuperSecretPw99!'));
  assert.ok(!prose.includes('5555555555554444'));
  assert.ok(!prose.includes('999'));
  assertModelFacingHasNoUserVaultSecrets(outcome.modelReport.text, vault);
  assert.throws(() => assertModelFacingHasNoUserVaultSecrets(`leak SuperSecretPw99!`, vault));
});

test('fill-by-ref succeeds when an opaque ref id happens to contain a short secret [AC:user-vault-ref-fill#AC-3]', async () => {
  const vault = createMemoryUserVault();
  const card = vault.upsertCard({
    id: 'card_a999b',
    label: 'Visa',
    number: '5555555555554444',
    cvv: '999',
    holderName: 'Lei',
    expiry: '01/29'
  });
  const cvvRef = card.fillRefs.cvv;
  assert.ok(cvvRef?.includes('999'));
  const outcome = await fillByReferences(vault, [cvvRef], async () => 'ok');
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.modelReport.text.includes(cvvRef));
});

test('fill refs parse round-trip; invalid ref fails closed', async () => {
  const ref = makeUserVaultFillRef('login_abc', 'password');
  assert.deepEqual(parseUserVaultFillRef(ref), { id: 'login_abc', field: 'password' });
  const vault = createMemoryUserVault();
  const bad = await fillByReferences(vault, ['not-a-ref'], async () => null);
  assert.equal(bad.ok, false);
});

test('resolveFillReference resolves every field kind and fails closed otherwise', () => {
  const vault = createMemoryUserVault();
  const login = vault.upsertLogin({ label: 'L', username: 'lei', password: 'pw-1' });
  const bare = vault.upsertLogin({ label: 'NoPw', username: 'x' });
  const card = vault.upsertCard({ label: 'C', holderName: 'Lei', expiry: '01/29', number: '4242424242424242', cvv: '321' });
  const contact = vault.upsertContact({ label: 'K', fullName: 'Lei P', email: 'a@b.c', phone: '1', address: 'Addr' });
  const r = (id, field) => vault.resolveFillReference(makeUserVaultFillRef(id, field));

  assert.equal(r(login.id, 'username'), 'lei');
  assert.equal(r(login.id, 'password'), 'pw-1');
  assert.equal(r(login.id, 'cvv'), undefined);
  assert.equal(r(bare.id, 'password'), undefined);
  assert.equal(r(card.id, 'holderName'), 'Lei');
  assert.equal(r(card.id, 'expiry'), '01/29');
  assert.equal(r(card.id, 'cardNumber'), '4242424242424242');
  assert.equal(r(card.id, 'cvv'), '321');
  assert.equal(r(card.id, 'email'), undefined);
  assert.equal(r(contact.id, 'fullName'), 'Lei P');
  assert.equal(r(contact.id, 'email'), 'a@b.c');
  assert.equal(r(contact.id, 'phone'), '1');
  assert.equal(r(contact.id, 'address'), 'Addr');
  assert.equal(r(contact.id, 'password'), undefined);
  assert.equal(r('missing', 'password'), undefined);
  assert.equal(vault.resolveFillReference('not-a-ref'), undefined);
});

test('resolveFillReference returns undefined when ciphertext cannot be decrypted', () => {
  const kv = new Map();
  const store = {
    getDaemonControl: (k) => kv.get(k),
    setDaemonControl: (k, v) => kv.set(k, structuredClone(v))
  };
  const first = new UserVault(store);
  const login = first.upsertLogin({ label: 'L', password: 'pw' });
  const card = first.upsertCard({ label: 'C', number: '4242424242424242', cvv: '321' });
  const saved = kv.get(USER_VAULT_KEY);
  saved.keyHex = '11'.repeat(32);
  kv.set(USER_VAULT_KEY, saved);
  const second = new UserVault(store);
  for (const [id, field] of [[login.id, 'password'], [card.id, 'cardNumber'], [card.id, 'cvv']]) {
    assert.equal(second.resolveFillReference(makeUserVaultFillRef(id, field)), undefined);
  }
});
