import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBot } from '../dist/bots/bot-facade.js';
import { assembleBotActivity, botActivityStatus, listSessionBotActivity } from '../dist/bots/bot-activity.js';
import { ensureRoutineSchema } from '../dist/cron/routine-runtime.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

function session(patch) {
  return {
    id: 'focus',
    title: 'Bot Chat · Ada',
    mode: 'chat',
    status: 'idle',
    agentId: 'ada',
    background: false,
    todo: [],
    metadata: { botId: 'ada', userId: 'u1', canonicalBotChat: true },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    ...patch,
    metadata: { botId: 'ada', userId: 'u1', canonicalBotChat: true, ...(patch.metadata ?? {}) }
  };
}

function routine(patch) {
  return {
    id: patch.id ?? 'run-1',
    routineId: 'job-1',
    scheduledAt: '2026-10-16T11:00:00.000Z',
    timezone: 'UTC',
    status: 'running',
    mainSessionId: 'focus',
    attempt: 1,
    missedCount: 0,
    createdAt: '2026-10-16T11:00:00.000Z',
    updatedAt: '2026-10-16T11:05:00.000Z',
    startedAt: '2026-10-16T11:01:00.000Z',
    job: {
      id: 'job-1',
      sessionId: 'focus',
      agentId: 'ada',
      name: 'Morning digest',
      prompt: 'do not surface this prompt',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' },
      ...(patch.job ?? {})
    },
    ...patch
  };
}

test('bot activity status maps to running, waiting, or done', () => {
  assert.equal(botActivityStatus('running'), 'running');
  for (const raw of ['queued', 'waiting_approval', 'unknown', 'pending']) {
    assert.equal(botActivityStatus(raw), 'waiting', raw);
  }
  for (const raw of ['completed', 'failed', 'cancelled', 'skipped', 'silent', 'error']) {
    assert.equal(botActivityStatus(raw), 'done', raw);
  }
});

test('assemble lists in-flight routines and background work for this bot', () => {
  const focus = session({});
  const worker = session({
    id: 'worker',
    title: 'Routine: Morning digest',
    metadata: { routineRunId: 'run-live', canonicalBotChat: false }
  });
  const teammate = session({
    id: 'mate',
    title: 'Teammate: research',
    mode: 'teammate',
    status: 'waiting_approval',
    parentSessionId: 'focus',
    background: true,
    createdAt: '2026-10-16T11:30:00.000Z',
    metadata: { canonicalBotChat: false }
  });
  const idle = session({
    id: 'idle-room',
    title: 'Idle room',
    background: true,
    metadata: { canonicalBotChat: false }
  });
  const stranger = session({
    id: 'stranger',
    metadata: { userId: 'other', canonicalBotChat: true }
  });
  const items = assembleBotActivity({
    focus,
    sessions: [focus, worker, teammate, idle, stranger],
    jobs: [
      {
        id: 'bg-1',
        sessionId: 'focus',
        command: 'npm test',
        status: 'running',
        createdAt: '2026-10-16T11:40:00.000Z',
        updatedAt: '2026-10-16T11:40:00.000Z'
      },
      {
        id: 'bg-old',
        sessionId: 'focus',
        command: 'old job',
        status: 'error',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z'
      }
    ],
    routines: [
      routine({ id: 'run-live', status: 'running', sessionId: 'worker', eventBody: 'secret-event-body' }),
      routine({
        id: 'run-wait',
        status: 'queued',
        startedAt: undefined,
        createdAt: '2026-10-16T11:10:00.000Z',
        job: { name: 'Queued sweep', metadata: { botId: 'ada' } }
      }),
      routine({
        id: 'run-done',
        status: 'completed',
        finishedAt: '2026-10-16T11:50:00.000Z',
        updatedAt: '2026-10-16T11:50:00.000Z',
        startedAt: '2026-10-16T11:45:00.000Z',
        job: { name: 'Just finished', metadata: { botId: 'ada' } }
      }),
      routine({
        id: 'run-old',
        status: 'failed',
        finishedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        job: { name: 'Ancient', metadata: { botId: 'ada' } }
      }),
      routine({
        id: 'run-other',
        status: 'running',
        mainSessionId: 'stranger',
        job: { name: 'Other user', sessionId: 'stranger', metadata: { botId: 'ada' } }
      })
    ],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW
  });

  assert.deepEqual(
    items.map((item) => [item.kind, item.status, item.title, item.botName]),
    [
      ['background', 'running', 'npm test', 'Ada'],
      ['routine', 'running', 'Morning digest', 'Ada'],
      ['background', 'waiting', 'Teammate: research', 'Ada'],
      ['routine', 'waiting', 'Queued sweep', 'Ada'],
      ['routine', 'done', 'Just finished', 'Ada']
    ]
  );
  const live = items.find((item) => item.title === 'Morning digest');
  assert.equal(live.startedAt, '2026-10-16T11:01:00.000Z');
  assert.equal(live.botId, 'ada');
  assert.equal(JSON.stringify(items).includes('secret-event-body'), false);
  assert.equal(JSON.stringify(items).includes('do not surface this prompt'), false);
  assert.equal(items.some((item) => item.title === 'Routine: Morning digest'), false);
  assert.equal(items.some((item) => item.title === 'Idle room' || item.title === 'Ancient' || item.title === 'old job' || item.title === 'Other user'), false);
});

test('listSessionBotActivity reads routine runs and background jobs', () => {
  const store = new SqliteStateStore(join(mkdtempSync(join(tmpdir(), 'bot-activity-')), 'state.db'));
  const host = {
    store,
    runImageRetention: async () => {},
    wakeAllAutonomousSessions() {},
    wakeAgentSessions() {}
  };
  const bot = createBot(host, { name: 'Ada' });
  const focus = store.getSession(bot.canonicalSessionId);
  ensureRoutineSchema(store);
  const run = {
    id: 'run-db',
    routineId: 'job-db',
    status: 'running',
    mainSessionId: focus.id,
    createdAt: '2026-10-16T11:00:00.000Z',
    updatedAt: '2026-10-16T11:05:00.000Z',
    startedAt: '2026-10-16T11:02:00.000Z',
    job: { name: 'Digest', prompt: 'hidden', sessionId: focus.id, metadata: { botId: bot.id } }
  };
  const insert = (row) => {
    store.db
      .prepare('INSERT INTO bot_routine_runs(id,routine_id,occurrence_key,status,payload) VALUES(?,?,?,?,?)')
      .run(row.id, row.routineId, `${row.id}:key`, row.status, JSON.stringify(row));
  };
  insert(run);
  insert({
    id: 'run-old',
    routineId: 'job-old',
    status: 'failed',
    mainSessionId: focus.id,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    finishedAt: '2020-01-01T00:00:00.000Z',
    job: { name: 'Ancient', prompt: 'hidden', sessionId: focus.id, metadata: { botId: bot.id } }
  });
  store.createBackgroundJob({ sessionId: focus.id, command: 'echo hi', status: 'running' });
  const items = listSessionBotActivity(store, focus, NOW);
  assert.equal(items.some((item) => item.title === 'Digest' && item.status === 'running' && item.botName === 'Ada'), true);
  assert.equal(items.some((item) => item.title === 'echo hi' && item.status === 'running' && item.botName === 'Ada'), true);
  assert.equal(items.some((item) => item.title.includes('hidden') || item.title === 'Ancient'), false);
});
