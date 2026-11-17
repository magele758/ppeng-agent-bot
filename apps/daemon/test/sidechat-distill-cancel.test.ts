import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawAgentRuntime, type ModelAdapter, type ModelTurnInput } from '@ppeng/agent-core';
import { SidechatGeneration } from '../dist/sidechat-generation.js';

const answer = (text: string) => ({ stopReason: 'end' as const, assistantParts: [{ type: 'text' as const, text }] });

function fixture(t: TestContext, runTurn: ModelAdapter['runTurn']) {
  const dir = mkdtempSync(join(tmpdir(), 'sidechat-distill-'));
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: join(dir, 'state'),
    modelAdapter: { name: 'test', runTurn, summarizeMessages: async () => '' }
  });
  t.after(async () => {
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = runtime.createChatSession({ agentId: 'general', title: 'Source' });
  const makeThread = (requestId: string) => {
    const started = runtime.store.sidechats.start('local', {
      sessionId: session.id, messageId: 'reply', agentId: 'general', requestId,
      question: 'Explain this', anchor: { kind: 'message', quote: 'Source answer' }
    });
    runtime.store.sidechats.finish(started.thread.id, started.runId!, 'complete', 'Completed answer');
    return runtime.store.sidechats.get('local', [session.id], started.thread.id)!;
  };
  return { generation: new SidechatGeneration(runtime, {}), session, makeThread };
}

test('删除批注会取消它的全部凝练请求，其他批注继续 [AC:sidechat-delete#AC-3]', async (t) => {
  const calls: { input: ModelTurnInput; release: () => void }[] = [];
  const f = fixture(t, async (input) => {
    await new Promise<void>((resolve, reject) => {
      calls.push({ input, release: resolve });
      input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true });
    });
    return answer('Condensed note');
  });
  const deleted = f.makeThread('deleted');
  const kept = f.makeThread('kept');
  const first = f.generation.distill(deleted, f.session, undefined);
  const second = f.generation.distill(deleted, f.session, undefined);
  const other = f.generation.distill(kept, f.session, undefined);
  const rejected = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  f.generation.discard(deleted);
  assert.equal(calls[0].input.signal!.aborted, true);
  assert.equal(calls[1].input.signal!.aborted, true);
  assert.equal(calls[2].input.signal!.aborted, false);
  calls[2].release();
  await Promise.all(rejected);
  assert.equal(await other, 'Condensed note');
});

test('模型忽略取消后返回的凝练不能成为可保存结果 [AC:sidechat-delete#AC-3]', async (t) => {
  let release!: () => void;
  const f = fixture(t, async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return answer('Late note');
  });
  const thread = f.makeThread('deleted');
  const pending = f.generation.distill(thread, f.session, undefined);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  f.generation.discard(thread);
  release();
  await rejected;
});
