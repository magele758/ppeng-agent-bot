import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers/bot-http-fixture.mjs';

test('guided creation never overwrites a connection created by another editor [AC:bot-product-p1#AC-3] [AC:bot-product-p1#AC-4]', async () => {
  const daemon = await boot();
  try {
    const bot = (await daemon.call('alice', 'POST', '/api/bots', { name: 'Guided safe binding' })).body.bot;
    const endpoint = `/api/bots/${bot.id}/connections/one`;
    const tools = [{ name: 'guided_read', description: 'Original operation', inputSchema: { type: 'object' },
      executor: { kind: 'http', url: 'https://example.com/original', method: 'GET' } }];
    assert.equal((await daemon.call('alice', 'PUT', endpoint, { tools, createOnly: true })).status, 200);
    const replaced = await daemon.call('alice', 'PUT', endpoint, {
      createOnly: true, tools: [{ ...tools[0], description: 'Unexpected replacement' }],
    });
    assert.notEqual(replaced.status, 200);
    const list = await daemon.call('alice', 'GET', `/api/bots/${bot.id}/connections`);
    assert.equal(list.body.connections[0].tools[0].description, 'Original operation');
  } finally { await daemon.close(); }
});

test('OpenAPI form can grant only reads and failed imports retain those grants [AC:bot-product-p1#AC-3] [AC:bot-product-p1#AC-4] [AC:bot-product-p1#AC-5]', async () => {
  const daemon = await boot();
  try {
    const bot = (await daemon.call('alice', 'POST', '/api/bots', { name: 'API form' })).body.bot;
    const path = `/api/bots/${bot.id}/connections`;
    const spec = { openapi: '3.0.0', servers: [{ url: 'https://example.com' }], paths: {
      '/status': { get: { operationId: 'read_status', responses: {} } },
      '/update': { post: { operationId: 'write_status', responses: {} } },
    } };
    const saved = await daemon.call('alice', 'POST', `${path}/import`, { connectorId: 'api', spec, readOnlyOnly: true, createOnly: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.connection.tools.map(tool => tool.name), ['read_status']);
    assert.notEqual((await daemon.call('alice', 'POST', `${path}/import`, { connectorId: 'api', spec, createOnly: true })).status, 200);
    assert.notEqual((await daemon.call('alice', 'POST', `${path}/import`, { connectorId: 'api', spec: { openapi: 'invalid' } })).status, 200);
    const list = await daemon.call('alice', 'GET', path);
    assert.deepEqual(list.body.connections[0].tools.map(tool => tool.name), ['read_status']);
  } finally { await daemon.close(); }
});
