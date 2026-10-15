import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { SqliteStateStore } from '../dist/storage.js';
import { createCronJob } from '../dist/cron/cron-facade.js';
import { tickCronJobs } from '../dist/runtime/scheduler-host.js';
import {
  EVENT_PRECHECK_FILE_ENV,
  EVENT_SIGNATURE_WINDOW_MS,
  acceptEventRoutine,
  verifyEmailSignature,
  verifyGithubSignature,
  verifySlackSignature
} from '../dist/cron/event-routine.js';
import { claimInboundEvent } from '../../capability-gateway/dist/inbound-guard.js';
import { handleGatewayHttp } from '../../capability-gateway/dist/http.js';

const SECRET = 'event-secret-do-not-log';
const SECRET_ENV = 'PPENG_TEST_EVENT_SECRET';
process.env[SECRET_ENV] = SECRET;

const NOW = 1_700_000_000_000;
const NOW_SEC = String(Math.floor(NOW / 1000));

function hmac(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function githubSig(raw, deliveryId, timestamp = NOW_SEC, secret = SECRET) {
  return `sha256=${hmac(secret, `${timestamp}.${deliveryId}.${raw}`)}`;
}

function githubHeaders(raw, deliveryId, timestamp = String(Math.floor(Date.now() / 1000)), secret = SECRET) {
  return {
    'x-github-event': 'push',
    'x-github-delivery': deliveryId,
    'x-github-timestamp': timestamp,
    'x-hub-signature-256': githubSig(raw, deliveryId, timestamp, secret)
  };
}

function slackSig(raw, timestamp = NOW_SEC, secret = SECRET) {
  return `v0=${hmac(secret, `v0:${timestamp}:${raw}`)}`;
}

function emailSig(raw, deliveryId, timestamp = NOW_SEC, secret = SECRET) {
  return `sha256=${hmac(secret, `${timestamp}.${deliveryId}.${raw}`)}`;
}

function tempHost() {
  const dir = mkdtempSync(join(tmpdir(), 'event-routine-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const runs = [];
  const host = {
    store,
    stateDir: dir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    cronStore: undefined,
    setCronStore(next) {
      this.cronStore = next;
    },
    runSession: async (sessionId) => {
      runs.push(sessionId);
      return store.getSession(sessionId);
    },
    selfHeal: { processRuns: async () => {} },
    swarmExecutor: { tick: async () => {} },
    orchestrationEngine: { tick: async () => {} },
    autonomousScheduler: { tick: async () => {} }
  };
  const session = store.createSession({
    title: 'event',
    mode: 'chat',
    agentId: 'general',
    background: false
  });
  return { dir, store, host, runs, session };
}

function userText(store, sessionId) {
  return store
    .listMessages(sessionId)
    .filter((message) => message.role === 'user')
    .map((message) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .join('\n');
}

function addJob(host, session, patch) {
  return createCronJob(host, {
    sessionId: session.id,
    name: patch.name ?? 'on event',
    prompt: patch.prompt ?? '总结这次事件',
    event: patch.event,
    secretEnv: SECRET_ENV,
    ...(patch.precheck !== undefined ? { precheck: patch.precheck } : {})
  });
}

test('signature helpers accept a matching HMAC and reject a bad or stale one', () => {
  const raw = '{"ref":"refs/heads/main"}';
  const github = {
    rawBody: raw,
    secret: SECRET,
    deliveryId: 'delivery-sig',
    timestamp: NOW_SEC,
    signature: githubSig(raw, 'delivery-sig', NOW_SEC),
    nowMs: NOW
  };
  assert.equal(verifyGithubSignature(github), true);
  assert.equal(verifyGithubSignature({ ...github, signature: 'sha256=deadbeef' }), false);
  assert.equal(verifyGithubSignature({ ...github, signature: githubSig(raw, 'delivery-sig', NOW_SEC, 'other') }), false);
  assert.equal(verifyGithubSignature({ ...github, secret: '', signature: githubSig(raw, 'delivery-sig', NOW_SEC, '') }), false);
  assert.equal(verifyGithubSignature({ ...github, signature: `sha256=${hmac(SECRET, raw)}` }), false);
  assert.equal(verifyGithubSignature({ ...github, deliveryId: 'delivery-other' }), false);
  assert.equal(verifyGithubSignature({ ...github, nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS }), true);
  assert.equal(verifyGithubSignature({ ...github, nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS + 1 }), false);
  assert.doesNotThrow(() => verifyGithubSignature({ rawBody: raw, secret: SECRET, signature: 'nope' }));

  const slack = {
    rawBody: raw,
    secret: SECRET,
    timestamp: NOW_SEC,
    signature: slackSig(raw),
    nowMs: NOW
  };
  assert.equal(verifySlackSignature(slack), true);
  assert.equal(verifySlackSignature({ ...slack, signature: 'v0=deadbeef' }), false);
  assert.equal(
    verifySlackSignature({ ...slack, nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS }),
    true
  );
  assert.equal(
    verifySlackSignature({ ...slack, nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS + 1 }),
    false
  );

  const email = {
    rawBody: raw,
    secret: SECRET,
    deliveryId: 'email-sig',
    timestamp: NOW_SEC,
    signature: emailSig(raw, 'email-sig'),
    nowMs: NOW
  };
  assert.equal(verifyEmailSignature(email), true);
  assert.equal(verifyEmailSignature({ ...email, signature: `sha256=${hmac(SECRET, raw)}` }), false);
  assert.equal(verifyEmailSignature({ ...email, signature: `sha256=${hmac(SECRET, `${NOW_SEC}.${raw}`)}` }), false);
  assert.equal(verifyEmailSignature({ ...email, signature: emailSig(raw, 'email-other') }), false);
  assert.equal(verifyEmailSignature({ ...email, deliveryId: 'email-other' }), false);
  assert.equal(verifyEmailSignature({ ...email, deliveryId: undefined }), false);
  assert.equal(verifyEmailSignature({ ...email, signature: githubSig(raw, 'email-sig', NOW_SEC) }), true);
  assert.equal(verifyEmailSignature({ ...email, signature: githubSig(raw, 'delivery-sig', NOW_SEC) }), false);
  assert.equal(verifyEmailSignature({ ...email, timestamp: String(Number(NOW_SEC) - 301), nowMs: NOW }), false);
});

test('event jobs are not fired by the cron tick', async () => {
  const { store, host, runs, session } = tempHost();
  const job = addJob(host, session, { event: 'github/push', name: 'tick' });
  host.cronStore.update(job.id, { nextRunAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(host.cronStore.dueJobs().some((item) => item.id === job.id), false);
  await tickCronJobs(host);
  assert.deepEqual(runs, []);
  assert.equal(userText(store, session.id), '');
  store.db.close();
});

test('bad signature does not call runSession', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push' });
  const raw = JSON.stringify({ note: 'ignore me' });
  const result = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: {
      ...githubHeaders(raw, 'delivery-bad-sig'),
      'x-hub-signature-256': 'sha256=deadbeef'
    },
    claimDelivery: claimInboundEvent
  });
  assert.equal(result.outcomes[0]?.status, 'rejected');
  assert.equal(result.outcomes[0]?.reason, 'bad_signature');
  assert.deepEqual(runs, []);
  assert.equal(userText(store, session.id), '');
  store.db.close();
});

test('good signature with wakeAgent false does not call runSession', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, {
    event: 'github/push',
    precheck: { kind: 'predicate', source: '{"wakeAgent":false}' }
  });
  const raw = JSON.stringify({ note: 'unchanged' });
  const result = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: githubHeaders(raw, 'delivery-quiet'),
    claimDelivery: claimInboundEvent
  });
  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.deepEqual(runs, []);
  assert.equal(userText(store, session.id), '');
  store.db.close();
});

