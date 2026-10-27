import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { zonedClock } from '../src/session/conversation-clock.ts';

test('product model request uses the session calendar day and does not store the live clock [AC:conversation-date-clock#AC-1] [AC:conversation-date-clock#AC-2] [AC:conversation-date-clock#AC-5] [AC:conversation-date-clock#AC-6]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'conversation-clock-'));
  let delivered;
  const rt = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'scripted',
      async runTurn(input) {
        delivered = input;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  try {
    const session = rt.store.createSession({
      title: 'clock',
      mode: 'chat',
      agentId: 'general',
      background: false,
      metadata: { timezone: 'Asia/Shanghai' }
    });
    const boundary = zonedClock(Date.parse('2026-10-26T16:30:00.000Z'), 'Asia/Shanghai');
    assert.equal(boundary.date, '2026-10-27');
    assert.notEqual(boundary.date, '2026-10-26');
    const today = zonedClock(Date.now(), 'Asia/Shanghai').date;
    const insert = rt.store.db.prepare(
      'INSERT INTO session_messages(id, session_id, role, parts_json, created_at, seq, surface_op) VALUES(?,?,?,?,?,?,?)'
    );
    insert.run(
      'old-user',
      session.id,
      'user',
      JSON.stringify([{ type: 'text', text: '今天' }]),
      '2026-10-20T02:00:00.000Z',
      1,
      'append'
    );
    insert.run(
      'old-assistant',
      session.id,
      'assistant',
      JSON.stringify([{ type: 'text', text: '今天' }]),
      '2026-10-20T03:00:00.000Z',
      2,
      'append'
    );
    rt.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'continue' }]);
    const agent = { id: 'general', name: 'general', role: 'general', instructions: '', capabilities: [] };
    const stable = rt.promptBuilder.buildStablePrefix({ agent, session, task: undefined });
    assert.equal(stable.includes('Current calendar date'), false);
    await rt.runSession(session.id);
    assert.ok(delivered, 'model request was not delivered');
    assert.equal(delivered.systemPrompt.includes('Current calendar date'), false);
    assert.equal(delivered.systemPrompt.includes('Current time:'), false);
    assert.equal(delivered.systemPrompt.includes('[conversation-clock]'), false);
    const text = JSON.stringify(delivered.messages);
    assert.match(text, /\[written 2026-10-20/);
    assert.match(text, /今天/);
    assert.match(text, /\[conversation-clock\]/);
    assert.match(text, new RegExp(`Current time: ${today}`));
    assert.match(text, /Asia\/Shanghai/);
    assert.notEqual(today, '2026-10-20');
    const stored = JSON.stringify(rt.store.foldMessages(session.id));
    assert.equal(stored.includes('[conversation-clock]'), false);
    assert.equal(stored.includes('Current time:'), false);
  } finally {
    rt.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
