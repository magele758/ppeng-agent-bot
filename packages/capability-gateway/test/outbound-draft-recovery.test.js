import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginOutboundAttempt, finishOutbound, RECOVERED_REPLY_PREFIX } from '../dist/delivery-ledger.js';
import { createGatewayContext } from '../dist/http.js';
import { recoverGatewayOutbound, releaseOutboundDraft } from '../dist/outbound.js';
import { appendOutboundDraft, claimOutboundDraft, readOutboundDrafts, settleOutboundDraft } from '../dist/outbound-drafts.js';

const channels = [{ id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' }];

function ledgerFile(dir) {
  return JSON.parse(readFileSync(join(dir, 'delivery-ledger.json'), 'utf8'));
}

function ledgerRows(dir, draftId) {
  return ledgerFile(dir).items.filter((row) => row.draftId === draftId);
}

async function draftOf(dir, id) {
  const items = await readOutboundDrafts(dir);
  const draft = items.find((item) => item.id === id);
  assert.ok(draft, id);
  return draft;
}

test('rejecting a failed draft cancels ledger replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-reject-'));
  const draft = await appendOutboundDraft(dir, { channelId: 'out', text: 'do not send twice' });
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('down', { status: 500 });
  };
  try {
    await assert.rejects(() => releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'approve', channels }));
    assert.equal(fetches, 1);
    assert.equal((await draftOf(dir, draft.id)).status, 'failed');
    assert.equal(ledgerRows(dir, draft.id).some((row) => row.state === 'failed'), true);

    fetches = 0;
    const rejected = await releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'reject', channels });
    assert.equal(rejected.status, 'rejected');
    assert.equal(fetches, 0);
    assert.equal(ledgerRows(dir, draft.id).every((row) => row.state === 'abandoned'), true);

    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('reapproving a failed draft sends once and does not replay the old row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-reapprove-'));
  const draft = await appendOutboundDraft(dir, { channelId: 'out', text: 'send once' });
  let fetches = 0;
  let fail = true;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    if (fail) return new Response('down', { status: 500 });
    return new Response('ok', { status: 200 });
  };
  try {
    await assert.rejects(() => releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'approve', channels }));
    assert.equal(fetches, 1);
    fail = false;
    fetches = 0;
    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetches, 1);
    const rows = ledgerRows(dir, draft.id);
    assert.equal(rows.filter((row) => row.state === 'delivered').length, 1);
    assert.equal(rows.filter((row) => row.state === 'abandoned').length, 1);
    assert.equal(rows.some((row) => row.state === 'failed'), false);

    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('reapprove does not send again when delivery already succeeded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-delivered-'));
  const draft = await appendOutboundDraft(dir, { channelId: 'out', text: 'once only' });
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetches, 1);
    await settleOutboundDraft(dir, draft.id, { status: 'failed', error: 'settle failed after delivery' });
    fetches = 0;
    const again = await releaseOutboundDraft({ gatewayDir: dir, id: draft.id, decision: 'approve', channels });
    assert.equal(again.status, 'sent');
    assert.equal(fetches, 0);
    assert.equal(ledgerRows(dir, draft.id).filter((row) => row.state === 'delivered').length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('startup quarantines unfinished ledger rows that match a draft but have no draftId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-legacy-'));
  const draft = await appendOutboundDraft(dir, { channelId: 'out', text: 'legacy body' });
  const target = { type: 'channel', channelId: 'out' };
  beginOutboundAttempt(dir, target, draft.text);
  beginOutboundAttempt(dir, target, `${RECOVERED_REPLY_PREFIX}${draft.text}`);
  beginOutboundAttempt(dir, target, 'ordinary im');
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 1);
    assert.equal(fetches, 1);
    const rows = ledgerFile(dir).items;
    const legacy = rows.filter((row) => !row.draftId && String(row.content).includes('legacy body'));
    assert.equal(legacy.length, 2);
    assert.equal(legacy.every((row) => row.state === 'abandoned'), true);
    assert.equal(rows.find((row) => row.content === 'ordinary im').state, 'delivered');
    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('reject or reapprove does not replay a pre-fix row that lacks draftId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-legacy-decide-'));
  const target = { type: 'channel', channelId: 'out' };
  const rejected = await appendOutboundDraft(dir, { channelId: 'out', text: 'do not replay' });
  beginOutboundAttempt(dir, target, rejected.text);
  const again = await appendOutboundDraft(dir, { channelId: 'out', text: 'send now' });
  const oldId = beginOutboundAttempt(dir, target, again.text);
  finishOutbound(dir, oldId, 'failed');
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const turnedDown = await releaseOutboundDraft({ gatewayDir: dir, id: rejected.id, decision: 'reject', channels });
    assert.equal(turnedDown.status, 'rejected');
    assert.equal(fetches, 0);
    assert.equal(ledgerFile(dir).items.find((row) => row.content === rejected.text).state, 'attempting');

    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: again.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetches, 1);
    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
    const rows = ledgerFile(dir).items;
    assert.equal(rows.find((row) => row.content === rejected.text).state, 'abandoned');
    assert.equal(rows.find((row) => row.id === oldId).state, 'abandoned');
    assert.equal(rows.find((row) => row.id === oldId).draftId, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('startup reconciles a sending draft from the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-crash-'));
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    const missed = await appendOutboundDraft(dir, { channelId: 'out', text: 'never left' });
    await claimOutboundDraft(dir, missed.id);
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
    const retryable = await draftOf(dir, missed.id);
    assert.equal(retryable.status, 'failed');
    assert.match(retryable.error, /interrupted/);
    const rejected = await releaseOutboundDraft({ gatewayDir: dir, id: missed.id, decision: 'reject', channels });
    assert.equal(rejected.status, 'rejected');
    assert.equal(fetches, 0);

    const delivered = await appendOutboundDraft(dir, { channelId: 'out', text: 'already gone' });
    await claimOutboundDraft(dir, delivered.id);
    const rowId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, delivered.text, delivered.id);
    finishOutbound(dir, rowId, 'delivered');
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
    assert.equal((await draftOf(dir, delivered.id)).status, 'sent');

    const crashed = await appendOutboundDraft(dir, { channelId: 'out', text: 'maybe not' });
    await claimOutboundDraft(dir, crashed.id);
    beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, crashed.text, crashed.id);
    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
    assert.equal((await draftOf(dir, crashed.id)).status, 'failed');
    assert.equal(ledgerRows(dir, crashed.id).every((row) => row.state === 'abandoned'), true);

    fetches = 0;
    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: crashed.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetches, 1);
    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('startup reconciles a sending draft when the gateway listener is off', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-draft-boot-'));
  const repo = mkdtempSync(join(tmpdir(), 'gw-draft-repo-'));
  const gatewayDir = join(stateDir, 'gateway');
  const draft = await appendOutboundDraft(gatewayDir, { channelId: 'out', text: 'stuck sending' });
  await claimOutboundDraft(gatewayDir, draft.id);
  const previous = process.env.RAW_AGENT_GATEWAY_ENABLED;
  process.env.RAW_AGENT_GATEWAY_ENABLED = '0';
  try {
    const ctx = await createGatewayContext({}, repo, stateDir);
    assert.equal(ctx, null);
    const recovered = await draftOf(gatewayDir, draft.id);
    assert.equal(recovered.status, 'failed');
    assert.match(recovered.error, /interrupted/);

    const legacy = await appendOutboundDraft(gatewayDir, { channelId: 'out', text: 'old row' });
    beginOutboundAttempt(gatewayDir, { type: 'channel', channelId: 'out' }, legacy.text);
    beginOutboundAttempt(gatewayDir, { type: 'channel', channelId: 'out' }, 'keep me');
    assert.equal(await createGatewayContext({}, repo, stateDir), null);
    const rows = ledgerFile(gatewayDir).items;
    assert.equal(rows.find((row) => row.content === legacy.text).state, 'abandoned');
    assert.equal(rows.find((row) => row.content === 'keep me').state, 'attempting');
  } finally {
    if (previous === undefined) delete process.env.RAW_AGENT_GATEWAY_ENABLED;
    else process.env.RAW_AGENT_GATEWAY_ENABLED = previous;
  }
});
