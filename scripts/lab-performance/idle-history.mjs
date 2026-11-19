import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteStateStore } from '../../packages/core/dist/storage.js';
import { resolveBotPrincipal, setBotDefinitionOwner } from '../../packages/core/dist/bots/bot-identity.js';
import { tickBotGoals } from '../../packages/core/dist/bots/goals/scheduler.js';
import { DaydreamHost } from '../../packages/core/dist/runtime/daydream-host.js';

const BOTS = 64;
const GOALS = 4;
const DAYS = 8;
const ROUNDS = 3;
const ARCHIVE_MARKER = 'LAB_FIXTURE_ARCHIVED_EVIDENCE_7KQ';
const EVIDENCE = ARCHIVE_MARKER + ' Synthetic archived observation.'.repeat(200);
const DAY_MS = 86_400_000;

function utcDay(now, offset) {
  return new Date(now + offset * DAY_MS).toISOString().slice(0, 10);
}

function seedGoals(store, botId, sessionId, timestamp) {
  const goals = Array.from({ length: GOALS }, (_, i) => ({
    id: botId + '-goal-' + i, botId, sessionId, title: 'Completed task ' + i, objective: 'Inspect a synthetic record',
    status: 'completed', revision: 1, priority: 0, attempts: 2, createdAt: timestamp, updatedAt: timestamp,
    constraints: [], completionCriteria: [], resources: [], progress: '', evidence: [], budgetUsd: 1, costUsd: 0, noProgress: 0
  }));
  const executions = goals.flatMap(goal => [1, 2].map(fence => ({
    id: goal.id + '-attempt-' + fence, goalId: goal.id, goalRevision: 1, owner: botId, strategy: 'direct',
    status: 'finished', sessionId, fence, leaseUntil: 0, safeToRetry: false, startedAt: timestamp, endedAt: timestamp
  })));
  const events = goals.map(goal => ({ id: 'report-' + goal.id, type: 'reported', goalId: goal.id, at: timestamp, detail: EVIDENCE }));
  store.setDaemonControl('bot_goals:' + botId, { goals, executions, events, processed: [], fence: 2 });
  for (const goal of goals) store.setDaemonControl('bot.goal-notice:' + goal.id, '1:completed:');
}

function seedDays(insert, botId, sessionId, tenantId, now) {
  // Include today so a run crossing UTC midnight still has seven completed automatic dates.
  for (let offset = 1 - DAYS; offset <= 0; offset++) {
    const date = utcDay(now, offset);
    const timestamp = date + 'T00:00:00.000Z';
    const id = botId + '-review-' + date;
    const inputs = Array.from({ length: 12 }, (_, i) => ({
      sessionId, messageId: id + '-message-' + i, role: 'user', createdAt: timestamp, content: EVIDENCE
    }));
    const run = { id, botId, tenantId, date, timezone: 'UTC', status: 'completed', checkpoint: inputs.length,
      inputs, outputs: [], createdAt: timestamp, updatedAt: timestamp };
    insert.run(id, botId, tenantId ?? null, date, botId + ':' + date, JSON.stringify(run));
  }
}

