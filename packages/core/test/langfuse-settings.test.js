import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultLangfuseSettings,
  publicLangfuseSettings,
  readLangfuseSettings,
  resolveLangfuseChain,
  writeLangfuseSettings,
  buildLangfuseBatch,
  langfuseIngestionUrl,
  mirrorTraceToLangfuse,
  resetLangfuseTraceState
} from '../src/langfuse/settings.ts';

function kvStore() {
  const map = new Map();
  return {
    getDaemonControl(key) {
      return map.get(key);
    },
    setDaemonControl(key, value) {
      map.set(key, value);
    }
  };
}

test('no baseUrl → resolve null even with env keys; enabled wish is kept', () => {
  const store = kvStore();
  assert.equal(defaultLangfuseSettings().enabled, false);
  assert.equal(resolveLangfuseChain(store, {
    LANGFUSE_PUBLIC_KEY: 'pk',
    LANGFUSE_SECRET_KEY: 'sk'
  }), null);

  writeLangfuseSettings(store, { enabled: true });
  const saved = readLangfuseSettings(store);
  assert.equal(saved.baseUrl, '');
  assert.equal(saved.enabled, true);
  assert.equal(
    resolveLangfuseChain(store, {
      LANGFUSE_PUBLIC_KEY: 'pk',
      LANGFUSE_SECRET_KEY: 'sk'
    }),
    null
  );
});

test('baseUrl + enabled false → null', () => {
  const store = kvStore();
  writeLangfuseSettings(store, {
    baseUrl: 'http://192.168.1.10:3000/',
    enabled: false,
    publicKey: 'pk',
    secretKey: 'sk'
  });
  assert.equal(readLangfuseSettings(store).baseUrl, 'http://192.168.1.10:3000');
  assert.equal(resolveLangfuseChain(store, {}), null);
});

test('env key fallback when KV empty; KV prefers over env', () => {
  const store = kvStore();
  writeLangfuseSettings(store, {
    baseUrl: 'http://lf.example:3000',
    enabled: true
  });
  const viaEnv = resolveLangfuseChain(store, {
    LANGFUSE_PUBLIC_KEY: 'env-pk',
    LANGFUSE_SECRET_KEY: 'env-sk'
  });
  assert.ok(viaEnv);
  assert.equal(viaEnv.publicKey, 'env-pk');
  assert.equal(viaEnv.secretKey, 'env-sk');

  writeLangfuseSettings(store, { publicKey: 'kv-pk', secretKey: 'kv-sk' });
  const viaKv = resolveLangfuseChain(store, {
    LANGFUSE_PUBLIC_KEY: 'env-pk',
    LANGFUSE_SECRET_KEY: 'env-sk'
  });
  assert.equal(viaKv.publicKey, 'kv-pk');
  assert.equal(viaKv.secretKey, 'kv-sk');
});

test('blank PATCH keeps secrets; clearSecretKey clears; public has no raw keys', () => {
  const store = kvStore();
  writeLangfuseSettings(store, {
    baseUrl: 'http://lf.example:3000',
    enabled: true,
    publicKey: 'pk-secret',
    secretKey: 'sk-secret'
  });
  writeLangfuseSettings(store, { enabled: true, publicKey: '  ', secretKey: '' });
  const saved = readLangfuseSettings(store);
  assert.equal(saved.publicKey, 'pk-secret');
  assert.equal(saved.secretKey, 'sk-secret');

  const pub = publicLangfuseSettings(saved, {});
  assert.equal(pub.publicKeySet, true);
  assert.equal(pub.secretKeySet, true);
  assert.equal(pub.chained, true);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'publicKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'secretKey'), false);
  assert.equal(typeof pub.publicKey, 'undefined');
  assert.equal(typeof pub.secretKey, 'undefined');

  writeLangfuseSettings(store, { clearSecretKey: true });
  assert.equal(readLangfuseSettings(store).secretKey, '');
  assert.equal(publicLangfuseSettings(readLangfuseSettings(store), {}).secretKeySet, false);
  assert.equal(resolveLangfuseChain(store, {}), null);
});

