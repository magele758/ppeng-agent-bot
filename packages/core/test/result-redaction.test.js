import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRedactionEnv,
  collectRedactionTargets,
  redactEnvValues,
  redactToolContent,
  REDACT_MIN_VALUE_LENGTH
} from '../dist/sandbox/result-redaction.js';
import {
  bindSecretVault,
  createMemorySecretVault,
  runWithSecretRefs
} from '../dist/secrets/index.js';

test('collectRedactionTargets picks API keys and skips short/exempt', () => {
  const targets = collectRedactionTargets({
    PATH: '/usr/bin',
    RAW_AGENT_API_KEY: 'sk-live-secret-value-12345',
    SHORT: 'abc',
    MY_TOKEN: 'tok_abcdefghijklmnopqrstuvwxyz',
    HARMLESS_FLAG: 'enabled-ok'
  });
  const names = targets.map(([n]) => n);
  assert.ok(names.includes('RAW_AGENT_API_KEY'));
  assert.ok(names.includes('MY_TOKEN'));
  assert.ok(!names.includes('PATH'));
  assert.ok(!names.includes('SHORT'));
  assert.ok(!names.includes('HARMLESS_FLAG'));
});

test('redactEnvValues replaces secret substrings in nested structures [AC:command-hardline#AC-5]', () => {
  const secret = 'super-secret-cookie-value';
  const env = { SHM_SANDBOX_COOKIE: secret, PATH: '/bin' };
  const out = redactEnvValues(
    {
      stdout: `cookie=${secret}`,
      nested: [`pre ${secret} post`, { msg: secret }]
    },
    env
  );
  assert.equal(out.stdout, 'cookie=[REDACTED:SHM_SANDBOX_COOKIE]');
  assert.equal(out.nested[0], 'pre [REDACTED:SHM_SANDBOX_COOKIE] post');
  assert.equal(out.nested[1].msg, '[REDACTED:SHM_SANDBOX_COOKIE]');
});

test('redactEnvValues no-ops when no targets', () => {
  assert.equal(redactEnvValues('hello', { PATH: '/bin' }), 'hello');
});

test('redactToolContent is string convenience', () => {
  const key = 'x'.repeat(REDACT_MIN_VALUE_LENGTH + 2);
  const out = redactToolContent(`leak ${key}`, { RAW_AGENT_API_KEY: key });
  assert.equal(out, 'leak [REDACTED:RAW_AGENT_API_KEY]');
});

test('longer secrets redacted before shorter overlapping ones', () => {
  const long = 'abcdefghijklmnop';
  const short = 'abcdef';
  const out = redactEnvValues(`xx${long}yy`, {
    LONG_SECRET: long,
    SHORT_SECRET: short
  });
  assert.equal(out, 'xx[REDACTED:LONG_SECRET]yy');
});

test('redactEnvValues redacts URL-encoded (%XX/%xx), JSON-escaped, and standard/URL-safe Base64 forms for secrets >= 8 chars', () => {
  const secret = 'AbC+Def/123"??>>';
  const upperPct = encodeURIComponent(secret);
  const lowerPct = upperPct.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const b64Std = Buffer.from(secret, 'utf8').toString('base64');
  const b64Url = Buffer.from(secret, 'utf8').toString('base64url');
  assert.notEqual(b64Std, b64Url, 'fixture should exercise distinct std and url-safe base64');

  const payload = [
    `raw=${secret}`,
    `upper=${upperPct}`,
    `lower=${lowerPct}`,
    `json=${jsonEscaped}`,
    `b64=${b64Std}`,
    `b64u=${b64Url}`
  ].join(' ');

  const out = redactEnvValues(payload, { MIXED_API_KEY: secret });
  for (const variant of [secret, upperPct, lowerPct, jsonEscaped, b64Std, b64Url]) {
    assert.equal(out.includes(variant), false, `variant should be redacted: ${variant}`);
  }
  assert.equal(
    out,
    'raw=[REDACTED:MIXED_API_KEY] upper=[REDACTED:MIXED_API_KEY] lower=[REDACTED:MIXED_API_KEY] json=[REDACTED:MIXED_API_KEY] b64=[REDACTED:MIXED_API_KEY] b64u=[REDACTED:MIXED_API_KEY]'
  );
});

test('buildRedactionEnv and redactToolContent merge bound SecretVault and ALS secret overrides', async (t) => {
  const vault = createMemorySecretVault();
  const brokerToken = 'Pw1Broker+Tok/9988==';
  const alsSecret = 'sk_' + 'live_AlsMixed+Key/7766';
  vault.set('PW1_BROKER_TOKEN', brokerToken);
  vault.set('CUSTOM_VAULT_CRED', 'VaultNoSuffix+Secret/42');
  bindSecretVault(vault);
  t.after(() => bindSecretVault(undefined));

  const merged = buildRedactionEnv({ PATH: '/usr/bin' });
  assert.equal(merged.PW1_BROKER_TOKEN, brokerToken);
  assert.equal(merged.CUSTOM_VAULT_CRED, 'VaultNoSuffix+Secret/42');

  const lowerBroker = encodeURIComponent(brokerToken).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const b64Vault = Buffer.from('VaultNoSuffix+Secret/42', 'utf8').toString('base64');

  await runWithSecretRefs({ SESSION_STRIPE_CRED: alsSecret }, async () => {
    const lowerAls = encodeURIComponent(alsSecret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const text = `tok=${lowerBroker} custom=${b64Vault} als=${lowerAls}`;
    const out = redactToolContent(text, {});
    assert.equal(out.includes(brokerToken), false);
    assert.equal(out.includes(lowerBroker), false);
    assert.equal(out.includes(b64Vault), false);
    assert.equal(out.includes(alsSecret), false);
    assert.equal(out.includes(lowerAls), false);
    assert.equal(
      out,
      'tok=[REDACTED:PW1_BROKER_TOKEN] custom=[REDACTED:CUSTOM_VAULT_CRED] als=[REDACTED:SESSION_STRIPE_CRED]'
    );
  });
});
