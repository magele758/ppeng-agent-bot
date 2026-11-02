import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEmailReplySubject, sendEmailHttp } from '../dist/channels/email.js';
import { resolveEmailOutboundFrom } from '../dist/outbound-identity.js';
import { appendOutboundDraft, readOutboundDrafts } from '../dist/outbound-drafts.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  target: 'user@example.com'
};

test('sendEmailHttp payload includes inReplyTo and derives references [AC:r5-24-outbound-email-reply#AC-1]', async () => {
  const net = stubFetch();
  try {
    const result = await sendEmailHttp(
      { ...baseChannel, subject: 'Hello' },
      'body text',
      {},
      { inReplyTo: '<msg-1@agent.local>', claimedFrom: 'agent1@agent.local' }
    );
    assert.equal(result.ok, true);
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.transport, 'email_http');
    assert.equal(payload.inReplyTo, '<msg-1@agent.local>');
    assert.equal(payload.references, '<msg-1@agent.local>');
    assert.equal(payload.from, 'agent1@agent.local');
  } finally {
    net.restore();
  }
});

test('sendEmailHttp uses explicit references when provided [AC:r5-24-outbound-email-reply#AC-1]', async () => {
  const net = stubFetch();
  try {
    await sendEmailHttp(
      { ...baseChannel, inReplyTo: '<a@x>', references: '<root@x> <a@x>', subject: 'T' },
      'body',
      {}
    );
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.inReplyTo, '<a@x>');
    assert.equal(payload.references, '<root@x> <a@x>');
  } finally {
    net.restore();
  }
});

test('resolveEmailReplySubject defaults to Re: original when subject empty [AC:r5-24-outbound-email-reply#AC-2]', () => {
  assert.equal(
    resolveEmailReplySubject({ subject: '', replyToSubject: 'Quarterly update' }),
    'Re: Quarterly update'
  );
  assert.equal(
    resolveEmailReplySubject({ replyToSubject: 'Quarterly update' }),
    'Re: Quarterly update'
  );
  assert.equal(
    resolveEmailReplySubject({ subject: '  ', replyToSubject: 'Re: Already threaded' }),
    'Re: Already threaded'
  );
});

test('sendEmailHttp applies Re: default for claimed-inbox reply [AC:r5-24-outbound-email-reply#AC-2]', async () => {
  const net = stubFetch();
  try {
    await sendEmailHttp(baseChannel, 'thanks', {}, {
      inReplyTo: '<orig@agent.local>',
      replyToSubject: 'Need docs',
      subject: '',
      claimedFrom: 'bot@agent.local'
    });
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.subject, 'Re: Need docs');
    assert.equal(payload.inReplyTo, '<orig@agent.local>');
  } finally {
    net.restore();
  }
});

test('explicit subject wins over Re: default [AC:r5-24-outbound-email-reply#AC-3]', async () => {
  assert.equal(
    resolveEmailReplySubject({ subject: 'Custom subject', replyToSubject: 'Original' }),
    'Custom subject'
  );
  const net = stubFetch();
  try {
    await sendEmailHttp(
      { ...baseChannel, subject: 'Channel subject' },
      'body',
      {},
      { inReplyTo: '<m@x>', replyToSubject: 'Original', subject: 'Explicit wins' }
    );
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.subject, 'Explicit wins');
  } finally {
    net.restore();
  }
});

test('claimedFrom precedence still works with reply fields [AC:r5-24-outbound-email-reply#AC-4]', async () => {
  const net = stubFetch();
  try {
    await sendEmailHttp(
      { ...baseChannel, from: 'explicit@other.example', subject: 'S' },
      'body',
      {},
      { claimedFrom: 'agent1@agent.local', inReplyTo: '<m@x>' }
    );
    const payload = JSON.parse(net.calls[0].body);
    assert.equal(payload.from, 'explicit@other.example');
    assert.equal(resolveEmailOutboundFrom({ from: 'explicit@other.example' }, 'agent1@agent.local').source, 'channel');

    net.calls.length = 0;
    await sendEmailHttp(baseChannel, 'body', {}, { claimedFrom: 'agent1@agent.local', subject: 'S' });
    assert.equal(JSON.parse(net.calls[0].body).from, 'agent1@agent.local');

    const fail = await sendEmailHttp(baseChannel, 'body', {}, { requireFrom: true, subject: 'S' });
    assert.equal(fail.ok, false);
    assert.match(fail.text, /from unresolved/i);
  } finally {
    net.restore();
  }
});

test('appendOutboundDraft stores inReplyTo / subject / replyToSubject [AC:r5-24-outbound-email-reply#AC-5]', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r5-24-draft-'));
  try {
    const draft = await appendOutboundDraft(dir, {
      channelId: 'mail-1',
      text: 'reply body',
      inReplyTo: '<msg-9@agent.local>',
      subject: '',
      replyToSubject: 'Hello there'
    });
    assert.equal(draft.inReplyTo, '<msg-9@agent.local>');
    assert.equal(draft.subject, '');
    assert.equal(draft.replyToSubject, 'Hello there');
    const items = await readOutboundDrafts(dir);
    assert.equal(items[0].inReplyTo, '<msg-9@agent.local>');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
