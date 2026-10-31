import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore, httpStatusFromError } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { secretsRoutes } from '../dist/routes/secrets.js';
import { userVaultRoutes } from '../dist/routes/user-vault.js';
import { entryFillRefs, entryPayload, emptyForm, type VaultEntry } from '../../web-console/lib/user-vault.ts';

const PASSWORD = 'http-vault-PASSWORD-sentinel';
const CARD = '4111111111111111';
const CVV = '918';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'user-vault-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'user-vault-http',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  })
    .addAll(secretsRoutes(runtime))
    .addAll(userVaultRoutes(runtime));
  const server = createServer((request, response) => {
    router
      .dispatch(request, response, new URL(request.url ?? '/', 'http://localhost'), undefined)
      .then((found) => {
        if (!found && !response.writableEnded) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch((error: unknown) => {
        if (response.writableEnded) return;
        response.statusCode = httpStatusFromError(error);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    runtime,
    root: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const send = (root: string, method: string, path: string, body?: unknown) =>
  fetch(`${root}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

test('Lab Vault API: write-only secrets, uvref listing, toggle, delete, SecretVault separate [AC:user-vault-tools#AC-4]', async () => {
  const env = await boot();
  try {
    const off = await (await send(env.root, 'GET', '/api/user-vault/settings')).json() as { settings: { enabled: boolean } };
    assert.equal(off.settings.enabled, false);

    const loginRes = await send(env.root, 'POST', '/api/user-vault/entries', entryPayload({
      ...emptyForm('login'), label: 'Bank', username: 'lei', password: PASSWORD
    }));
    assert.equal(loginRes.status, 200);
    const { entry: login } = (await loginRes.json()) as { entry: VaultEntry };
    const cardRes = await send(env.root, 'POST', '/api/user-vault/entries', entryPayload({
      ...emptyForm('card'), label: 'Visa', holderName: 'Lei', number: CARD, cvv: CVV
    }));
    assert.equal(cardRes.status, 200);
    assert.equal((await send(env.root, 'POST', '/api/user-vault/entries', { kind: 'nope', label: 'x' })).status, 400);
    assert.equal((await send(env.root, 'POST', '/api/user-vault/entries', { kind: 'login', label: '' })).status, 400);

    const listedRaw = await (await send(env.root, 'GET', '/api/user-vault')).text();
    // CVV is 3 digits and can collide with hex ids/timestamps; match the JSON string value only.
    for (const secret of [PASSWORD, CARD, JSON.stringify(CVV)]) assert.ok(!listedRaw.includes(secret));
    const listed = JSON.parse(listedRaw) as { entries: VaultEntry[] };
    assert.equal(listed.entries.length, 2);
    assert.ok(entryFillRefs(listed.entries.find((e) => e.id === login.id)!).includes(`uvref:${login.id}:password`));
    assert.equal(env.runtime.userVault.resolveFillReference(`uvref:${login.id}:password`), PASSWORD);

    const secrets = await (await send(env.root, 'GET', '/api/secrets')).text();
    assert.ok(!secrets.includes('uvref:') && !secrets.includes('Bank'));

    assert.equal((await send(env.root, 'PATCH', '/api/user-vault/settings', { enabled: 'yes' })).status, 400);
    assert.equal((await send(env.root, 'PATCH', '/api/user-vault/settings', { other: 1 })).status, 400);
    const on = await (await send(env.root, 'PATCH', '/api/user-vault/settings', { enabled: true })).json() as { settings: { enabled: boolean } };
    assert.equal(on.settings.enabled, true);

    assert.equal((await send(env.root, 'DELETE', `/api/user-vault/entries/${login.id}`)).status, 200);
    assert.equal((await send(env.root, 'DELETE', `/api/user-vault/entries/${login.id}`)).status, 404);
  } finally {
    await env.close();
  }
});

test('runtime vault tools follow the Lab toggle and hand out refs only [AC:user-vault-tools#AC-1]', async () => {
  const env = await boot();
  try {
    const entry = env.runtime.userVault.upsertLogin({ label: 'RT', username: 'u', password: PASSWORD });
    const byName = (name: string) => env.runtime.tools.find((tool) => tool.name === name)!;
    for (const name of ['vault_list', 'vault_get', 'vault_fill']) assert.ok(byName(name), name);
    const ctx = {} as never;
    assert.equal((await byName('vault_list').execute(ctx, {})).ok, false);

    await send(env.root, 'PATCH', '/api/user-vault/settings', { enabled: true });
    const out = await byName('vault_list').execute(ctx, {});
    assert.equal(out.ok, true);
    assert.ok(out.content.includes(`uvref:${entry.id}:password`));
    assert.ok(!out.content.includes(PASSWORD));
  } finally {
    await env.close();
  }
});

const FORM_OTP = 'http-secure-form-OTP-440191';

test('secure form submit stores the otp and the chat transcript stays free of it [AC:secure-form#AC-2]', async () => {
  const env = await boot();
  try {
    const session = env.runtime.store.createSession({ title: 'secure form', mode: 'chat', agentId: 'general' });
    const port = env.runtime.tools.find((tool) => tool.name === 'secure_form');
    assert.ok(port, 'secure_form tool');
    const waiting = await port.execute({ session: { id: session.id, metadata: {} } } as never, { field: 'otp' });
    const opened = JSON.parse(waiting.content) as { card: { id: string } };
    env.runtime.store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'c1', name: 'secure_form', ok: false, content: waiting.content }
    ]);

    const res = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'submit',
      id: opened.card.id,
      value: FORM_OTP
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.equal(body.includes(FORM_OTP), false);
    assert.match(body, /filled/);
    assert.match(body, /uvref:sf_/);

    const transcript = JSON.stringify(env.runtime.store.foldMessages(session.id));
    assert.equal(transcript.includes(FORM_OTP), false);
    assert.match(transcript, /filled/);
    assert.equal(
      env.runtime.userVault.resolveFillReference(
        (JSON.parse(body) as { receipt: { fillRef: string } }).receipt.fillRef
      ),
      FORM_OTP
    );

    const missing = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'submit',
      id: opened.card.id,
      value: FORM_OTP
    });
    assert.equal(missing.status, 400);
  } finally {
    await env.close();
  }
});

test('secure form cancel stores nothing [AC:secure-form#AC-3]', async () => {
  const env = await boot();
  try {
    const session = env.runtime.store.createSession({ title: 'secure form cancel', mode: 'chat', agentId: 'general' });
    const tool = env.runtime.tools.find((item) => item.name === 'secure_form');
    assert.ok(tool);
    const waiting = await tool.execute({ session: { id: session.id, metadata: {} } } as never, { field: 'password' });
    const opened = JSON.parse(waiting.content) as { card: { id: string } };
    const res = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'cancel',
      id: opened.card.id
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { receipt: { status: string; fillRef?: string } };
    assert.equal(body.receipt.status, 'cancelled');
    assert.equal(body.receipt.fillRef, undefined);
    assert.equal(env.runtime.userVault.list().length, 0);
    assert.equal((await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, { action: 'drop', id: 'x' })).status, 400);
  } finally {
    await env.close();
  }
});

test('multi-field secure form submit (username + password) stores values and receipt has no plaintext secrets [AC:r5-15#AC-1]', async () => {
  const env = await boot();
  try {
    const session = env.runtime.store.createSession({ title: 'multi-field secure form', mode: 'chat', agentId: 'general' });
    const tool = env.runtime.tools.find((item) => item.name === 'secure_form');
    assert.ok(tool);

    // Request multi-field form (username + password)
    const waiting = await tool.execute({ session: { id: session.id, metadata: {} } } as never, {
      fields: [{ field: 'username' }, { field: 'password' }]
    });
    const opened = JSON.parse(waiting.content) as { card: { id: string } };

    env.runtime.store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'c1', name: 'secure_form', ok: false, content: waiting.content }
    ]);

    // Submit multi-field with values
    const res = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'submit',
      id: opened.card.id,
      values: { username: 'alice', password: PASSWORD }
    });
    assert.equal(res.status, 200);
    const body = await res.text();

    // Receipt must have no plaintext secrets
    assert.equal(body.includes(PASSWORD), false, 'password should not appear in receipt');
    assert.match(body, /filled/);

    // Receipt must have fields array for multi-field forms
    const receipt = JSON.parse(body) as { receipt: { fields?: Array<{ field: string; fillRef?: string }> } };
    assert.ok(receipt.receipt.fields, 'multi-field receipt must have fields array');
    assert.equal(receipt.receipt.fields.length, 2);
    for (const field of receipt.receipt.fields) {
      assert.ok(field.fillRef, `field ${field.field} must have fillRef`);
    }

    // Transcript must have no plaintext secrets
    const transcript = JSON.stringify(env.runtime.store.foldMessages(session.id));
    assert.equal(transcript.includes(PASSWORD), false, 'password should not appear in transcript');
    assert.match(transcript, /filled/);

    // resolveFillReference should work
    for (const field of receipt.receipt.fields) {
      if (field.fillRef) {
        const resolved = env.runtime.userVault.resolveFillReference(field.fillRef);
        if (field.field === 'username') {
          assert.equal(resolved, 'alice');
        } else if (field.field === 'password') {
          assert.equal(resolved, PASSWORD);
        }
      }
    }
  } finally {
    await env.close();
  }
});

test('multi-field secure form submit (card number + cvv) with no plaintext in receipt [AC:r5-15#AC-2]', async () => {
  const env = await boot();
  try {
    const session = env.runtime.store.createSession({ title: 'multi-field card form', mode: 'chat', agentId: 'general' });
    const tool = env.runtime.tools.find((item) => item.name === 'secure_form');
    assert.ok(tool);

    // Request multi-field form (cardNumber + cvv)
    const waiting = await tool.execute({ session: { id: session.id, metadata: {} } } as never, {
      fields: [{ field: 'cardNumber' }, { field: 'cvv' }]
    });
    const opened = JSON.parse(waiting.content) as { card: { id: string } };

    env.runtime.store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'c1', name: 'secure_form', ok: false, content: waiting.content }
    ]);

    // Submit multi-field with values
    const res = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'submit',
      id: opened.card.id,
      values: { cardNumber: CARD, cvv: CVV }
    });
    assert.equal(res.status, 200);
    const body = await res.text();

    // Receipt must have no plaintext secrets
    assert.equal(body.includes(CARD), false, 'card number should not appear in receipt');
    assert.equal(body.includes(CVV), false, 'cvv should not appear in receipt');
    assert.match(body, /filled/);

    // Receipt must have fields array with fillRefs
    const receipt = JSON.parse(body) as { receipt: { fields?: Array<{ field: string; fillRef?: string }> } };
    assert.ok(receipt.receipt.fields, 'multi-field receipt must have fields array');
    assert.equal(receipt.receipt.fields.length, 2);
    const fillRefs = receipt.receipt.fields.map((f) => f.fillRef).filter((f) => f);
    assert.equal(fillRefs.length, 2, 'both fields should have fillRefs');

    // Transcript must have no plaintext secrets
    const transcript = JSON.stringify(env.runtime.store.foldMessages(session.id));
    assert.equal(transcript.includes(CARD), false, 'card number should not appear in transcript');
    assert.equal(transcript.includes(CVV), false, 'cvv should not appear in transcript');

    // resolveFillReference should work
    for (const field of receipt.receipt.fields) {
      if (field.fillRef) {
        const resolved = env.runtime.userVault.resolveFillReference(field.fillRef);
        if (field.field === 'cardNumber') {
          assert.equal(resolved, CARD);
        } else if (field.field === 'cvv') {
          assert.equal(resolved, CVV);
        }
      }
    }
  } finally {
    await env.close();
  }
});

test('multi-field secure form cancel stores nothing [AC:r5-15#AC-3]', async () => {
  const env = await boot();
  try {
    const session = env.runtime.store.createSession({ title: 'multi-field cancel', mode: 'chat', agentId: 'general' });
    const tool = env.runtime.tools.find((item) => item.name === 'secure_form');
    assert.ok(tool);

    // Request multi-field form
    const waiting = await tool.execute({ session: { id: session.id, metadata: {} } } as never, {
      fields: [{ field: 'username' }, { field: 'password' }]
    });
    const opened = JSON.parse(waiting.content) as { card: { id: string } };

    env.runtime.store.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: 'c1', name: 'secure_form', ok: false, content: waiting.content }
    ]);

    // Cancel multi-field form
    const res = await send(env.root, 'POST', `/api/sessions/${session.id}/secure-form`, {
      action: 'cancel',
      id: opened.card.id
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { receipt: { status: string; fields?: unknown } };
    assert.equal(body.receipt.status, 'cancelled');
    assert.equal(env.runtime.userVault.list().length, 0, 'cancel should store nothing');
  } finally {
    await env.close();
  }
});
