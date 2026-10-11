import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpSession } from '../dist/mcp/mcp-http.js';

const roomUrl = process.env.AGENT_ROOM_URL?.trim() ?? '';
const roomToken = process.env.AGENT_ROOM_TOKEN?.trim() ?? '';
const skip = !roomUrl || !roomToken;

test('Agent Room MCP lists tools and whoami succeeds', { skip }, async () => {
  const session = new McpHttpSession(0, {
    url: roomUrl,
    headers: { Authorization: `Bearer ${roomToken}` }
  });
  try {
    await session.connect();
    const tools = await session.listTools();
    assert.ok(tools.some((tool) => tool.name === 'whoami'));
    assert.ok(tools.some((tool) => tool.name === 'list_rooms'));
    const who = await session.callTool('whoami', {});
    assert.notEqual(who.isError, true);
    assert.match(who.content, /"handle"/);
    assert.equal(who.content.includes(roomToken), false);
    assert.equal(who.content.includes('«external'), false);
  } finally {
    await session.close();
  }
});

test('Agent Room MCP rejects a bad token without echoing it', { skip }, async () => {
  const bad = 'agt_not_a_real_token_batch1';
  const session = new McpHttpSession(0, {
    url: roomUrl,
    headers: { Authorization: `Bearer ${bad}` }
  });
  try {
    await assert.rejects(
      () => session.connect(),
      (error) => {
        assert.equal(error instanceof Error, true);
        assert.equal(error.message.includes(bad), false);
        return true;
      }
    );
  } finally {
    await session.close();
  }
});
