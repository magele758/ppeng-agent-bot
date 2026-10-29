import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserDeliveryPort } from '../dist/user-delivery-port.js';
import {
  isQuietNow,
  normalizeQuietHours,
  parseQuietHoursPatch,
  quietWindowEnd,
  readQuietHours,
  writeQuietHours
} from '../dist/delivery-quiet-hours.js';
import { cleanupGatewayTemps } from './gateway-harness.mjs';

after(() => cleanupGatewayTemps());

const channels = [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }];
const policy = { enabled: true, startHour: 22, endHour: 8, timezone: 'UTC' };
const at = (iso) => Date.parse(iso);

async function withFetch(fn) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(String(init?.body ?? ''));
    return new Response('ok', { status: 200 });
  };
  try {
    await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

function makePort(quietHours, clock) {
  const gatewayDir = join(mkdtempSync(join(tmpdir(), 'quiet-hours-')), 'gateway');
  return createUserDeliveryPort({ gatewayDir, channels, quietHours: () => quietHours, now: () => clock.now });
}

test('approve inside a window that wraps midnight defers instead of sending [AC:delivery-quiet-hours#AC-1]', async () => {
  await withFetch(async (sent) => {
    const clock = { now: at('2026-10-29T23:30:00Z') };
    const port = makePort(policy, clock);
    const draft = await port.draft({ channelId: 'out', text: 'late ping' });
    const held = await port.confirm({ id: draft.id, decision: 'approve' });
    assert.equal(held.status, 'deferred');
    assert.equal(held.deferredUntil, '2026-10-30T08:00:00.000Z');
    assert.equal(sent.length, 0);
    const [listed] = await port.list();
    assert.equal(listed.status, 'deferred');
  });
});

test('outside the window or when disabled, approve sends once [AC:delivery-quiet-hours#AC-2]', async () => {
  await withFetch(async (sent) => {
    const day = makePort(policy, { now: at('2026-10-29T12:00:00Z') });
    const a = await day.draft({ channelId: 'out', text: 'daytime' });
    assert.equal((await day.confirm({ id: a.id, decision: 'approve' })).status, 'sent');
    const off = makePort({ ...policy, enabled: false }, { now: at('2026-10-29T23:30:00Z') });
    const b = await off.draft({ channelId: 'out', text: 'disabled' });
    assert.equal((await off.confirm({ id: b.id, decision: 'approve' })).status, 'sent');
    const none = makePort(undefined, { now: at('2026-10-29T23:30:00Z') });
    const c = await none.draft({ channelId: 'out', text: 'unset' });
    assert.equal((await none.confirm({ id: c.id, decision: 'approve' })).status, 'sent');
    assert.equal(sent.length, 3);
  });
});

test('flush is a no-op in the window, then releases deferred drafts in order exactly once [AC:delivery-quiet-hours#AC-3]', async () => {
  await withFetch(async (sent) => {
    const clock = { now: at('2026-10-29T23:30:00Z') };
    const port = makePort(policy, clock);
    const first = await port.draft({ channelId: 'out', text: 'one' });
    const second = await port.draft({ channelId: 'out', text: 'two' });
    await port.confirm({ id: first.id, decision: 'approve' });
    await port.confirm({ id: second.id, decision: 'approve' });
    assert.deepEqual(await port.flushDeferred(), []);
    assert.equal(sent.length, 0);

    clock.now = at('2026-10-30T08:00:00Z');
    assert.deepEqual(await port.flushDeferred(), [first.id, second.id]);
    assert.equal(sent.length, 2);
    assert.match(sent[0], /one/);
    assert.match(sent[1], /two/);
    assert.deepEqual(await port.flushDeferred(), []);
    assert.equal(sent.length, 2);
    assert.deepEqual((await port.list()).map((d) => d.status), ['sent', 'sent']);
  });
});

test('a failing deferred send does not block the rest and stays retryable [AC:delivery-quiet-hours#AC-3]', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response('boom', { status: 500 }) : new Response('ok', { status: 200 });
  };
  try {
    const clock = { now: at('2026-10-29T23:30:00Z') };
    const port = makePort(policy, clock);
    const bad = await port.draft({ channelId: 'out', text: 'bad' });
    const good = await port.draft({ channelId: 'out', text: 'good' });
    await port.confirm({ id: bad.id, decision: 'approve' });
    await port.confirm({ id: good.id, decision: 'approve' });
    clock.now = at('2026-10-30T09:00:00Z');
    await port.flushDeferred();
    const byId = Object.fromEntries((await port.list()).map((d) => [d.id, d.status]));
    assert.equal(byId[bad.id], 'failed');
    assert.equal(byId[good.id], 'sent');
  } finally {
    globalThis.fetch = original;
  }
});

