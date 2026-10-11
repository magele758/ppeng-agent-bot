import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { writeCompactSettings } from '../dist/session/compact-settings.js';
import { buildSessionModelView } from '../dist/session/model-view.js';
import {
  HeuristicModelAdapter,
  HEURISTIC_LONG_BASH_COMMAND,
  HEURISTIC_LONG_BASH_MARKER
} from '../dist/model/model-adapters.js';

function msg(id, role, parts) {
  return {
    id,
    sessionId: 's',
    role,
    parts,
    createdAt: '2026-09-02T00:00:00.000Z'
  };
}

test('heuristic lists files even when working-log appendix repeats 你好', async () => {
  const adapter = new HeuristicModelAdapter();
  const result = await adapter.runTurn({
    agent: { id: 'general', role: 'assistant', name: 'general' },
    systemPrompt: '',
    messages: [
      msg('u1', 'user', [
        {
          type: 'text',
          text: '[working log — durable trail across compaction; full transcripts at the referenced paths]\n你好，我现在已经是一个基于工具循环的裸 agent runtime 了。'
        },
        { type: 'text', text: '列出文件' }
      ])
    ],
    tools: []
  });
  assert.equal(result.stopReason, 'tool_use');
  assert.equal(result.assistantParts[0].name, 'read_file');
});

test('heuristic session: 列出文件 after 你好 stores a tool_result', async () => {
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'heuristic-ls-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'heuristic-ls-state-'))
  });
  const session = runtime.createChatSession({ title: 'ls', message: '你好' });
  await runtime.runSession(session.id);
  runtime.sendUserMessage(session.id, '列出文件');
  await runtime.runSession(session.id);
  const stored = runtime.getSessionMessages(session.id);
  const tool = stored.find(
    (m) => m.role === 'tool' && m.parts.some((p) => p.type === 'tool_result')
  );
  assert.ok(tool?.id, 'expected stored tool_result with message id');
  await runtime.destroy();
});

test('heuristic fires long bash once, then replies with text', async () => {
  const adapter = new HeuristicModelAdapter();
  const user = msg('u1', 'user', [{ type: 'text', text: '跑一段长 bash dump' }]);
  const first = await adapter.runTurn({
    agent: { id: 'general', role: 'assistant', name: 'general' },
    systemPrompt: '',
    messages: [user],
    tools: []
  });
  assert.equal(first.stopReason, 'tool_use');
  assert.equal(first.assistantParts[0].name, 'bash');
  assert.equal(first.assistantParts[0].input.command, HEURISTIC_LONG_BASH_COMMAND);
  assert.match(HEURISTIC_LONG_BASH_COMMAND, new RegExp(HEURISTIC_LONG_BASH_MARKER));

  const afterTool = await adapter.runTurn({
    agent: { id: 'general', role: 'assistant', name: 'general' },
    systemPrompt: '',
    messages: [
      user,
      msg('a1', 'assistant', first.assistantParts),
      msg('t1', 'tool', [
        {
          type: 'tool_result',
          toolCallId: first.assistantParts[0].toolCallId,
          name: 'bash',
          ok: true,
          content: `${HEURISTIC_LONG_BASH_MARKER}${'x'.repeat(180)}`
        }
      ])
    ],
    tools: []
  });
  assert.equal(afterTool.stopReason, 'end');
  assert.ok(afterTool.assistantParts.some((p) => p.type === 'text' && p.text.includes('Heuristic')));
});

test('heuristic session: after_text model view stubs consumed long bash', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'heuristic-bash-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'heuristic-bash-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new HeuristicModelAdapter()
  });
  writeCompactSettings(runtime.store, { policy: 'after_text_assistant' });
  const session = runtime.createChatSession({
    title: 'long-bash',
    message: '跑一段长 bash dump'
  });
  const first = await runtime.runSession(session.id);
  assert.equal(first.status, 'idle');
  runtime.sendUserMessage(session.id, 'hello 再看一眼');
  const second = await runtime.runSession(session.id);
  assert.equal(second.status, 'idle');

  const stored = runtime.getSessionMessages(session.id);
  const tool = stored
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool_result' && p.name === 'bash');
  assert.ok(tool && tool.type === 'tool_result');
  assert.match(tool.content, new RegExp(HEURISTIC_LONG_BASH_MARKER));
  assert.ok(tool.content.length > 100);

  const keep = buildSessionModelView({
    messages: stored,
    store: runtime.store,
    env: {},
    config: {
      enabled: true,
      keepRecent: 3,
      minChars: 100,
      hardMaxChars: 12_000,
      policy: 'keep_recent'
    }
  });
  const after = buildSessionModelView({
    messages: stored,
    store: runtime.store,
    env: {}
  });
  assert.equal(after.policy, 'after_text_assistant');
  assert.notEqual(keep.stats.collapsed, after.stats.collapsed);
  assert.equal(after.stats.collapsed, 1);
  assert.match(
    after.modelView.flatMap((m) => m.parts).find((p) => p.type === 'tool_result').content,
    /omitted to save space/
  );
  assert.match(
    keep.modelView.flatMap((m) => m.parts).find((p) => p.type === 'tool_result').content,
    new RegExp(HEURISTIC_LONG_BASH_MARKER)
  );
});
