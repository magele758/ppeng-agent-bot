import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginOutboundAttempt, finishOutbound, LEGACY_DRAFT_MATCH_WINDOW_MS, RECOVERED_REPLY_PREFIX } from '../dist/delivery-ledger.js';
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

function setRowCreatedAt(dir, id, iso) {
  const file = ledgerFile(dir);
  const row = file.items.find((item) => item.id === id);
  assert.ok(row, id);
  row.createdAt = iso;
  writeFileSync(join(dir, 'delivery-ledger.json'), `${JSON.stringify(file, null, 2)}\n`);
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
    assert.equal(ledgerFile(dir).items.find((row) => row.content === rejected.text).state, 'abandoned');

    const sent = await releaseOutboundDraft({ gatewayDir: dir, id: again.id, decision: 'approve', channels });
    assert.equal(sent.status, 'sent');
    assert.equal(fetches, 1);
    assert.equal(ledgerFile(dir).items.find((row) => row.id === oldId).state, 'abandoned');
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

test('legacy quarantine does not abandon the same text to another recipient or outside the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-legacy-strict-'));
  const draft = await appendOutboundDraft(dir, { channelId: 'out', text: 'same words' });
  const anchor = Date.parse(draft.createdAt);
  const otherId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'other' }, draft.text);
  const outsideId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, draft.text);
  const edgeId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, draft.text);
  const nearId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, draft.text);
  const badTimeId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, draft.text);
  setRowCreatedAt(dir, outsideId, new Date(anchor - LEGACY_DRAFT_MATCH_WINDOW_MS - 1).toISOString());
  setRowCreatedAt(dir, edgeId, new Date(anchor - LEGACY_DRAFT_MATCH_WINDOW_MS).toISOString());
  setRowCreatedAt(dir, badTimeId, 'not-a-date');
  const both = [
    { id: 'out', type: 'http_post', url: 'http://im.test/hook', payloadMode: 'json_text' },
    { id: 'other', type: 'http_post', url: 'http://im.test/other', payloadMode: 'json_text' }
  ];
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels: both }), 3);
    assert.equal(fetches, 3);
    const rows = ledgerFile(dir).items;
    assert.equal(rows.find((row) => row.id === otherId).state, 'delivered');
    assert.equal(rows.find((row) => row.id === outsideId).state, 'delivered');
    assert.equal(rows.find((row) => row.id === badTimeId).state, 'delivered');
    assert.equal(rows.find((row) => row.id === edgeId).state, 'abandoned');
    assert.equal(rows.find((row) => row.id === nearId).state, 'abandoned');
    fetches = 0;
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels: both }), 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('legacy quarantine matches a feishu recipient and still replays a different one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-draft-legacy-feishu-'));
  const draft = await appendOutboundDraft(dir, {
    channelId: 'out',
    text: 'feishu words',
    receiveId: 'ou_a',
    receiveIdType: 'open_id'
  });
  const otherId = beginOutboundAttempt(
    dir,
    { type: 'feishu', receiveId: 'ou_b', receiveIdType: 'open_id' },
    draft.text
  );
  const sameId = beginOutboundAttempt(
    dir,
    { type: 'feishu', receiveId: 'ou_a', receiveIdType: 'open_id' },
    draft.text
  );
  const channelId = beginOutboundAttempt(dir, { type: 'channel', channelId: 'out' }, draft.text);
  const previous = {
    id: process.env.RAW_AGENT_FEISHU_APP_ID,
    secret: process.env.RAW_AGENT_FEISHU_APP_SECRET
  };
  process.env.RAW_AGENT_FEISHU_APP_ID = 'cli_legacy_match';
  process.env.RAW_AGENT_FEISHU_APP_SECRET = 'secret';
  const sentTo = [];
  let channelFetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('tenant_access_token')) {
      return Response.json({ code: 0, tenant_access_token: 'tok', expire: 7200 });
    }
    if (href.includes('open-apis/im/')) {
      sentTo.push(JSON.parse(init.body).receive_id);
      return Response.json({ code: 0 });
    }
    channelFetches += 1;
    return new Response('ok', { status: 200 });
  };
  try {
    assert.equal(await recoverGatewayOutbound({ gatewayDir: dir, channels }), 2);
    assert.deepEqual(sentTo, ['ou_b']);
    assert.equal(channelFetches, 1);
    const rows = ledgerFile(dir).items;
    assert.equal(rows.find((row) => row.id === otherId).state, 'delivered');
    assert.equal(rows.find((row) => row.id === channelId).state, 'delivered');
    assert.equal(rows.find((row) => row.id === sameId).state, 'abandoned');
  } finally {
    globalThis.fetch = original;
    if (previous.id === undefined) delete process.env.RAW_AGENT_FEISHU_APP_ID;
    else process.env.RAW_AGENT_FEISHU_APP_ID = previous.id;
    if (previous.secret === undefined) delete process.env.RAW_AGENT_FEISHU_APP_SECRET;
    else process.env.RAW_AGENT_FEISHU_APP_SECRET = previous.secret;
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
