import test from 'node:test';
import assert from 'node:assert/strict';
import { runLabTick } from './lab-tick.ts';

test('overview starts loading while version and health are still pending [AC:lab-startup-request-load#AC-5]', async () => {
  const order: string[] = [];
  let releaseMeta = () => {};
  const done = runLabTick({
    refreshMeta: () => new Promise<void>((resolve) => {
      order.push('meta:start');
      releaseMeta = () => {
        order.push('meta:end');
        resolve();
      };
    }),
    refreshOverview: async () => {
      order.push('overview');
    },
    refreshPlayPanel: async () => {
      order.push('panel');
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['meta:start', 'overview']);
  releaseMeta();
  await done;
  assert.deepEqual(order, ['meta:start', 'overview', 'meta:end', 'panel']);
});

test('the open conversation is refreshed only when asked [AC:lab-startup-request-load#AC-5]', async () => {
  const order: string[] = [];
  await runLabTick({
    refreshMeta: async () => {
      order.push('meta');
    },
    refreshOverview: async () => {
      order.push('overview');
    }
  });
  assert.deepEqual(order, ['meta', 'overview']);
});
