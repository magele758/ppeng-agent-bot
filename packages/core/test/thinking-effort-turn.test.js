import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, writeThinkingEffortSettings } from '../dist/index.js';

function probe() {
  const efforts = [];
  return {
    efforts,
    adapter: {
      name: 'thinking-effort-probe',
      async runTurn(input) {
        efforts.push(input.reasoningEffort);
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'summary';
      }
    }
  };
}

async function say(runtime, sessionId, text) {
  if (text) runtime.store.appendMessage(sessionId, 'user', [{ type: 'text', text }]);
  const before = runtime.store.listMessages(sessionId).length;
  await runtime.runSession(sessionId);
  assert.ok(runtime.store.listMessages(sessionId).length > before);
}

test('a chat turn follows the saved thinking effort without a restart [AC:thinking-effort#AC-1] [AC:thinking-effort#AC-2] [AC:thinking-effort#AC-3]', async () => {
  const { efforts, adapter } = probe();
  const dir = mkdtempSync(join(tmpdir(), 'thinking-effort-turn-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: adapter
  });
  try {
    const session = runtime.createChatSession({ title: 'effort', message: 'hello' });
    await runtime.runSession(session.id);
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === undefined));
    efforts.length = 0;

    writeThinkingEffortSettings(runtime.store, { level: 'high' });
    assert.equal(writeThinkingEffortSettings(runtime.store, {}).level, 'high');
    await say(runtime, session.id, 'think harder');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === 'high'));
    efforts.length = 0;

    writeThinkingEffortSettings(runtime.store, { level: 'low' });
    await say(runtime, session.id, 'think less');
    assert.ok(efforts.every((level) => level === 'low'));
    efforts.length = 0;

    writeThinkingEffortSettings(runtime.store, { level: 'off' });
    await say(runtime, session.id, 'stop asking');
    assert.ok(efforts.length > 0);
    assert.ok(efforts.every((level) => level === undefined));
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