test('good signature wakes and the user message fences the event', async () => {
  const { dir, store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push', prompt: '总结这次推送' });
  const raw = JSON.stringify({ note: 'unique-push-note' });
  const result = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: githubHeaders(raw, 'delivery-wake'),
    claimDelivery: claimInboundEvent
  });
  assert.equal(result.outcomes[0]?.status, 'woke');
  assert.equal(runs.length,1);
  assert.notEqual(runs[0],session.id);
  const text = runs.map(id=>userText(store,id)).join('\n');
  const fenceAt = text.indexOf('«external source=event label=github/push»');
  const fenceEnd = text.indexOf('«end external»');
  assert.ok(fenceAt > 0);
  assert.ok(fenceEnd > fenceAt);
  assert.match(text.slice(0, fenceAt), /总结这次推送/);
  assert.match(text.slice(fenceAt, fenceEnd), /unique-push-note/);
  const saved = readFileSync(join(dir, 'cron', 'jobs.json'), 'utf8');
  assert.equal(saved.includes(SECRET), false);
  assert.match(saved, /PPENG_TEST_EVENT_SECRET/);
  store.db.close();
});

test('the same delivery id is a duplicate the second time', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push' });
  const raw = JSON.stringify({ note: 'once' });
  const input = {
    provider: 'github',
    rawBody: raw,
    headers: githubHeaders(raw, 'delivery-dup'),
    claimDelivery: claimInboundEvent
  };
  const first = await acceptEventRoutine(host, input);
  const second = await acceptEventRoutine(host, input);
  assert.equal(first.outcomes[0]?.status, 'woke');
  assert.equal(second.outcomes[0]?.status, 'duplicate');
  assert.equal(runs.length,1);
  assert.notEqual(runs[0],session.id);
  assert.equal(store.listMessages(runs[0]).filter((message) => message.role === 'user').length, 1);
  assert.equal(store.listMessages(session.id).filter((message) => message.role === 'user').length, 0);
  store.db.close();
});