/** Adds the fixed workload to an isolated runtime. The returned Bot/session pairs can also drive the Lab browser scenario. */
export function seedIdleHistory(runtime, { now = Date.now(), principal = {} } = {}) {
  const { store } = runtime;
  assert.ok(runtime.daydream, 'the real daydream host initializes the run schema');
  const owner = resolveBotPrincipal(store, principal);
  const timestamp = new Date(now).toISOString();
  const botIds = [], sessionIds = [];
  const insert = store.db.prepare('INSERT INTO bot_daydream_runs(id,bot_id,tenant_id,date,dedupe,body) VALUES(?,?,?,?,?,?)');
  store.transaction(() => {
    for (let i = 0; i < BOTS; i++) {
      const id = 'synthetic-history-' + String(i).padStart(3, '0');
      const title = 'History Bot ' + String(i).padStart(3, '0');
      const session = store.createSession({ title, mode: 'chat', agentId: id, metadata: {
        ...owner, botId: id, canonicalBotChat: true
      } });
      store.createBot({ id, name: title, title, description: '', agentId: id, canonicalSessionId: session.id,
        hidden: false, createdAt: timestamp, updatedAt: timestamp });
      setBotDefinitionOwner(store, id, owner);
      store.setDaemonControl('bot_daydream:' + id, { enabled: true, timezone: 'UTC', dailyAt: '00:00', memoryPolicy: 'auto',
        skillPolicy: 'propose', collaborationEnabled: true, effectiveFrom: utcDay(now, -DAYS) + 'T00:00:00Z' });
      seedGoals(store, id, session.id, timestamp);
      seedDays(insert, id, session.id, owner.tenantId, now);
      botIds.push(id);
      sessionIds.push(session.id);
    }
  });
  return { botIds, sessionIds };
}

function isHistoryBody(value) {
  if (typeof value !== 'string') return false;
  if (value.includes(ARCHIVE_MARKER)) return true; // Also catches projections returning the archived evidence alone.
  if (!value.startsWith('{')) return false;
  return (value.includes('"goals":') && value.includes('"executions":')) ||
    (value.includes('"inputs":') && value.includes('"outputs":'));
}

/** Count complete records crossing the SQLite boundary, including batched, aliased and iterable SELECTs. */
function observeHistoryReads(db) {
  let fullReads = 0;
  const observe = row => {
    if (row && Object.values(row).some(isHistoryBody)) fullReads++;
    return row;
  };
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!/daemon_control|bot_daydream_runs/i.test(sql)) return statement;
    const get = statement.get.bind(statement), all = statement.all.bind(statement);
    statement.get = (...args) => observe(get(...args));
    statement.all = (...args) => {
      const rows = all(...args);
      rows.forEach(observe);
      return rows;
    };
    if (typeof statement.iterate === 'function') {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args) { for (const row of iterate(...args)) yield observe(row); };
    }
    return statement;
  };
  return () => fullReads;
}

function assertFixture(db, botIds) {
  assert.equal(botIds.length, BOTS);
  const bindings = db.prepare(`SELECT count(*) AS n FROM bots b JOIN sessions s ON s.id=b.canonical_session_id
    WHERE b.agent_id=b.id AND s.agent_id=b.id AND json_extract(s.metadata_json,'$.botId')=b.id`).get();
  assert.equal(bindings.n, BOTS, 'each seeded Bot must open its own real conversation');
  const goals = db.prepare("SELECT count(*) AS bots, sum(json_array_length(value_json,'$.goals')) AS goals, sum(json_array_length(value_json,'$.executions')) AS executions FROM daemon_control WHERE key GLOB 'bot_goals:*'").get();
  assert.deepEqual([goals.bots, goals.goals, goals.executions], [BOTS, BOTS * GOALS, BOTS * GOALS * 2]);
  const history = db.prepare("SELECT count(*) AS runs,sum(length(body)) AS bytes FROM bot_daydream_runs WHERE json_extract(body,'$.status')='completed'").get();
  assert.equal(history.runs, BOTS * DAYS);
  assert.ok(history.bytes >= 35 * 1024 ** 2, 'representative archived evidence is missing');
}

export function historyTickTimes(samples) {
  assert.equal(samples.length, ROUNDS, 'incomplete scheduler timing sample');
  const sorted = [...samples].sort((a, b) => a - b);
  assert.ok(sorted.every(ms => Number.isFinite(ms) && ms > 0), 'invalid scheduler timing sample');
  return {tickMedianMs: sorted[Math.floor(sorted.length / 2)], tickMaxMs: sorted.at(-1)};
}

