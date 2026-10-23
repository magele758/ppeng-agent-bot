import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ANONYMOUS_AUTH } from '@ppeng/agent-core';
import { botRoomsRoutes } from '../../apps/daemon/dist/routes/bot-rooms.js';

async function call(rt, method, pattern, params = {}, body = {}, auth = ANONYMOUS_AUTH, query = '') {
  const route = botRoomsRoutes(rt).find(item => item.method === method && item.pattern === pattern);
  assert.ok(route);
  const out = {};
  const response = { statusCode: 200, setHeader() {}, end(text) { out.status = this.statusCode; out.body = JSON.parse(String(text)); } };
  await route.handler({ request: { method, headers: {} }, response, url: new URL(`http://localhost${pattern}${query}`), parts: [], params, requireParam: name => params[name], readBody: async () => body, auth });
  return out;
}

function runtime(stateDir, repoRoot) {
  return new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: { name: 'reply-mode-scripted', async runTurn() { return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }; }, async summarizeMessages() { return ''; } }
  });
}

test('room settings API switches replyMode between coordinator and all-members [AC:group-reply-mode#AC-5] [AC:group-reply-mode#AC-4]', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'reply-mode-http-state-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'reply-mode-http-repo-'));
  const rt = runtime(stateDir, repoRoot);
  try {
    const bot = rt.createBot({ name: 'HTTPAlpha' });
    const peer = rt.createBot({ name: 'HTTPBeta' });
    const created = await call(rt, 'POST', '/api/bot-rooms', {}, { title: 'Switch', botIds: [bot.id, peer.id] });
    const id = created.body.room.id;
    assert.equal(created.body.room.replyMode, 'coordinator');
    assert.equal((await call(rt, 'GET', '/api/bot-rooms/:id', { id })).body.room.replyMode, 'coordinator');
    assert.equal((await call(rt, 'GET', '/api/bot-rooms')).body.rooms.find(room => room.id === id).replyMode, 'coordinator');

    const allMembers = await call(rt, 'PATCH', '/api/bot-rooms/:id', { id }, { replyMode: 'all-members' });
    assert.equal(allMembers.status, 200);
    assert.equal(allMembers.body.room.replyMode, 'all-members');
    assert.equal((await call(rt, 'GET', '/api/bot-rooms/:id', { id })).body.room.replyMode, 'all-members');

    const back = await call(rt, 'PATCH', '/api/bot-rooms/:id', { id }, { replyMode: 'coordinator' });
    assert.equal(back.body.room.replyMode, 'coordinator');
    await call(rt, 'PATCH', '/api/bot-rooms/:id', { id }, { replyMode: 'all-members' });
    await assert.rejects(() => call(rt, 'PATCH', '/api/bot-rooms/:id', { id }, { replyMode: 'everyone' }), /replyMode/);
    assert.equal((await call(rt, 'GET', '/api/bot-rooms/:id', { id })).body.room.replyMode, 'all-members');
    await assert.rejects(() => call(rt, 'PATCH', '/api/bot-rooms/settings', {}, { replyMode: 'coordinator' }), /Unknown room setting|replyMode/);
    assert.equal((await call(rt, 'GET', '/api/bot-rooms/settings')).body.settings.replyMode, undefined);
  } finally {
    await rt.destroy();
  }

  const reopened = runtime(stateDir, repoRoot);
  try {
    const rooms = (await call(reopened, 'GET', '/api/bot-rooms')).body.rooms;
    assert.equal(rooms.length, 1);
    assert.equal(rooms[0].replyMode, 'all-members');
    const again = await call(reopened, 'GET', `/api/bot-rooms/:id`, { id: rooms[0].id });
    assert.equal(again.body.room.replyMode, 'all-members');
  } finally {
    await reopened.destroy();
  }
});
