import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

const done = { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
test('recovery-owner handoff preserves another runtime live subagent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recovery-handoff-'));
  mkdirSync(join(dir, 'repo'));
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const options = { repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'), modelAdapter: {
    name: 'handoff', summarizeMessages: async () => '',
    runTurn: async () => { entered(); await gate; return done; }
  } };
  const owner = new RawAgentRuntime(options), worker = new RawAgentRuntime(options);
  let successor, active;
  try {
    const session = worker.store.createSession({ title: 'child', mode: 'subagent', agentId: 'general' });
    worker.store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hold' }]);
    active = worker.runSession(session.id); await ready;
    const before = worker.getSession(session.id);
    await owner.destroy();
    successor = new RawAgentRuntime(options);
    assert.deepEqual(worker.getSession(session.id), before);
  } finally {
    release(); await active?.catch(() => {});
    await successor?.destroy(); await worker.destroy();
    if (owner.store.db.isOpen) await owner.destroy();
  }
});
test('a second runtime cannot recover a still-live owner session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-runtime-owner-'));
  mkdirSync(join(dir, 'repo'));
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const options = { repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'), modelAdapter: {
    name: 'owner-probe', summarizeMessages: async () => '',
    async runTurn(input) {
      entered();
      await new Promise(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', resolve, { once: true }); });
      return done;
    }
  } };
  const first = new RawAgentRuntime(options);
  let second, active;
  try {
    const s = first.createChatSession({ message: 'hold' });
    active = first.runSession(s.id);
    await ready;
    const before = first.getSession(s.id);
    second = new RawAgentRuntime(options);
    assert.deepEqual(second.getSession(s.id), before);
    await second.destroy(); second = undefined;
    assert.deepEqual(first.getSession(s.id), before);
    first.cancelSession(s.id); await active;
  } finally {
    if (second) await second.destroy();
    first.cancelAllSessions(); if (active) await active.catch(() => {});
    await first.destroy(); rmSync(dir, { recursive: true, force: true });
  }
});