test('script precheck reads the event file and the JSON is not spliced into the shell', async () => {
  const { dir, store, host, runs, session } = tempHost();
  const sentinel = join(dir, 'pwned-sentinel');
  const source = `node -e 'const fs=require("node:fs"); const p=process.env.${EVENT_PRECHECK_FILE_ENV}; if(!p||p.includes("{")) process.exit(2); if(process.env.${SECRET_ENV}) process.exit(5); const raw=fs.readFileSync(p,"utf8"); if(!raw.includes("shell-meta")) process.exit(3); process.stdout.write("{\\"wakeAgent\\":false}\\n")'`;
  assert.equal(source.includes(sentinel), false);
  assert.equal(source.includes('touch '), false);
  const job = addJob(host, session, {
    event: 'github/push',
    name: 'script gate',
    precheck: { kind: 'script', source }
  });
  const raw = JSON.stringify({ note: `shell-meta'; touch ${sentinel}; echo '` });
  const result = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: githubHeaders(raw, 'delivery-script'),
    claimDelivery: claimInboundEvent
  });
  assert.equal(result.outcomes[0]?.status, 'skipped');
  assert.deepEqual(runs, []);
  assert.equal(existsSync(sentinel), false);
  assert.equal(host.cronStore.get(job.id).metadata.precheck.source, source);
  store.db.close();
});

function routineRowCount(store) {
  const table = store.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'bot_routine_runs'")
    .get();
  if (!table.n) return 0;
  return store.db.prepare('SELECT COUNT(*) AS n FROM bot_routine_runs').get().n;
}

test('换掉 GitHub 投递号并复用原签名时不会再次入队 [AC:github-webhook-replay#AC-1] [AC:github-webhook-replay#AC-3] [AC:email-webhook-replay#AC-6]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push' });
  const raw = JSON.stringify({ note: 'replay-body' });
  const deliveryA = 'delivery-original';
  const signature = githubSig(raw, deliveryA, NOW_SEC);
  const headers = {
    'x-github-event': 'push',
    'x-github-delivery': deliveryA,
    'x-github-timestamp': NOW_SEC,
    'x-hub-signature-256': signature
  };
  const first = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers,
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const replay = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: { ...headers, 'x-github-delivery': 'delivery-swapped' },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const refreshed = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: {
      ...headers,
      'x-github-delivery': 'delivery-swapped-fresh-time',
      'x-github-timestamp': String(Number(NOW_SEC) + 1)
    },
    nowMs: NOW + 1000,
    claimDelivery: claimInboundEvent
  });
  const bodyOnly = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: raw,
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-body-only',
      'x-github-timestamp': NOW_SEC,
      'x-hub-signature-256': `sha256=${hmac(SECRET, raw)}`
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  assert.equal(first.outcomes[0]?.status, 'woke');
  assert.equal(replay.outcomes[0]?.status, 'rejected');
  assert.equal(replay.outcomes[0]?.reason, 'bad_signature');
  assert.equal(refreshed.outcomes[0]?.status, 'rejected');
  assert.equal(bodyOnly.outcomes[0]?.status, 'rejected');
  assert.equal(runs.length, 1);
  assert.equal(routineRowCount(store), 1);
  store.db.close();
});