test('reject of a deferred draft is final and never sends [AC:delivery-quiet-hours#AC-4]', async () => {
  await withFetch(async (sent) => {
    const clock = { now: at('2026-10-29T23:30:00Z') };
    const port = makePort(policy, clock);
    const draft = await port.draft({ channelId: 'out', text: 'cancel me' });
    await port.confirm({ id: draft.id, decision: 'approve' });
    assert.equal((await port.confirm({ id: draft.id, decision: 'reject' })).status, 'rejected');
    clock.now = at('2026-10-30T09:00:00Z');
    assert.deepEqual(await port.flushDeferred(), []);
    assert.equal(sent.length, 0);
  });
});

test('settings validate input and persist for the next call [AC:delivery-quiet-hours#AC-5]', () => {
  assert.throws(() => parseQuietHoursPatch({ startHour: 24 }), /startHour/);
  assert.throws(() => parseQuietHoursPatch({ endHour: 1.5 }), /endHour/);
  assert.throws(() => parseQuietHoursPatch({ timezone: 'Mars/Base' }), /timezone/);
  assert.throws(() => parseQuietHoursPatch({ enabled: 'yes' }), /enabled/);
  assert.throws(() => parseQuietHoursPatch([]), /object/);
  assert.deepEqual(parseQuietHoursPatch(undefined), {});
  assert.deepEqual(parseQuietHoursPatch({ enabled: true, startHour: 23, timezone: 'Asia/Shanghai' }), {
    enabled: true,
    startHour: 23,
    timezone: 'Asia/Shanghai'
  });

  const kv = new Map();
  const store = { getDaemonControl: (k) => kv.get(k), setDaemonControl: (k, v) => kv.set(k, v) };
  assert.equal(readQuietHours(store).enabled, false);
  writeQuietHours(store, { enabled: true, startHour: 1, endHour: 5, timezone: 'UTC' });
  const saved = readQuietHours(store);
  assert.deepEqual([saved.enabled, saved.startHour, saved.endHour], [true, 1, 5]);
  writeQuietHours(store, { endHour: 6 });
  assert.equal(readQuietHours(store).startHour, 1);
  assert.equal(readQuietHours(store).endHour, 6);
  assert.equal(readQuietHours(undefined).enabled, false);
  assert.equal(normalizeQuietHours({ enabled: true, startHour: 99, timezone: 'bad' }).startHour, 22);
});

test('window math: same-day window, equal bounds, timezone, window end [AC:delivery-quiet-hours#AC-1]', () => {
  const day = { enabled: true, startHour: 13, endHour: 15, timezone: 'UTC' };
  assert.equal(isQuietNow(day, at('2026-10-29T13:00:00Z')), true);
  assert.equal(isQuietNow(day, at('2026-10-29T15:00:00Z')), false);
  assert.equal(isQuietNow({ ...day, endHour: 13 }, at('2026-10-29T13:30:00Z')), false);
  assert.equal(isQuietNow(undefined, at('2026-10-29T13:30:00Z')), false);
  const sh = { enabled: true, startHour: 22, endHour: 8, timezone: 'Asia/Shanghai' };
  assert.equal(isQuietNow(sh, at('2026-10-29T15:00:00Z')), true); // 23:00 local
  assert.equal(isQuietNow(sh, at('2026-10-29T05:00:00Z')), false); // 13:00 local
  assert.equal(quietWindowEnd(sh, at('2026-10-29T15:00:00Z')), at('2026-10-30T00:00:00Z'));
  const never = { enabled: true, startHour: 0, endHour: 23, timezone: 'UTC' };
  assert.equal(quietWindowEnd(never, at('2026-10-29T12:00:00Z')), at('2026-10-29T23:00:00Z'));
});
