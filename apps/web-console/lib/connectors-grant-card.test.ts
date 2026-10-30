import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorGrantApprovalCard, connectorGrantCardBody, connectorGrantResultCard } from './connectors-grant-card.ts';

const SECRET = 'super-secret-acme-value';

function cardJson(card: Record<string, unknown>): string {
  return JSON.stringify({ card, receipt: { status: 'pending', text: 'waiting' } });
}

test('in-chat grant card faces needsAuth and needsGrant and hides granted [AC:connector-authorization#AC-5]', () => {
  const needsAuth = connectorGrantResultCard(
    cardJson({ kind: 'connector_grant', id: 'plugin:plain', title: 'Plain', authKind: 'header', authState: 'needsAuth' })
  );
  assert.ok(needsAuth);
  assert.equal(needsAuth.authState, 'needsAuth');
  assert.equal(needsAuth.id, 'plugin:plain');

  const needsGrant = connectorGrantResultCard(
    cardJson({
      kind: 'connector_grant',
      id: 'plugin:acme',
      title: 'Acme',
      authKind: 'bearer',
      secretEnv: 'ACME_TOKEN',
      authState: 'needsGrant'
    })
  );
  assert.ok(needsGrant);
  assert.equal(needsGrant.authState, 'needsGrant');
  assert.equal(needsGrant.secretEnv, 'ACME_TOKEN');

  assert.equal(
    connectorGrantResultCard(
      cardJson({ kind: 'connector_grant', id: 'domain:sre', authKind: 'none', granted: true, authState: 'granted' })
    ),
    null
  );
  assert.equal(connectorGrantResultCard('not json'), null);
  assert.equal(connectorGrantResultCard(JSON.stringify({ card: { kind: 'secure_form', id: 'sform_1' } })), null);

  const fromApproval = connectorGrantApprovalCard({
    toolName: 'connector_grant',
    args: { id: 'plugin:plain', title: 'Plain', authKind: 'header', authState: 'needsAuth' }
  });
  assert.equal(fromApproval?.authState, 'needsAuth');
  assert.equal(connectorGrantApprovalCard({ toolName: 'secure_form', args: { id: 'plugin:plain' } }), null);
  assert.equal(JSON.stringify({ needsAuth, needsGrant, fromApproval }).includes(SECRET), false);
});

test('in-chat Grant posts a SecretVault name and never a secret value [AC:connector-authorization#AC-5]', () => {
  const needsAuth = connectorGrantResultCard(
    cardJson({ kind: 'connector_grant', id: 'plugin:plain', title: 'Plain', authKind: 'header', authState: 'needsAuth' })
  );
  assert.ok(needsAuth);
  assert.throws(() => connectorGrantCardBody(needsAuth, SECRET), /SecretVault name/);
  assert.deepEqual(connectorGrantCardBody(needsAuth, 'ACME_TOKEN'), { secretEnv: 'ACME_TOKEN' });

  const needsGrant = connectorGrantResultCard(
    cardJson({
      kind: 'connector_grant',
      id: 'plugin:acme',
      title: 'Acme',
      authKind: 'bearer',
      secretEnv: 'ACME_TOKEN',
      authState: 'needsGrant',
      note: SECRET
    })
  );
  assert.ok(needsGrant);
  assert.deepEqual(connectorGrantCardBody(needsGrant), { secretEnv: 'ACME_TOKEN' });
  assert.equal(JSON.stringify(connectorGrantCardBody(needsGrant, 'OTHER_TOKEN')).includes(SECRET), false);
  assert.equal(JSON.stringify(needsGrant).includes(SECRET), false);
});