async function measure(family, tick, readCount, changes) {
  await tick(); // Exclude initialization and cache warmup.
  const readsBefore = readCount(), writesBefore = changes();
  const samples = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    await tick();
    samples.push(performance.now() - start);
  }
  const {tickMedianMs, tickMaxMs} = historyTickTimes(samples);
  const prefix = 'history.' + family + '.';
  return [
    { name: prefix + 'fullReads', value: readCount() - readsBefore },
    { name: prefix + 'writes', value: changes() - writesBefore },
    { name: prefix + 'tickMedianMs', value: tickMedianMs },
    { name: prefix + 'tickMaxMs', value: tickMaxMs }
  ];
}

async function proveActiveWork(runtime, goalTick, botId, date) {
  const { store } = runtime;
  const key = 'bot_goals:' + botId;
  const snapshot = store.getDaemonControl(key);
  const goal = snapshot.goals[0];
  goal.status = 'blocked';
  goal.blockedReason = 'Synthetic verification';
  store.setDaemonControl(key, snapshot);
  await goalTick();
  assert.equal(store.getDaemonControl('bot.goal-notice:' + goal.id), '1:blocked:Synthetic verification',
    'goal polling must still deliver a real pending notice');

  const dedupe = botId + ':' + date;
  assert.equal(store.db.prepare('DELETE FROM bot_daydream_runs WHERE dedupe=?').run(dedupe).changes, 1);
  await runtime.daydream.tick();
  assert.equal(store.db.prepare("SELECT json_extract(body,'$.status') AS status FROM bot_daydream_runs WHERE dedupe=?").get(dedupe)?.status,
    'completed', 'daydream polling must still discover and finish a genuinely missing date');
}

async function withIdleRuntime(dir, run) {
  const store = new SqliteStateStore(join(dir, 'runtime.sqlite'));
  const readCount = observeHistoryReads(store.db);
  const runtime = { stateDir: dir, store, listBots: options => store.listBots(options) };
  try {
    runtime.daydream = new DaydreamHost(runtime);
    return await run(runtime, readCount);
  } finally {
    try { await runtime.daydream?.close(); } finally { store.db.close(); }
  }
}

/** Prepare the same on-disk workload before the real daemon opens it; the caller owns stateDir. */
export async function seedIdleDatabase(stateDir, initialize) {
  return withIdleRuntime(stateDir, runtime => initialize(runtime.store, seedIdleHistory(runtime)));
}

async function measureHistory(runtime, readCount) {
  const {store} = runtime;
  const now = Date.now();
  const { botIds } = seedIdleHistory(runtime, { now });
  assertFixture(store.db, botIds);
  const date = utcDay(now, -1);
  const before = readCount();
  store.getDaemonControl('bot_goals:' + botIds[0]);
  runtime.daydream.local.getRun(botIds[0], botIds[0] + '-review-' + date);
  store.db.prepare("SELECT json_extract(body,'$.inputs') AS evidence FROM bot_daydream_runs WHERE dedupe=?").get(botIds[0] + ':' + date);
  assert.equal(readCount() - before, 3, 'full records and projected archived evidence must be observable');

  const unexpected = () => { throw new Error('idle workload dispatched business work'); };
  const goalHost = { store, isRunning: () => false, cancel: unexpected, run: unexpected, capabilities: unexpected };
  const goalTick = () => tickBotGoals(goalHost);
  const total = store.db.prepare('SELECT total_changes() AS n');
  const changes = () => total.get().n;
  const goals = await measure('goal', goalTick, readCount, changes);
  const days = await measure('daydream', () => runtime.daydream.tick(), readCount, changes);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM daemon_control WHERE key GLOB 'daydream.lastError:*'").get().n, 0);
  await proveActiveWork(runtime, goalTick, botIds[0], date);
  return [...goals, ...days];
}

export async function runIdleHistory() {
  const dir = mkdtempSync(join(tmpdir(), 'lab-idle-history-'));
  try {
    return await withIdleRuntime(dir, measureHistory);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
