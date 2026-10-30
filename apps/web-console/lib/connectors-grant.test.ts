import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectorAuthState,
  connectorViews,
  defaultGrantName,
  grantReferenceBody,
  secretNames
} from './connectors-grant.ts';

const SECRET = 'super-secret-acme-value';

test('needsAuth when auth has no vault name, needsGrant once a reference exists or no secret is required [AC:connector-authorization#AC-1] [AC:connector-authorization#AC-2]', () => {
  assert.equal(connectorAuthState({ granted: false, authKind: 'bearer' }), 'needsAuth');
  assert.equal(connectorAuthState({ granted: false, authKind: 'oauth' }), 'needsAuth');
  assert.equal(
    connectorAuthState({ granted: false, authKind: 'bearer', secretEnv: 'ACME_TOKEN' }),
    'needsGrant'
  );
  assert.equal(connectorAuthState({ granted: false, authKind: 'none' }), 'needsGrant');
  assert.equal(
    connectorAuthState({ granted: true, authKind: 'bearer', secretEnv: 'ACME_TOKEN' }),
    'granted'
  );

  const rows = connectorViews({
    connectors: [
      { id: 'plugin:acme', title: 'Acme', authKind: 'bearer', granted: false },
      { id: 'domain:sre', title: 'SRE', authKind: 'none', granted: false, authState: 'needsGrant' }
    ]
  });
  assert.equal(rows[0]?.authState, 'needsAuth');
  assert.equal(rows[1]?.authState, 'needsGrant');
  assert.equal(JSON.stringify(rows).includes(SECRET), false);
});

test('one-click grant body is a SecretVault name or an existing reference [AC:connector-authorization#AC-3]', () => {
  const needsAuth = {
    id: 'plugin:plain',
    title: 'Plain',
    source: 'plugin',
    authKind: 'header',
    granted: false,
    authState: 'needsAuth' as const
  };
  assert.throws(() => grantReferenceBody(needsAuth, SECRET), /SecretVault name/);
  assert.throws(() => grantReferenceBody(needsAuth, ''), /SecretVault name/);
  assert.deepEqual(grantReferenceBody(needsAuth, 'ACME_TOKEN'), { secretEnv: 'ACME_TOKEN' });

  const ready = { ...needsAuth, authKind: 'bearer', secretEnv: 'ACME_TOKEN', authState: 'needsGrant' as const };
  assert.deepEqual(grantReferenceBody(ready), { secretEnv: 'ACME_TOKEN' });
  const referenced = {
    id: 'discovery:docs',
    title: 'Docs',
    source: 'discovery',
    authKind: 'bearer',
    credRef: 'vault:docs',
    granted: false,
    authState: 'needsGrant' as const
  };
  assert.deepEqual(grantReferenceBody(referenced), { credRef: 'vault:docs' });
  assert.equal(JSON.stringify(grantReferenceBody(ready, 'OTHER_TOKEN')).includes(SECRET), false);

  const names = secretNames({ secrets: [{ name: 'ZEBRA_TOKEN' }, { name: 'ACME_TOKEN' }, { value: SECRET }] });
  assert.deepEqual(names.map((item) => item.name), ['ACME_TOKEN', 'ZEBRA_TOKEN']);
  assert.equal(defaultGrantName(ready, names), 'ACME_TOKEN');
  assert.equal(JSON.stringify(names).includes(SECRET), false);
});