test('超过几分钟的 GitHub 投递不会入队 [AC:github-webhook-replay#AC-2]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push' });
  const freshRaw = JSON.stringify({ note: 'fresh-body' });
  const fresh = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: freshRaw,
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-fresh',
      'x-github-timestamp': NOW_SEC,
      'x-hub-signature-256': githubSig(freshRaw, 'delivery-fresh', NOW_SEC)
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const staleRaw = JSON.stringify({ note: 'stale-body' });
  const staleTs = String(Number(NOW_SEC) - 301);
  const stale = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: staleRaw,
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-stale',
      'x-github-timestamp': staleTs,
      'x-hub-signature-256': githubSig(staleRaw, 'delivery-stale', staleTs)
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const edgeRaw = JSON.stringify({ note: 'edge-body' });
  const edge = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: edgeRaw,
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-edge',
      'x-github-timestamp': NOW_SEC,
      'x-hub-signature-256': githubSig(edgeRaw, 'delivery-edge', NOW_SEC)
    },
    nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS,
    claimDelivery: claimInboundEvent
  });
  const pastRaw = JSON.stringify({ note: 'past-window' });
  const past = await acceptEventRoutine(host, {
    provider: 'github',
    rawBody: pastRaw,
    headers: {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-past',
      'x-github-timestamp': NOW_SEC,
      'x-hub-signature-256': githubSig(pastRaw, 'delivery-past', NOW_SEC)
    },
    nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS + 1,
    claimDelivery: claimInboundEvent
  });
  assert.equal(fresh.outcomes[0]?.status, 'woke');
  assert.equal(stale.outcomes[0]?.status, 'rejected');
  assert.equal(stale.outcomes[0]?.reason, 'bad_signature');
  assert.equal(edge.outcomes[0]?.status, 'woke');
  assert.equal(past.outcomes[0]?.status, 'rejected');
  assert.equal(runs.length, 2);
  assert.equal(routineRowCount(store), 2);
  store.db.close();
});

test('slack and email wake on a good signature and stay quiet when the timestamp is stale [AC:github-webhook-replay#AC-4]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'slack/message', name: 'slack' });
  addJob(host, session, { event: 'email/received', name: 'email' });
  const slackBody = JSON.stringify({ type: 'event_callback', event_id: 'Ev-slack-1', event: { type: 'message', text: 'hi' } });
  const slackOk = await acceptEventRoutine(host, {
    provider: 'slack',
    rawBody: slackBody,
    headers: {
      'x-slack-request-timestamp': NOW_SEC,
      'x-slack-signature': slackSig(slackBody)
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const staleBody = JSON.stringify({ type: 'event_callback', event_id: 'Ev-slack-stale', event: { type: 'message', text: 'old' } });
  const slackStale = await acceptEventRoutine(host, {
    provider: 'slack',
    rawBody: staleBody,
    headers: {
      'x-slack-request-timestamp': String(Number(NOW_SEC) - 301),
      'x-slack-signature': slackSig(staleBody, String(Number(NOW_SEC) - 301))
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const emailBody = JSON.stringify({ subject: 'invoice', deliveryId: 'email-1' });
  const emailOk = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: emailBody,
    headers: {
      'x-ppeng-timestamp': NOW_SEC,
      'x-ppeng-signature': emailSig(emailBody, 'email-1'),
      'x-ppeng-delivery': 'email-1'
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const emailStaleBody = JSON.stringify({ subject: 'old-invoice', deliveryId: 'email-stale' });
  const emailStaleTs = String(Number(NOW_SEC) - 301);
  const emailStale = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: emailStaleBody,
    headers: {
      'x-ppeng-timestamp': emailStaleTs,
      'x-ppeng-signature': emailSig(emailStaleBody, 'email-stale', emailStaleTs),
      'x-ppeng-delivery': 'email-stale'
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  assert.equal(slackOk.outcomes[0]?.status, 'woke');
  assert.equal(slackStale.outcomes[0]?.status, 'rejected');
  assert.equal(emailOk.outcomes[0]?.status, 'woke');
  assert.equal(emailStale.outcomes[0]?.status, 'rejected');
  assert.equal(runs.length,2);assert.ok(runs.every(id=>id!==session.id));assert.notEqual(runs[0],runs[1]);
  const text = runs.map(id=>userText(store,id)).join('\n');
  assert.match(text, /«external source=event label=slack\/message»/);
  assert.match(text, /«external source=event label=email\/received»/);
  store.db.close();
});

test('5 分钟内换邮件投递号并复用原签名时不会再跑一轮 [AC:email-webhook-replay#AC-1] [AC:email-webhook-replay#AC-2]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'email/received' });
  const raw = JSON.stringify({ subject: 'invoice', deliveryId: 'email-original' });
  const deliveryA = 'email-original';
  const signature = emailSig(raw, deliveryA, NOW_SEC);
  const headers = {
    'x-ppeng-timestamp': NOW_SEC,
    'x-ppeng-signature': signature,
    'x-ppeng-delivery': deliveryA
  };
  const withinWindow = NOW + 4 * 60 * 1000;
  const first = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers,
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const replay = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: { ...headers, 'x-ppeng-delivery': 'email-swapped' },
    nowMs: withinWindow,
    claimDelivery: claimInboundEvent
  });
  const edge = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: { ...headers, 'x-ppeng-delivery': 'email-swapped-edge' },
    nowMs: NOW + EVENT_SIGNATURE_WINDOW_MS,
    claimDelivery: claimInboundEvent
  });
  const freshDelivery = 'email-fresh';
  const second = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: {
      'x-ppeng-timestamp': NOW_SEC,
      'x-ppeng-signature': emailSig(raw, freshDelivery, NOW_SEC),
      'x-ppeng-delivery': freshDelivery
    },
    nowMs: withinWindow,
    claimDelivery: claimInboundEvent
  });
  assert.equal(first.outcomes[0]?.status, 'woke');
  assert.equal(replay.outcomes[0]?.status, 'rejected');
  assert.equal(replay.outcomes[0]?.reason, 'bad_signature');
  assert.equal(edge.outcomes[0]?.status, 'rejected');
  assert.equal(edge.outcomes[0]?.reason, 'bad_signature');
  assert.equal(second.outcomes[0]?.status, 'woke');
  assert.equal(runs.length, 2);
  assert.equal(routineRowCount(store), 2);
  store.db.close();
});

