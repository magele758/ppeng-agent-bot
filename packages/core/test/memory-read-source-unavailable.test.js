import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTools } from '../dist/tools/memory-tools.js';
import { runWithMemoryReadTurn } from '../dist/tools/memory-read-turn.js';

function readTool(services) {
  return createMemoryTools(services).find((tool) => tool.name === 'memory_read');
}

const ctx = { session: { id: 's', metadata: { userId: 'u', tenantId: 't' } } };

test('memory_read surfaces SOURCE_UNAVAILABLE once per source in a turn [AC:memory-read-source-unavailable#AC-1]', async () => {
  let reads = 0;
  const read = readTool({
    listSessionMemory: async (id) => {
      reads += 1;
      return id === 's'
        ? [{ id: 'm1', scope: 'scratch', key: 'k', value: 'page-me-please', updatedAt: '2026-01-01', importance: 1 }]
        : [];
    },
    getAgentMemoryById: async () => {
      reads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return null;
    }
  });

  await runWithMemoryReadTurn(async () => {
    const [first, parallel] = await Promise.all([
      read.execute(ctx, { ref: 'memory:user:missing' }),
      read.execute(ctx, { ref: 'memory:user:missing' })
    ]);
    assert.equal(first.ok, false);
    assert.equal(JSON.parse(first.content).error_code, 'SOURCE_UNAVAILABLE');
    assert.equal(JSON.parse(first.content).retry, false);
    assert.equal(JSON.parse(parallel.content).surfaced, true);
    assert.equal(reads, 1);

    const again = await read.execute(ctx, { ref: 'memory:user:missing' });
    assert.equal(again.ok, false);
    assert.equal(JSON.parse(again.content).surfaced, true);
    assert.equal(reads, 1);

    await read.execute(ctx, { ref: 'memory:user:other' });
    assert.equal(reads, 2);

    const page = await read.execute(ctx, { ref: 'memory:scratch:m1', offset: 0, limit: 7 });
    const next = await read.execute(ctx, { ref: 'memory:scratch:m1', offset: 7, limit: 7 });
    assert.equal(page.ok, true);
    assert.equal(next.ok, true);
    assert.equal(JSON.parse(page.content).text + JSON.parse(next.content).text, 'page-me-please');
  });

  await runWithMemoryReadTurn(async () => {
    const retried = await read.execute(ctx, { ref: 'memory:user:missing' });
    assert.equal(retried.ok, false);
    assert.equal(JSON.parse(retried.content).error_code, 'SOURCE_UNAVAILABLE');
    assert.equal(JSON.parse(retried.content).surfaced, undefined);
    assert.equal(reads, 5);
  });
});

test('a denied memory stays denied and is not read again in that turn [AC:memory-read-source-unavailable#AC-2]', async () => {
  const secret = 'SECRET-VALUE-DO-NOT-LEAK';
  let reads = 0;
  const read = readTool({
    listSessionMemory: async () => [],
    getAgentMemoryById: async () => {
      reads += 1;
      return {
        id: 'id',
        scope: 'user.memory',
        key: 'private',
        value: secret,
        userId: 'other',
        tenantId: 't',
        updatedAt: '2026-01-01'
      };
    }
  });

  await runWithMemoryReadTurn(async () => {
    const first = await read.execute(ctx, { ref: 'memory:user:id' });
    const second = await read.execute(ctx, { ref: 'memory:user:id' });
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(first.content.includes(secret), false);
    assert.equal(second.content.includes(secret), false);
    assert.equal(JSON.parse(first.content).error_code, 'SOURCE_UNAVAILABLE');
    assert.equal(JSON.parse(second.content).surfaced, true);
    assert.equal(reads, 1);
  });
});
