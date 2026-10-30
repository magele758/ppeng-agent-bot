import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryUserVault } from '../dist/secrets/user-vault.js';
import {
  SECURE_FORM_TOOL_NAME,
  createSecureFormPort,
  secureFormTextLeaks
} from '../dist/secrets/secure-form.js';
import { createSecureFormTool } from '../dist/tools/secure-form-tools.js';
import { createVaultTools } from '../dist/tools/vault-tools.js';

const OTP = 'otp-SECURE-form-918273';

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

test('secure form card opens one masked field and the receipt has no secret [AC:secure-form#AC-1]', () => {
  const port = createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() });
  const opened = port.request({ sessionId: 's1', field: 'otp', label: 'Bank OTP' });
  assert.equal(opened.card.kind, 'secure_form');
  assert.equal(opened.card.field, 'otp');
  assert.equal(opened.card.masked, true);
  assert.equal(opened.card.status, 'pending');
  assert.equal(opened.receipt.status, 'pending');
  assert.equal('value' in opened.card, false);
  assert.equal(secureFormTextLeaks(JSON.stringify(opened), OTP), false);
});

test('submit stores the otp in UserVault and the receipt is status plus uvref only [AC:secure-form#AC-2]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({ sessionId: 's1', field: 'otp', prompt: 'Code from the bank app' });
  const done = port.submit({ sessionId: 's1', id: opened.card.id, value: OTP });
  assert.equal(done.status, 'filled');
  assert.match(done.fillRef, /^uvref:sf_/);
  assert.match(done.text, /filled/);
  assert.equal(secureFormTextLeaks(JSON.stringify(done), OTP), false);
  assert.equal(secureFormTextLeaks(done.text, OTP), false);
  const summary = vault.list().find((entry) => entry.fillRefs.password === done.fillRef);
  assert.ok(summary);
  assert.equal(JSON.stringify(summary).includes(OTP), false);
  const resolved = vault.resolveReferences([done.fillRef]);
  assert.equal(resolved.get(done.fillRef), OTP);
});

test('cancel stores nothing and reports cancelled [AC:secure-form#AC-3]', () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  const opened = port.request({ sessionId: 's1', field: 'password' });
  const done = port.cancel({ sessionId: 's1', id: opened.card.id });
  assert.equal(done.status, 'cancelled');
  assert.equal(done.fillRef, undefined);
  assert.equal(vault.list().length, 0);
});

test('secure_form is not vault_fill and does not take a secret argument [AC:secure-form#AC-4]', () => {
  const vaultNames = createVaultTools({
    getUserVault: () => createMemoryUserVault(),
    browserFill: async () => ({ filled: [], missing: [] })
  }).map((tool) => tool.name);
  assert.equal(vaultNames.includes('vault_fill'), true);
  assert.equal(vaultNames.includes(SECURE_FORM_TOOL_NAME), false);
  assert.equal(SECURE_FORM_TOOL_NAME, 'secure_form');

  const meta = {};
  const tool = createSecureFormTool({
    port: createSecureFormPort({ store: memoryStore(), vault: createMemoryUserVault() }),
    readMeta: () => meta.current,
    writeMeta: (_id, patch) => {
      meta.current = patch;
    }
  });
  assert.equal(tool.name, 'secure_form');
  assert.equal(JSON.stringify(tool.inputSchema).includes('"value"'), false);
  assert.equal(tool.inputSchema.properties.value, undefined);
});

test('the tool result after submit is a status receipt, not the secret [AC:secure-form#AC-2]', async () => {
  const vault = createMemoryUserVault();
  const port = createSecureFormPort({ store: memoryStore(), vault });
  let meta;
  const tool = createSecureFormTool({
    port,
    readMeta: () => meta,
    writeMeta: (_id, patch) => {
      meta = patch;
    },
    getVault: () => vault
  });
  const context = { session: { id: 's1', metadata: {} } };
  const waiting = await tool.execute(context, { field: 'otp' });
  assert.equal(waiting.ok, false);
  assert.equal(waiting.content.includes(OTP), false);
  const opened = JSON.parse(waiting.content);
  const done = port.submit({ sessionId: 's1', id: opened.card.id, value: OTP });
  assert.equal(port.get(opened.card.id), undefined);
  meta = {
    ...meta,
    status: done.status,
    text: done.text,
    fillRef: done.fillRef
  };
  const again = await tool.execute(context, { field: 'otp' });
  assert.equal(again.ok, true);
  assert.equal(again.content.includes(OTP), false);
  assert.match(again.content, /filled/);
});