test('签名没覆盖投递号的邮件不会跑 [AC:email-webhook-replay#AC-3]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'email/received' });
  const raw = JSON.stringify({ subject: 'invoice', deliveryId: 'email-uncovered' });
  const uncovered = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: {
      'x-ppeng-timestamp': NOW_SEC,
      'x-ppeng-signature': `sha256=${hmac(SECRET, `${NOW_SEC}.${raw}`)}`,
      'x-ppeng-delivery': 'email-uncovered'
    },
    nowMs: NOW + 60 * 1000,
    claimDelivery: claimInboundEvent
  });
  assert.equal(uncovered.outcomes[0]?.status, 'rejected');
  assert.equal(uncovered.outcomes[0]?.reason, 'bad_signature');
  assert.deepEqual(runs, []);
  assert.equal(routineRowCount(store), 0);
  store.db.close();
});

test('正文里的投递号换一个再投递时不会再跑一轮 [AC:email-webhook-replay#AC-4]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'email/received' });
  const deliveryA = 'email-from-body';
  const raw = JSON.stringify({ subject: 'invoice', deliveryId: deliveryA });
  const signature = emailSig(raw, deliveryA, NOW_SEC);
  const first = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: {
      'x-ppeng-timestamp': NOW_SEC,
      'x-ppeng-signature': signature
    },
    nowMs: NOW,
    claimDelivery: claimInboundEvent
  });
  const replay = await acceptEventRoutine(host, {
    provider: 'email',
    rawBody: raw,
    headers: {
      'x-ppeng-timestamp': NOW_SEC,
      'x-ppeng-signature': signature,
      'x-ppeng-delivery': 'email-header-swapped'
    },
    nowMs: NOW + 4 * 60 * 1000,
    claimDelivery: claimInboundEvent
  });
  assert.equal(first.outcomes[0]?.status, 'woke');
  assert.equal(replay.outcomes[0]?.status, 'rejected');
  assert.equal(replay.outcomes[0]?.reason, 'bad_signature');
  assert.equal(runs.length, 1);
  assert.equal(routineRowCount(store), 1);
  store.db.close();
});

test('Slack 仍按原来的签名在 5 分钟内执行一次 [AC:email-webhook-replay#AC-5]', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'slack/message' });
  const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev-slack-keep', event: { type: 'message', text: 'hi' } });
  const woke = await acceptEventRoutine(host, {
    provider: 'slack',
    rawBody: raw,
    headers: {
      'x-slack-request-timestamp': NOW_SEC,
      'x-slack-signature': slackSig(raw)
    },
    nowMs: NOW + 4 * 60 * 1000,
    claimDelivery: claimInboundEvent
  });
  assert.equal(woke.outcomes[0]?.status, 'woke');
  assert.equal(runs.length, 1);
  assert.equal(verifySlackSignature({
    rawBody: raw,
    secret: SECRET,
    timestamp: NOW_SEC,
    signature: `v0=${hmac(SECRET, `v0:${NOW_SEC}:${raw}`)}`,
    nowMs: NOW
  }), true);
  store.db.close();
});

function gatewayCall(ctx, { path, body, headers = {} }) {
  const text = JSON.stringify(body);
  const req = Readable.from([Buffer.from(text)]);
  req.method = 'POST';
  req.url = `/gateway/v1${path}`;
  req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    }
  };
  return handleGatewayHttp(req, res, ctx).then((handled) => ({
    handled,
    status: res.statusCode,
    json: res.body ? JSON.parse(res.body) : undefined
  }));
}