test('buildLangfuseBatch nests a model generation under the turn and closes tools', () => {
  resetLangfuseTraceState();
  const start = buildLangfuseBatch(
    'sess_pair',
    { kind: 'turn_start', payload: { turn: 0, adapter: 'hybrid-router' } },
    { model: 'deepseek-v4-flash' }
  );
  assert.equal(start[0].type, 'trace-create');
  assert.equal(start[0].body.id, 'sess_pair');
  assert.equal(start[0].body.name, 'deepseek-v4-flash');
  const turnSpan = start.find((e) => e.type === 'span-create');
  const gen = start.find((e) => e.type === 'generation-create');
  assert.ok(turnSpan);
  assert.ok(gen);
  assert.equal(turnSpan.body.name, 'turn 0');
  assert.equal(gen.body.parentObservationId, turnSpan.body.id);
  assert.equal(gen.body.model, 'deepseek-v4-flash');
  assert.equal(gen.body.name, 'deepseek-v4-flash');
  assert.equal(gen.body.endTime, undefined);

  const toolStart = buildLangfuseBatch('sess_pair', {
    kind: 'tool_start',
    payload: { name: 'web_fetch' }
  });
  const toolCreate = toolStart.find((e) => e.type === 'span-create');
  assert.ok(toolCreate);
  assert.equal(toolCreate.body.name, 'tool.web_fetch');
  assert.equal(toolCreate.body.parentObservationId, turnSpan.body.id);

  const toolEnd = buildLangfuseBatch('sess_pair', {
    kind: 'tool_end',
    data: { name: 'web_fetch', ok: true }
  });
  const toolUpdate = toolEnd.find((e) => e.type === 'span-update');
  assert.ok(toolUpdate);
  assert.equal(toolUpdate.body.id, toolCreate.body.id);
  assert.equal(toolUpdate.body.metadata.ok, true);
  assert.equal(typeof toolUpdate.body.endTime, 'string');

  const end = buildLangfuseBatch('sess_pair', {
    kind: 'turn_end',
    payload: {
      stopReason: 'end',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      costUsd: 0.01,
      costModel: 'default'
    }
  });
  const genUpdate = end.find((e) => e.type === 'generation-update');
  assert.ok(genUpdate);
  assert.equal(genUpdate.body.id, gen.body.id);
  assert.equal(genUpdate.body.model, 'deepseek-v4-flash');
  assert.deepEqual(genUpdate.body.usage, {
    input: 11,
    output: 7,
    total: 18,
    unit: 'TOKENS'
  });
  assert.equal(typeof genUpdate.body.endTime, 'string');

  const terminal = buildLangfuseBatch('sess_pair', {
    kind: 'turn_end',
    data: { terminal: true, reason: 'end' }
  });
  assert.equal(terminal.some((e) => String(e.type).startsWith('generation')), false);
  assert.ok(terminal.some((e) => e.type === 'span-update' && e.body.id === turnSpan.body.id));
});

test('jev_call nests under the turn, including calls that happen before turn_start', () => {
  resetLangfuseTraceState();
  const early = buildLangfuseBatch('sess_jev', {
    kind: 'jev_call',
    payload: {
      point: 'skillSelect',
      startedAt: '2026-09-23T08:00:00.000Z',
      endedAt: '2026-09-23T08:00:00.180Z',
      durationMs: 180,
      ok: true,
      questions: [{ id: 's0', type: 'noul', instructions: 'need skill?' }],
      answers: { s0: { noul: 0.82 } }
    }
  });
  const earlyTurn = early.find((e) => e.type === 'span-create' && e.body.name === 'turn');
  const jev = early.find((e) => e.type === 'span-create' && e.body.name === 'jev.skillSelect');
  assert.ok(earlyTurn);
  assert.ok(jev);
  assert.equal(jev.body.parentObservationId, earlyTurn.body.id);
  assert.equal(jev.body.startTime, '2026-09-23T08:00:00.000Z');
  assert.equal(jev.body.endTime, '2026-09-23T08:00:00.180Z');
  assert.equal(jev.body.output.s0.noul, 0.82);

  const start = buildLangfuseBatch(
    'sess_jev',
    { kind: 'turn_start', payload: { turn: 0 } },
    { model: 'deepseek-v4-flash' }
  );
  const spans = start.filter((e) => e.type === 'span-create');
  assert.equal(spans.length, 0);
  const renamed = start.find((e) => e.type === 'span-update');
  assert.equal(renamed.body.id, earlyTurn.body.id);
  assert.equal(renamed.body.name, 'turn 0');
  const gen = start.find((e) => e.type === 'generation-create');
  assert.equal(gen.body.parentObservationId, earlyTurn.body.id);
  assert.equal(gen.body.model, 'deepseek-v4-flash');
});

