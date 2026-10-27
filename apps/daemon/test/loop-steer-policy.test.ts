import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeuristicModelAdapter, RawAgentRuntime } from '@ppeng/agent-core';
import { steerRequestOptions } from '../src/steer-request.ts';
import { writeLoopSettings } from '../src/loop-settings.ts';

async function withRuntime(run: (runtime: RawAgentRuntime) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-steer-policy-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: new HeuristicModelAdapter()
  });
  try {
    await run(runtime);
  } finally {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('已保存的立即转向盖过页面上的排队请求 [AC:conversation-loop-defaults#AC-4]', async () => {
  await withRuntime((runtime) => {
    writeLoopSettings(runtime.store, { steerInterruptPolicy: 'steer' });
    const session = runtime.createChatSession({ title: 'plain' });
    runtime.store.updateSession(session.id, { status: 'running' });
    const options = steerRequestOptions({ text: 'now', target: 'next-run' });
    assert.equal('target' in options, false);
    const route = readFileSync(new URL('../src/routes/sessions.ts', import.meta.url), 'utf8');
    assert.match(route, /steerRequestOptions\(body\)/);
    assert.doesNotMatch(route, /body\.target === 'next-run'/);
    const ack = runtime.enqueueSteer(session.id, 'now', options);
    assert.equal(ack.status, 'steered');
    if (ack.status !== 'steered') return;
    assert.equal(ack.item.target, 'next-step');
  });
});

test('已保存的排队等待盖过页面上的立即转向请求 [AC:conversation-loop-defaults#AC-5]', async () => {
  await withRuntime((runtime) => {
    writeLoopSettings(runtime.store, { steerInterruptPolicy: 'queue' });
    const session = runtime.createChatSession({ title: 'plain' });
    runtime.store.updateSession(session.id, { status: 'running' });
    const ack = runtime.enqueueSteer(session.id, 'later', steerRequestOptions({ text: 'later', target: 'next-step' }));
    assert.equal(ack.status, 'started');
    if (ack.status !== 'started') return;
    assert.equal(ack.item.target, 'next-run');
  });
});

test('Bot 固定对话在策略为排队时仍于下一枪转向 [AC:bot-immediate-steer#AC-3]', async () => {
  await withRuntime((runtime) => {
    writeLoopSettings(runtime.store, { steerInterruptPolicy: 'queue' });
    const bot = runtime.createBot({ name: 'Loop Defaults Bot' });
    runtime.store.updateSession(bot.canonicalSessionId, { status: 'running' });
    const ack = runtime.enqueueSteer(
      bot.canonicalSessionId,
      'keep going',
      steerRequestOptions({ text: 'keep going', target: 'next-run' })
    );
    assert.equal(ack.status, 'steered');
    if (ack.status !== 'steered') return;
    assert.equal(ack.item.target, 'next-step');
  });
});