test('gateway ingress verifies GitHub without the bearer token and does not double-run a delivery', async () => {
  const { store, host, runs, session } = tempHost();
  addJob(host, session, { event: 'github/push', prompt: '看推送' });
  const ctx = {
    runtime: {
      store,
      runSession: (sessionId) => host.runSession(sessionId)
    },
    repoRoot: host.stateDir,
    stateDir: host.stateDir,
    env: {
      enabled: true,
      pathPrefix: '/gateway/v1',
      learnEnabled: false,
      learnDailyHourUtc: 6,
      authToken: 'gateway-token'
    },
    fileConfigRef: { current: {} }
  };
  const raw = { zen: 'fenced-from-http' };
  const rawText = JSON.stringify(raw);
  const healthReq = Readable.from([]);
  healthReq.method = 'GET';
  healthReq.url = '/gateway/v1/health';
  healthReq.headers = {};
  const healthRes = {
    statusCode: 200,
    body: '',
    setHeader() {},
    end(chunk) {
      if (chunk) this.body += chunk;
    }
  };
  await handleGatewayHttp(healthReq, healthRes, ctx);
  assert.equal(healthRes.statusCode, 401);

  const bad = await gatewayCall(ctx, {
    path: '/routines/github',
    body: raw,
    headers: {
      ...githubHeaders(rawText, 'gw-bad'),
      'x-hub-signature-256': 'sha256=nope'
    }
  });
  assert.equal(bad.handled, true);
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'bad_signature');
  assert.deepEqual(runs, []);

  const ok = await gatewayCall(ctx, {
    path: '/routines/github',
    body: raw,
    headers: githubHeaders(rawText, 'gw-ok')
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.wakeAgent, true);
  assert.equal(runs.length,1);
  assert.notEqual(runs[0],session.id);
  assert.match(userText(store, runs[0]), /«external source=event label=github\/push»/);

  const again = await gatewayCall(ctx, {
    path: '/routines/github',
    body: raw,
    headers: githubHeaders(rawText, 'gw-ok')
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(runs.length,1);
  assert.notEqual(runs[0],session.id);
  store.db.close();
});

test('gateway capacity rejection is retryable and the same delivery succeeds without duplicating accepted work [AC:bot-routine-lifecycle#AC-3]',async()=>{
 const {RoutineRunStore,cancelRoutineRun}=await import('../dist/cron/routine-runtime.js');const {updateBotWorkSettings}=await import('../dist/bots/bot-work.js');
 const {store,host,runs,session}=tempHost();updateBotWorkSettings(store,{perBot:1,perPrincipal:1});
 const blockerJob=createCronJob(host,{sessionId:session.id,name:'accepted first',prompt:'must remain accepted',intervalMs:60000});const ledger=new RoutineRunStore(store);const blocker=ledger.enqueue(blockerJob,new Date().toISOString());
 const event=addJob(host,session,{event:'github/push',prompt:'process once'});
 host.runSession=async(id)=>{runs.push(id);store.appendMessage(id,'assistant',[{type:'text',text:'event completed'}]);return store.getSession(id)};
 const ctx={runtime:{store,runSession:(id)=>host.runSession(id)},repoRoot:host.stateDir,stateDir:host.stateDir,env:{enabled:true,pathPrefix:'/gateway/v1',learnEnabled:false,learnDailyHourUtc:6,authToken:'gateway-token'},fileConfigRef:{current:{}}};
 const body={note:'retry after backpressure'},text=JSON.stringify(body);const request={path:'/routines/github',body,headers:githubHeaders(text,'gw-capacity-retry')};
 const full=await gatewayCall(ctx,request);assert.equal(full.status,429);assert.equal(full.json.retryable,true);assert.equal(full.json.outcomes[0].status,'queue_full');assert.equal(ledger.get(blocker.id).status,'queued');assert.equal(ledger.get(blocker.id).job.prompt,'must remain accepted');assert.deepEqual(runs,[]);assert.equal(ledger.list(event.id).length,0);
 await cancelRoutineRun(host,blocker.id);
 const accepted=await gatewayCall(ctx,request);await new Promise(r=>setImmediate(r));assert.equal(accepted.status,200);assert.equal(accepted.json.duplicate,false);assert.equal(accepted.json.wakeAgent,true);assert.equal(runs.length,1);assert.equal(ledger.list(event.id)[0].status,'completed');
 const repeated=await gatewayCall(ctx,request);assert.equal(repeated.status,200);assert.equal(repeated.json.duplicate,true);assert.equal(runs.length,1);assert.equal(ledger.list(event.id).length,1);store.db.close();
});

test('non-SQLite event hosts retain signature, precheck, dedupe and idle wake compatibility',async()=>{
 const {CronJobStore}=await import('../dist/cron/cron-store.js');const dir=mkdtempSync(join(tmpdir(),'event-legacy-'));const cronStore=new CronJobStore(dir);const sessions=new Map([['legacy',{id:'legacy',status:'idle'}]]);let calls=0;const messages=[];
 const host={stateDir:dir,cronStore,setCronStore(){},log:{warn(){}},store:{getSession:id=>sessions.get(id),appendMessage:(...args)=>messages.push(args)},runSession:async()=>{calls++}};
 const base={sessionId:'legacy',agentId:'general',name:'legacy',prompt:'handle',scheduleKind:'event',scheduleValue:'github/push',metadata:{secretEnv:SECRET_ENV}};
 const job=cronStore.create(base);const raw='{"legacy":"private"}';const claimed=new Set();let delivery=0;const input=()=>({provider:'github',rawBody:raw,headers:githubHeaders(raw,String(delivery)),env:{[SECRET_ENV]:SECRET},claimDelivery(key){if(claimed.has(key))return false;claimed.add(key);return true}});
 assert.equal((await acceptEventRoutine(host,input())).outcomes[0].status,'woke');await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(messages.length,1);assert.equal((await acceptEventRoutine(host,input())).outcomes[0].status,'duplicate');
 delivery++;sessions.set('legacy',{id:'legacy',status:'waiting_approval'});assert.equal((await acceptEventRoutine(host,input())).outcomes[0].status,'not_idle');assert.equal(calls,1);
 cronStore.update(job.id,{metadata:{...job.metadata,precheck:{kind:'script',source:'node -e \'const fs=require("node:fs");if(!fs.readFileSync(process.env.PPENG_EVENT_FILE,"utf8").includes("private"))process.exit(1);console.log(JSON.stringify({wakeAgent:false}))\''}}});delivery++;assert.equal((await acceptEventRoutine(host,input())).outcomes[0].status,'skipped');
 cronStore.update(job.id,{metadata:job.metadata});sessions.delete('legacy');delivery++;assert.equal((await acceptEventRoutine(host,input())).outcomes[0].status,'missing_session');assert.equal(cronStore.get(job.id).enabled,false);
});

test('generic JSON webhook validates per-routine vault HMAC, freshness and durable replay [AC:bot-routine-lifecycle#AC-9]', async () => {
  const { SecretVault } = await import('../dist/secrets/secret-vault.js');
  const { RoutineRunStore } = await import('../dist/cron/routine-runtime.js');
  const { store, host, session } = tempHost();
  const secretEnv = 'ROUTINE_VAULT_SECRET';
  new SecretVault(store).set(secretEnv, SECRET);
  const job = createCronJob(host, {sessionId:session.id,name:'generic',prompt:'read',event:'webhook/generic',secretEnv});
  const other = createCronJob(host, {sessionId:session.id,name:'other',prompt:'read',event:'webhook/generic',secretEnv:'OTHER_VAULT_SECRET'});
  new SecretVault(store).set('OTHER_VAULT_SECRET', 'other-secret');
  const rawBody = '[null,42,{"text":"any JSON"}]';
  const send = (id, timestamp=NOW_SEC, signature=emailSig(rawBody,id,timestamp)) => acceptEventRoutine(host,{provider:'webhook',rawBody,headers:{'x-ppeng-delivery':id,'x-ppeng-timestamp':timestamp,'x-ppeng-signature':signature},nowMs:NOW,env:{},claimDelivery:()=>true});
  assert.equal((await send('bad',NOW_SEC,'sha256=bad')).outcomes[0].status,'rejected');
  assert.equal((await send('stale',String(Number(NOW_SEC)-301))).outcomes[0].status,'rejected');
  assert.equal((await send('future',String(Number(NOW_SEC)+301))).outcomes[0].status,'rejected');
  const accepted = await send('valid');
  assert.equal(accepted.outcomes.find(x=>x.jobId===job.id).status,'woke');
  assert.equal(accepted.outcomes.find(x=>x.jobId===other.id).status,'rejected');
  assert.equal((await send('valid')).outcomes[0].status,'duplicate');
  assert.equal((await send('changed',NOW_SEC,emailSig(rawBody,'valid'))).outcomes[0].status,'rejected');
  assert.equal(new RoutineRunStore(store).list(job.id).length,1);
  await new Promise(r=>setImmediate(r));store.db.close();
});

test('CI only accepts completed check/workflow/status events matching conclusions [AC:bot-routine-lifecycle#AC-9]', async () => {
  const { store, host, session } = tempHost();
  const job=createCronJob(host,{sessionId:session.id,name:'ci',prompt:'review',event:'ci/status',secretEnv:SECRET_ENV,conclusions:['failure']});
  let index=0;
  for(const event of ['check_run','workflow_run','status']){
    for(const conclusion of ['success','failure','pending']){
      const body=event==='status'?{state:conclusion}:{action:conclusion==='pending'?'in_progress':'completed',[event]:{status:conclusion==='pending'?'in_progress':'completed',conclusion}};
      const rawBody=JSON.stringify(body);
      const result=await acceptEventRoutine(host,{provider:'github',rawBody,headers:{...githubHeaders(rawBody,`ci-${index++}`,NOW_SEC),'x-github-event':event},nowMs:NOW,claimDelivery:()=>true});
      assert.equal(result.outcomes.some(x=>x.jobId===job.id&&x.status==='woke'),conclusion==='failure');
      await new Promise(r=>setImmediate(r));
    }
  }
  store.db.close();
});

test('daemon gateway delivers signed generic and CI routines without bearer auth [AC:bot-routine-lifecycle#AC-9]',async()=>{
 const {SecretVault}=await import('../dist/secrets/secret-vault.js');
 const {store,host,session}=tempHost();new SecretVault(store).set('HTTP_ROUTINE_SECRET',SECRET);
 createCronJob(host,{sessionId:session.id,name:'generic HTTP',prompt:'inspect',event:'webhook/generic',secretEnv:'HTTP_ROUTINE_SECRET'});
 createCronJob(host,{sessionId:session.id,name:'CI HTTP',prompt:'inspect',event:'ci/status',secretEnv:'HTTP_ROUTINE_SECRET',conclusions:['success']});
 const ctx={runtime:{store,runSession:id=>host.runSession(id)},repoRoot:host.stateDir,stateDir:host.stateDir,env:{enabled:true,pathPrefix:'/gateway/v1',learnEnabled:false,learnDailyHourUtc:6,authToken:'gateway-token'},fileConfigRef:{current:{}}};
 const body=[1,null,'payload'],raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
 const request={path:'/routines/webhook',body,headers:{'x-ppeng-delivery':'generic-http','x-ppeng-timestamp':timestamp,'x-ppeng-signature':emailSig(raw,'generic-http',timestamp)}};
 assert.equal((await gatewayCall(ctx,{...request,headers:{...request.headers,'x-ppeng-signature':'sha256=bad'}})).status,401);
 assert.equal((await gatewayCall(ctx,request)).json.wakeAgent,true);
 assert.equal((await gatewayCall(ctx,request)).json.duplicate,true);
 const ci={action:'completed',check_run:{status:'completed',conclusion:'success'}};
 assert.equal((await gatewayCall(ctx,{path:'/routines/ci',body:ci,headers:{...githubHeaders(JSON.stringify(ci),'ci-http'),'x-github-event':'check_run'}})).json.wakeAgent,true);
 await new Promise(r=>setImmediate(r));store.db.close();
});

test('generic accepts scalar/null JSON and exact freshness boundary but rejects timestamp substitution [AC:bot-routine-lifecycle#AC-9]',async()=>{
 const {store,host,session}=tempHost();
 createCronJob(host,{sessionId:session.id,name:'any JSON',prompt:'inspect',event:'webhook/generic',secretEnv:SECRET_ENV});
 let n=0;
 for(const rawBody of ['null','42','"text"','true','{}']){
  const id=`scalar-${n++}`,timestamp=String(Number(NOW_SEC)-300);
  const input={provider:'webhook',rawBody,nowMs:NOW,headers:{'x-ppeng-delivery':id,'x-ppeng-timestamp':timestamp,'x-ppeng-signature':emailSig(rawBody,id,timestamp)},claimDelivery:()=>true};
  assert.equal((await acceptEventRoutine(host,{...input,headers:{...input.headers,'x-ppeng-timestamp':NOW_SEC}})).outcomes[0].status,'rejected');
  assert.equal((await acceptEventRoutine(host,input)).outcomes[0].status,'woke');await new Promise(r=>setImmediate(r));
 }
 for(const rawBody of ['', 'not json'])assert.equal((await acceptEventRoutine(host,{provider:'webhook',rawBody,headers:{},claimDelivery:()=>true})).error,'invalid_json');
 store.db.close();
});
