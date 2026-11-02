import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentInboxPort, RawAgentRuntime, resolveBotPrincipal } from '@ppeng/agent-core';
import { createDaemonDeliveryPort } from '../dist/delivery-port.js';

function boot(channels?: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-claimed-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'claimed-test',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  writeFileSync(
    join(dir, 'gateway.config.json'),
    JSON.stringify({
      channels: channels ?? [
        { id: 'mail-1', type: 'email', url: 'https://relay.example/send', target: 'user@example.com' }
      ]
    })
  );
  return { dir, runtime };
}

test('daemon delivery port wires claimedFrom when inbox is claimed [AC:r5-23-daemon-claimed-from#AC-1]', async () => {
  const { dir, runtime } = boot();
  const inboxPort = createAgentInboxPort(runtime.store);
  const principal = resolveBotPrincipal(runtime.store);
  inboxPort.claim(principal, 'agent1');

  const port = await createDaemonDeliveryPort(runtime, dir);
  await port.draft({ channelId: 'mail-1', text: 'hello' });
  const previews = await port.listPreviews();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].identity.resolved, true);
  assert.equal(previews[0].identity.sender, 'agent1@agent.local');
});

test('daemon delivery port resolves explicit channel.from over claimed [AC:r5-23-daemon-claimed-from#AC-2]', async () => {
  const { dir, runtime } = boot([
    {
      id: 'mail-explicit',
      type: 'email',
      url: 'https://relay.example/send',
      target: 'user@example.com',
      from: 'explicit@other.example'
    }
  ]);
  const inboxPort = createAgentInboxPort(runtime.store);
  inboxPort.claim(resolveBotPrincipal(runtime.store), 'agent1');

  const port = await createDaemonDeliveryPort(runtime, dir);
  await port.draft({ channelId: 'mail-explicit', text: 'hello' });
  const previews = await port.listPreviews();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].identity.resolved, true);
  assert.equal(previews[0].identity.sender, 'explicit@other.example');
});

test('daemon delivery port leaves from unresolved when no claim [AC:r5-23-daemon-claimed-from#AC-3]', async () => {
  const { dir, runtime } = boot();
  const port = await createDaemonDeliveryPort(runtime, dir);
  await port.draft({ channelId: 'mail-1', text: 'hello' });
  const previews = await port.listPreviews();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].identity.resolved, false);
  assert.equal(previews[0].identity.sender, undefined);
});

test('daemon delivery port uses owner userId when provided [AC:r5-23-daemon-claimed-from#AC-4]', async () => {
  const { dir, runtime } = boot();
  const inboxPort = createAgentInboxPort(runtime.store);
  inboxPort.claim(resolveBotPrincipal(runtime.store, { userId: 'user123' }), 'userbot');

  const port = await createDaemonDeliveryPort(runtime, dir, { userId: 'user123' });
  await port.draft({ channelId: 'mail-1', text: 'hello from user' });
  const previews = await port.listPreviews();
  assert.equal(previews.length, 1);
  assert.equal(previews[0].identity.sender, 'userbot@agent.local');
  assert.equal(previews[0].identity.resolved, true);
});
