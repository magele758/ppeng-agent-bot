import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendEmailHttp } from '../dist/channels/email.js';
import { resolveEmailOutboundFrom } from '../dist/outbound-identity.js';

function stubFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? ''), headers: init?.headers });
    return new Response('ok', { status: 200 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

const baseChannel = {
  id: 'mail-1',
  type: 'email',
  url: 'https://relay.example/send',
  target: 'user@example.com',
  subject: 'hello'
};

test('sendEmailHttp payload.from uses claimed address when channel.from empty [AC:r5-22-outbound-from-claimed#AC-1]', async () => {
  const net = stubFetch();
  try {
    const claimed = 'agent1@agent.local';
    const result = await sendEmailHttp(baseChannel, 'body text', {}, { claimedFrom: claimed });
    assert.equal(result.ok, true);
    assert.equal(net.calls.length, 1);
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.transport, 'email_http');
    assert.equal(payload.from, claimed);
    assert.equal(payload.to, 'user@example.com');
    assert.equal(payload.text, 'body text');
  } finally {
    net.restore();
  }
});

test('sendEmailHttp payload.from prefers explicit channel.from over claimed [AC:r5-22-outbound-from-claimed#AC-2]', async () => {
  const net = stubFetch();
  try {
    const channel = { ...baseChannel, from: 'explicit@other.example' };
    const result = await sendEmailHttp(channel, 'body text', {}, { claimedFrom: 'agent1@agent.local' });
    assert.equal(result.ok, true);
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.from, 'explicit@other.example');
    assert.equal(resolveEmailOutboundFrom(channel, 'agent1@agent.local').source, 'channel');
  } finally {
    net.restore();
  }
});

test('sendEmailHttp with requireFrom fail-closes when no from and no claim [AC:r5-22-outbound-from-claimed#AC-3]', async () => {
  const net = stubFetch();
  try {
    const result = await sendEmailHttp(baseChannel, 'body text', {}, { requireFrom: true });
    assert.equal(result.ok, false);
    assert.match(result.text, /from unresolved/i);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('resolveEmailOutboundFrom documents precedence [AC:r5-22-outbound-from-claimed#AC-2] [AC:r5-22-outbound-from-claimed#AC-4]', () => {
  assert.deepEqual(resolveEmailOutboundFrom({ from: 'a@x' }, 'b@y'), {
    from: 'a@x',
    resolved: true,
    source: 'channel'
  });
  assert.deepEqual(resolveEmailOutboundFrom({}, 'b@y'), {
    from: 'b@y',
    resolved: true,
    source: 'claimed'
  });
  assert.deepEqual(resolveEmailOutboundFrom({ from: '  ' }, undefined), { resolved: false });
});
