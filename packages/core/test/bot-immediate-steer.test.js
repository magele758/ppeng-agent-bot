import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

function userTexts(input) {
  return input.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text));
}

function hasText(rows, needle) {
  return rows.some((text) => text.includes(needle));
}

function runtimeWith(adapter, extraTools = []) {
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'bot-steer-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'bot-steer-state-')),
    modelAdapter: adapter,
    extraTools
  });
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  return runtime;
}

test('canonical bot steer during a tool wave lands on the next shot without an approval [AC:bot-immediate-steer#AC-1] [AC:bot-immediate-steer#AC-3]', async () => {
  const inputs = [];
  let rt;
  const sidBox = { id: '' };
  const tool = {
    name: 'steer_probe',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute() {
      const ack = rt.enqueueSteer(sidBox.id, 'bot_midturn_note', { target: 'next-run' });
      assert.equal(ack.status, 'steered');
      assert.equal(ack.item.target, 'next-step');
      assert.equal(
        rt.store.listApprovals({ status: 'pending' }).filter((row) => row.sessionId === sidBox.id).length,
        0
      );
      return { ok: true, content: 'probed' };
    }
  };
  const adapter = {
    name: 'bot-steer',
    async summarizeMessages() {
      return '';
    },
    async runTurn(input) {
      inputs.push(userTexts(input));
      if (inputs.length === 1) {
        return {
          stopReason: 'tool_use',
          assistantParts: [{ type: 'tool_call', toolCallId: 'c1', name: 'steer_probe', input: {} }]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'continued' }] };
    }
  };
  rt = runtimeWith(adapter, [tool]);
  rt.store.setDaemonControl('loop_settings', { steerInterruptPolicy: 'queue' });
  const bot = rt.createBot({ name: 'Super Bot' });
  sidBox.id = bot.canonicalSessionId;
  rt.store.appendMessage(sidBox.id, 'user', [{ type: 'text', text: 'start' }]);
  await rt.runSession(sidBox.id);
  assert.ok(inputs.length >= 2, JSON.stringify(inputs));
  assert.ok(!hasText(inputs[0], 'bot_midturn_note'));
  assert.ok(hasText(inputs[1], 'bot_midturn_note'), JSON.stringify(inputs));
  assert.equal(inputs.filter((row) => hasText(row, 'bot_midturn_note')).length, 1);
});

test('ordinary session still queues a running-turn message until the run ends [AC:bot-immediate-steer#AC-2]', async () => {
  const inputs = [];
  let rt;
  let ack;
  const tool = {
    name: 'steer_probe',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(ctx) {
      ack = rt.enqueueSteer(ctx.session.id, 'plain_midturn_note', { target: 'next-run' });
      return { ok: true, content: 'probed' };
    }
  };
  const adapter = {
    name: 'plain-steer',
    async summarizeMessages() {
      return '';
    },
    async runTurn(input) {
      inputs.push(userTexts(input));
      if (inputs.length === 1) {
        return {
          stopReason: 'tool_use',
          assistantParts: [{ type: 'tool_call', toolCallId: 'c1', name: 'steer_probe', input: {} }]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'continued' }] };
    }
  };
  rt = runtimeWith(adapter, [tool]);
  rt.store.setDaemonControl('loop_settings', { steerInterruptPolicy: 'queue' });
  const session = rt.createChatSession({ title: 'plain', message: 'start' });
  await rt.runSession(session.id);
  assert.equal(ack.status, 'started');
  assert.equal(ack.item.target, 'next-run');
  assert.ok(inputs.length >= 2, JSON.stringify(inputs));
  assert.ok(!hasText(inputs[1], 'plain_midturn_note'), JSON.stringify(inputs));
});

test('disabled steer still accepts a running canonical bot and still rejects a normal session [AC:bot-immediate-steer#AC-2] [AC:bot-immediate-steer#AC-3]', async () => {
  const adapter = {
    name: 'idle',
    async summarizeMessages() {
      return '';
    },
    async runTurn() {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
    }
  };
  const rt = runtimeWith(adapter);
  rt.store.setDaemonControl('loop_settings', { steerInterruptPolicy: 'disabled' });
  const bot = rt.createBot({ name: 'Desk' });
  rt.store.updateSession(bot.canonicalSessionId, { status: 'running' });
  const admitted = rt.enqueueSteer(bot.canonicalSessionId, 'keep going', { target: 'next-run' });
  assert.equal(admitted.status, 'steered');
  assert.equal(admitted.item.target, 'next-step');
  assert.equal(
    rt.store.listApprovals({ status: 'pending' }).filter((row) => row.sessionId === bot.canonicalSessionId).length,
    0
  );
  const loop = rt.createAgentLoop(bot.canonicalSessionId);
  const fromLoop = await loop.steer('from loop', { target: 'next-run' });
  assert.equal(fromLoop.status, 'steered');
  assert.equal(fromLoop.item.target, 'next-step');

  const plain = rt.createChatSession({ title: 'plain', message: 'hello' });
  rt.store.updateSession(plain.id, { status: 'running' });
  const rejected = rt.enqueueSteer(plain.id, 'nope');
  assert.equal(rejected.status, 'not_submitted');
  assert.equal(rejected.reason, 'steer_disabled');
});