test('failed jev_call is an error span under the turn', () => {
  resetLangfuseTraceState();
  const batch = buildLangfuseBatch('sess_jev_fail', {
    kind: 'jev_call',
    payload: {
      point: 'goalGate',
      ok: false,
      error: 'HTTP 500',
      startedAt: '2026-09-23T08:00:00.000Z',
      endedAt: '2026-09-23T08:00:01.000Z'
    }
  });
  const jev = batch.find((e) => e.body.name === 'jev.goalGate');
  assert.ok(jev);
  assert.equal(jev.body.level, 'ERROR');
  assert.equal(jev.body.output.error, 'HTTP 500');
  assert.equal(jev.body.parentObservationId, batch.find((e) => e.body.name === 'turn').body.id);
});

test('mirror uses the session model when the event has none', async () => {
  resetLangfuseTraceState();
  const store = kvStore();
  writeLangfuseSettings(store, {
    baseUrl: 'http://langfuse.test:3000',
    enabled: true,
    publicKey: 'pk',
    secretKey: 'sk'
  });
  store.getSession = () => ({
    metadata: { modelRef: { providerId: 'tokenpony', modelId: 'deepseek-v4-flash-0731' } }
  });
  let body;
  await mirrorTraceToLangfuse(
    store,
    'sess_model',
    { kind: 'turn_start', payload: { turn: 0 } },
    {},
    async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return '{}';
        },
        async json() {
          return {};
        }
      };
    }
  );
  const gen = body.batch.find((e) => e.type === 'generation-create');
  assert.equal(gen.body.model, 'deepseek-v4-flash-0731');
  assert.equal(gen.body.name, 'deepseek-v4-flash-0731');
});

test('lone tool_end still creates a span from data', () => {
  resetLangfuseTraceState();
  const tool = buildLangfuseBatch('sess_tool_only', {
    kind: 'tool_end',
    data: { name: 'bash', ok: true }
  });
  assert.equal(tool[1].type, 'span-create');
  assert.equal(tool[1].body.name, 'tool.bash');
  assert.equal(tool[1].body.metadata.ok, true);
  assert.notEqual(tool[1].body.startTime, tool[1].body.endTime);
});

test('langfuseIngestionUrl suffixes', () => {
  assert.equal(
    langfuseIngestionUrl('http://h:3000'),
    'http://h:3000/api/public/ingestion'
  );
  assert.equal(
    langfuseIngestionUrl('http://h:3000/api/public'),
    'http://h:3000/api/public/ingestion'
  );
  assert.equal(
    langfuseIngestionUrl('http://h:3000/api/public/ingestion/'),
    'http://h:3000/api/public/ingestion'
  );
});

test('mirrorTraceToLangfuse: off skips fetch; on posts Basic; fetch throw swallowed', async () => {
  const store = kvStore();
  let calls = 0;
  const throwingFetch = async () => {
    calls += 1;
    throw new Error('network down');
  };

  await mirrorTraceToLangfuse(store, 's1', { kind: 'turn_end', payload: {} }, {}, throwingFetch);
  assert.equal(calls, 0);

  writeLangfuseSettings(store, {
    baseUrl: 'http://langfuse.test:3000',
    enabled: true,
    publicKey: 'pk',
    secretKey: 'sk'
  });

  const seen = [];
  const okFetch = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      status: 200,
      async text() {
        return '{}';
      },
      async json() {
        return {};
      }
    };
  };
  await mirrorTraceToLangfuse(
    store,
    's1',
    { kind: 'tool_start', payload: { name: 'bash' } },
    {},
    okFetch
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://langfuse.test:3000/api/public/ingestion');
  assert.equal(
    seen[0].init.headers.Authorization,
    `Basic ${Buffer.from('pk:sk', 'utf8').toString('base64')}`
  );
  assert.equal(seen[0].init.headers['Content-Type'], 'application/json');

  await mirrorTraceToLangfuse(store, 's1', { kind: 'turn_end', payload: {} }, {}, throwingFetch);
  assert.equal(calls, 1);
});
