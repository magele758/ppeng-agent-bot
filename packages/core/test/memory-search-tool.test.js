import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from '../dist/tools/memory-tools.js';
import { fenceExternalContent } from '../dist/safety/external-content.js';
import { PLANNER_READONLY_TOOLS } from '../dist/runtime/run-profile.js';
import { isReadOnlyTool } from '../dist/approval/permission-mode.js';

function memoryBackend() {
  const rows = [];
  return {
    rows,
    services: {
      async upsertSessionMemory(sessionId, scope, key, value) {
        const id = `${sessionId}:${scope}:${key}`;
        const entry = {
          id,
          sessionId,
          scope,
          key,
          value,
          updatedAt: new Date().toISOString(),
          importance: 0.5
        };
        const idx = rows.findIndex((row) => row.id === id);
        if (idx >= 0) rows[idx] = entry;
        else rows.push(entry);
      },
      async listSessionMemory(sessionId, scope) {
        return rows.filter((row) => row.sessionId === sessionId && (!scope || row.scope === scope));
      },
      async deleteSessionMemory() {
        return false;
      }
    }
  };
}

function ctx(sessionId) {
  return {
    repoRoot: '/repo',
    stateDir: '/tmp',
    session: { id: sessionId, metadata: {}, agentId: 'general', mode: 'chat' },
    agent: { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] }
  };
}

test('memory_search is visible like memory_get', () => {
  const tools = createMemoryTools(memoryBackend().services);
  assert.ok(tools.some((tool) => tool.name === 'memory_search'));
  assert.ok(PLANNER_READONLY_TOOLS.includes('memory_get'));
  assert.ok(PLANNER_READONLY_TOOLS.includes('memory_search'));
  assert.equal(isReadOnlyTool('memory_search'), isReadOnlyTool('memory_get'));
});

test('memory_search returns the one hit and omits the other memories full text', async () => {
  const { services } = memoryBackend();
  const tools = createMemoryTools(services);
  const set = tools.find((tool) => tool.name === 'memory_set');
  const search = tools.find((tool) => tool.name === 'memory_search');
  const session = ctx('sess-search');
  const hit = 'zephyrlighthouse marks the north beacon';
  const missA = `FULLALPHA_${'a'.repeat(280)}_ENDALPHA`;
  const missB = `FULLBETA_${'b'.repeat(280)}_ENDBETA`;

  assert.equal((await set.execute(session, { scope: 'scratch', key: 'beacon', value: hit })).ok, true);
  assert.equal((await set.execute(session, { scope: 'scratch', key: 'marigold', value: missA })).ok, true);
  assert.equal((await set.execute(session, { scope: 'scratch', key: 'cobalt', value: missB })).ok, true);

  const result = await search.execute(session, { query: 'zephyrlighthouse', scope: 'scratch' });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.content);
  assert.deepEqual(
    parsed.matches.map((match) => match.key),
    ['beacon']
  );
  assert.equal(parsed.matches[0].excerpt.includes('zephyrlighthouse'), true);
  assert.equal(result.content.includes(missA), false);
  assert.equal(result.content.includes(missB), false);
  assert.equal(Object.hasOwn(parsed.matches[0], 'value'), false);
});

test('memory_search keeps external-content fences intact', async () => {
  const { services } = memoryBackend();
  const tools = createMemoryTools(services);
  const set = tools.find((tool) => tool.name === 'memory_set');
  const search = tools.find((tool) => tool.name === 'memory_search');
  const session = ctx('sess-fence');
  const short = fenceExternalContent({
    source: 'web_fetch',
    label: 'notes',
    body: 'zephyrshort intact beacon'
  });
  const tail = 'UNIQUE_TAIL_MARKER_987654';
  const sibling = `FULLGAMMA_${'g'.repeat(320)}_ENDGAMMA`;
  const long = fenceExternalContent({
    source: 'web_fetch',
    label: 'notes',
    body: `zephyrfence ${'Q'.repeat(400)} ${tail}`
  });
  assert.ok(long.length > 180);
  assert.equal((await set.execute(session, { scope: 'scratch', key: 'short-fence', value: short })).ok, true);
  assert.equal((await set.execute(session, { scope: 'scratch', key: 'long-fence', value: long })).ok, true);
  assert.equal((await set.execute(session, { scope: 'scratch', key: 'sibling', value: sibling })).ok, true);

  const shortHit = JSON.parse((await search.execute(session, { query: 'zephyrshort', scope: 'scratch' })).content);
  assert.deepEqual(
    shortHit.matches.map((match) => match.key),
    ['short-fence']
  );
  assert.equal(shortHit.matches[0].excerpt, short);

  const longResult = await search.execute(session, { query: 'zephyrfence', scope: 'scratch' });
  const longHit = JSON.parse(longResult.content);
  assert.deepEqual(
    longHit.matches.map((match) => match.key),
    ['long-fence']
  );
  const excerpt = longHit.matches[0].excerpt;
  const opens = excerpt.split('«external ').length - 1;
  const closes = excerpt.split('«end external»').length - 1;
  assert.equal(opens, closes);
  assert.ok(opens >= 1);
  assert.equal(excerpt.includes(tail), false);
  assert.equal(longResult.content.includes(sibling), false);
});

test('memory_search maps stored scope aliases and skips rows that are not memories', async () => {
  const services = {
    async upsertSessionMemory() {},
    async deleteSessionMemory() {
      return false;
    },
    async listSessionMemory(_sessionId, scope) {
      if (scope === 'scratch') {
        return [
          { scope: 'session.scratch', key: 'alias-scratch', value: 'zephyralias scratch' },
          { scope: 'scratch', key: 'plain-scratch', value: 'zephyralias plain scratch' },
          null,
          { key: '', value: 'zephyralias empty' },
          { key: 'not-text', value: 1 }
        ];
      }
      if (scope === 'long') {
        return [{ scope: 'session.long', key: 'alias-long', value: 'zephyralias long' }];
      }
      return [];
    },
    async listAgentMemory(query) {
      if (query.scope === 'user.memory') {
        return [
          { scope: 'user.memory', key: 'alias-user', value: 'zephyralias user' },
          { scope: 'user', key: 'plain-user', value: 'zephyralias plain user' },
          { scope: 'nope', key: 'fallback-user', value: 'zephyralias fallback' }
        ];
      }
      if (query.scope === 'team.memory') {
        return [{ scope: 'team.memory', key: 'alias-team', value: 'zephyralias team' }];
      }
      if (query.scope === 'project.memory') {
        return [{ scope: 'project.memory', key: 'alias-project', value: 'zephyralias project', importance: 0.2 }];
      }
      return [];
    }
  };
  const search = createMemoryTools(services).find((tool) => tool.name === 'memory_search');
  const result = await search.execute(ctx('sess-alias'), { query: 'zephyralias', limit: 20 });
  assert.equal(result.ok, true);
  const matches = JSON.parse(result.content).matches;
  assert.deepEqual(
    matches.map((match) => `${match.scope}:${match.key}`).sort(),
    [
      'long:alias-long',
      'project:alias-project',
      'scratch:alias-scratch',
      'scratch:plain-scratch',
      'team:alias-team',
      'user:alias-user',
      'user:fallback-user',
      'user:plain-user'
    ]
  );
});
