import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ValidationError } from '@ppeng/agent-core';
import { deliveryQuietHoursRoutes } from '../dist/routes/delivery-quiet-hours.js';
import { createDaemonDeliveryPort } from '../dist/delivery-port.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-quiet-http-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'quiet-hours',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  return { dir, runtime, routes: deliveryQuietHoursRoutes(runtime) };
}

async function call(
  routes: ReturnType<typeof deliveryQuietHoursRoutes>,
  method: 'GET' | 'PATCH',
  body?: unknown
): Promise<{ status: number; body: any }> {
  const spec = routes.find((route) => route.method === method)!;
  const out = { status: 0, body: undefined as unknown };
  const response = {
    statusCode: 0,
    setHeader() {},
    end(raw: string) {
      out.status = this.statusCode;
      out.body = JSON.parse(raw);
    }
  };
  await spec.handler({ readBody: async () => body, response } as never);
  return out as { status: number; body: any };
}

test('quiet-hours API saves, validates, and the daemon port enforces the saved window [AC:delivery-quiet-hours#AC-5]', async () => {
  const { dir, runtime, routes } = boot();
  assert.equal((await call(routes, 'GET')).body.settings.enabled, false);

  await assert.rejects(() => call(routes, 'PATCH', { startHour: 99 }), ValidationError);
  assert.equal((await call(routes, 'GET')).body.settings.startHour, 22);

  // Window [hour-1, hour+2) UTC always contains the current hour.
  const hour = new Date().getUTCHours();
  const startHour = (hour + 23) % 24;
  const endHour = (hour + 2) % 24;
  const saved = await call(routes, 'PATCH', { enabled: true, startHour, endHour, timezone: 'UTC' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.enabled, true);

  const port = await createDaemonDeliveryPort(runtime, dir);
  const draft = await port.draft({ channelId: 'out', text: 'hold me' });
  const held = await port.confirm({ id: draft.id, decision: 'approve' });
  assert.equal(held.status, 'deferred');

  await call(routes, 'PATCH', { enabled: false });
  assert.equal((await call(routes, 'GET')).body.settings.enabled, false);
  const after = await (await createDaemonDeliveryPort(runtime, dir)).list();
  assert.equal(after[0].status, 'deferred');
});
