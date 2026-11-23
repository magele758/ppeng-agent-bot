import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemorySecretVault,
  assertWritableEnvName,
  runWithSecretRefs,
  currentSecretOverrides,
  isReservedEnvName
} from '../dist/secrets/index.js';

test('vault resolveNamed only injects requested names', () => {
  const vault = createMemorySecretVault();
  vault.set('FOO_TOKEN', 'secret-foo');
  vault.set('BAR_TOKEN', 'secret-bar');
  const injected = vault.resolveNamed(['FOO_TOKEN']);
  assert.equal(injected.FOO_TOKEN, 'secret-foo');
  assert.equal(injected.BAR_TOKEN, undefined);
  assert.deepEqual(vault.list().map((e) => e.name).sort(), ['BAR_TOKEN', 'FOO_TOKEN']);
  assert.ok(!JSON.stringify(vault.list()).includes('secret-foo'));
});

test('vault rejects reserved names; ALS only exposes referenced values', async () => {
  assert.equal(isReservedEnvName('PATH'), true);
  assert.throws(() => assertWritableEnvName('PATH'));
  const vault = createMemorySecretVault();
  vault.set('MY_KEY', 'abc');
  await runWithSecretRefs(vault.resolveNamed(['MY_KEY']), async () => {
    assert.equal(currentSecretOverrides().MY_KEY, 'abc');
    assert.equal(currentSecretOverrides().PATH, undefined);
  });
  assert.deepEqual(currentSecretOverrides(), {});
});

test('vault snapshotValues exposes active secrets for redaction without leaking via list()', () => {
  const vault = createMemorySecretVault();
  const brokerTok = 'pw1_broker_tok_AbC+Def/123';
  vault.set('PW1_BROKER_TOKEN', brokerTok);
  assert.deepEqual(vault.snapshotValues(), { PW1_BROKER_TOKEN: brokerTok });
  assert.equal(JSON.stringify(vault.list()).includes(brokerTok), false);
});
