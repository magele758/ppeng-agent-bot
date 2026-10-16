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

test('bot activity status maps to running, waiting, or done [AC:bot-activity-rail#AC-1] [AC:bot-activity-rail#AC-2]', () => {
  assert.equal(botActivityStatus('running'), 'running');
  for (const raw of ['queued', 'waiting_approval', 'unknown', 'pending']) {
    assert.equal(botActivityStatus(raw), 'waiting', raw);
  }
  for (const raw of ['completed', 'failed', 'cancelled', 'skipped', 'silent', 'error']) {
    assert.equal(botActivityStatus(raw), 'done', raw);
  }
});

test('assemble lists in-flight routines and background work for this bot [AC:bot-activity-rail#AC-1] [AC:bot-activity-rail#AC-2] [AC:bot-activity-rail#AC-3]', () => {
  const focus = session({});
  const worker = session({
    id: 'worker',
    title: 'Routine: Morning digest',
    metadata: { routineRunId: 'run-live', canonicalBotChat: false }
  });
  // subagent child of focus — tagged AC-5
  const subagentChild = session({
    id: 'sub',
    title: 'Sub-agent: review',
    mode: 'subagent',
    status: 'waiting_approval',
    parentSessionId: 'focus',
    background: true,
    createdAt: '2026-10-16T11:30:00.000Z',
    metadata: { canonicalBotChat: false }
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
    sessions: [focus, worker, subagentChild, teammate, idle, stranger],
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

  // AC-5: a subagent with parentSessionId === focus.id appears as a background waiting item
  assert.equal(items.some((item) => item.id === 'session:sub' && item.status === 'waiting'), true,
    'subagent child must appear as background waiting [AC:bot-activity-rail#AC-5]');

  assert.deepEqual(
    items.filter((item) => item.id !== 'session:sub').map((item) => [item.kind, item.status, item.title, item.botName]),
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

test('listSessionBotActivity reads routine runs and background jobs [AC:bot-activity-rail#AC-1] [AC:bot-activity-rail#AC-6]', () => {
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

test('sameOwner: two sessions with distinct userIds are not same-owner [AC:bot-activity-rail#AC-3]', () => {
  // A routine tied to user-B's session must NOT appear in user-A's rail.
  const focusA = {
    id: 'focus-a',
    title: 'Bot Chat · Ada',
    mode: 'chat',
    status: 'idle',
    agentId: 'ada',
    background: false,
    todo: [],
    metadata: { botId: 'ada', userId: 'userA', canonicalBotChat: true },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  };
  const sessionB = {
    id: 'session-b',
    title: 'Bot Chat · Ada',
    mode: 'chat',
    status: 'idle',
    agentId: 'ada',
    background: false,
    todo: [],
    metadata: { botId: 'ada', userId: 'userB', canonicalBotChat: true },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  };
  const runB = {
    id: 'run-b',
    routineId: 'job-b',
    scheduledAt: '2026-10-16T11:00:00.000Z',
    timezone: 'UTC',
    status: 'running',
    mainSessionId: 'session-b',
    attempt: 1,
    missedCount: 0,
    createdAt: '2026-10-16T11:00:00.000Z',
    updatedAt: '2026-10-16T11:05:00.000Z',
    startedAt: '2026-10-16T11:01:00.000Z',
    job: {
      id: 'job-b',
      sessionId: 'session-b',
      agentId: 'ada',
      name: 'UserB digest',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' },
    },
  };
  const items = assembleBotActivity({
    focus: focusA,
    sessions: [focusA, sessionB],
    jobs: [],
    routines: [runB],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW,
  });
  assert.equal(items.some((item) => item.title === 'UserB digest'), false, 'user B routine must not appear in user A rail');
});

test('sameOwner: a userId on either side must match; tenant-only is not the same owner [AC:bot-activity-rail#AC-3]', () => {
  const focus = session({ id: 'focus-user', metadata: { userId: 'A', tenantId: 'T' } });
  const tenantOnly = session({ id: 'main-tenant', metadata: { userId: undefined, tenantId: 'T' } });
  const run = routine({
    id: 'run-mixed',
    mainSessionId: tenantOnly.id,
    job: {
      id: 'job-mixed',
      sessionId: tenantOnly.id,
      agentId: 'ada',
      name: 'Tenant only digest',
      prompt: 'hidden',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' }
    }
  });
  const items = assembleBotActivity({
    focus,
    sessions: [focus, tenantOnly],
    jobs: [],
    routines: [run],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW
  });
  assert.equal(items.some((item) => item.title === 'Tenant only digest'), false, '{userId:A,tenantId:T} vs {tenantId:T} is not the same owner');
});

test('sameOwner: sessions with no userId and the same tenant match [AC:bot-activity-rail#AC-3]', () => {
  const focus = session({ id: 'focus-tenant', metadata: { userId: undefined, tenantId: 'T' } });
  const main = session({ id: 'main-tenant', metadata: { userId: undefined, tenantId: 'T' } });
  const run = routine({
    id: 'run-tenant',
    mainSessionId: main.id,
    job: {
      id: 'job-tenant',
      sessionId: main.id,
      agentId: 'ada',
      name: 'Shared tenant digest',
      prompt: 'hidden',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' }
    }
  });
  const items = assembleBotActivity({
    focus,
    sessions: [focus, main],
    jobs: [],
    routines: [run],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW
  });
  assert.equal(items.some((item) => item.title === 'Shared tenant digest' && item.status === 'running'), true);
});

test('sameOwner: different users never match even in the same tenant [AC:bot-activity-rail#AC-3]', () => {
  const focus = session({ id: 'focus-a', metadata: { userId: 'A', tenantId: 'T' } });
  const other = session({ id: 'main-b', metadata: { userId: 'B', tenantId: 'T' } });
  const run = routine({
    id: 'run-other-user',
    mainSessionId: other.id,
    job: {
      id: 'job-other-user',
      sessionId: other.id,
      agentId: 'ada',
      name: 'Other user digest',
      prompt: 'hidden',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' }
    }
  });
  const items = assembleBotActivity({
    focus,
    sessions: [focus, other],
    jobs: [],
    routines: [run],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW
  });
  assert.equal(items.some((item) => item.title === 'Other user digest'), false, 'different users never match');
});

test('sameOwner: two unowned sessions (local mode) are same-owner [AC:bot-activity-rail#AC-4]', () => {
  // Single-user local mode: both sessions have no userId — rail shows all activity.
  const focus = {
    id: 'focus-local',
    title: 'Bot Chat · Ada',
    mode: 'chat',
    status: 'idle',
    agentId: 'ada',
    background: false,
    todo: [],
    metadata: { botId: 'ada', canonicalBotChat: true },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  };
  const mainSession = {
    id: 'main-local',
    title: 'Bot Chat · Ada',
    mode: 'chat',
    status: 'idle',
    agentId: 'ada',
    background: false,
    todo: [],
    metadata: { botId: 'ada', canonicalBotChat: true },
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
  };
  const run = {
    id: 'run-local',
    routineId: 'job-local',
    scheduledAt: '2026-10-16T11:00:00.000Z',
    timezone: 'UTC',
    status: 'running',
    mainSessionId: 'main-local',
    attempt: 1,
    missedCount: 0,
    createdAt: '2026-10-16T11:00:00.000Z',
    updatedAt: '2026-10-16T11:05:00.000Z',
    startedAt: '2026-10-16T11:01:00.000Z',
    job: {
      id: 'job-local',
      sessionId: 'main-local',
      agentId: 'ada',
      name: 'Local digest',
      scheduleKind: 'cron5',
      scheduleValue: '0 * * * *',
      enabled: true,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
      metadata: { botId: 'ada' },
    },
  };
  const items = assembleBotActivity({
    focus,
    sessions: [focus, mainSession],
    jobs: [],
    routines: [run],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW,
  });
  assert.equal(items.some((item) => item.title === 'Local digest' && item.status === 'running'), true, 'local mode routine must appear');
});

test('subagent child with parentSessionId appears as background waiting in the activity rail [AC:bot-activity-rail#AC-5]', () => {
  const focus = session({});
  const subagentChild = session({
    id: 'sub-ac5',
    title: 'Sub-agent: classify',
    mode: 'subagent',
    status: 'waiting_approval',
    parentSessionId: 'focus',
    background: true,
    createdAt: '2026-10-16T11:30:00.000Z',
    metadata: { canonicalBotChat: false }
  });
  const items = assembleBotActivity({
    focus,
    sessions: [focus, subagentChild],
    jobs: [],
    routines: [],
    botNames: new Map([['ada', 'Ada']]),
    now: NOW
  });
  assert.equal(items.some((item) => item.id === 'session:sub-ac5' && item.kind === 'background' && item.status === 'waiting'), true,
    'subagent child must appear as background waiting');
});
