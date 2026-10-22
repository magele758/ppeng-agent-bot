import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RawAgentRuntime,
  createMockLlm,
  mockText,
  mockToolUse,
  writeDynToolSettings
} from '../dist/exports/public.js';
import { createSaveAsTool, createDynToolStore } from '../dist/dyn-tools/index.js';

function ctx(session) {
  return {
    repoRoot: process.cwd(),
    stateDir: process.cwd(),
    session,
    agent: { id: 'main', name: 'Main', role: 'assistant', instructions: '', capabilities: [] }
  };
}

test('save_as_tool without last program and without code fails', async () => {
  const store = createDynToolStore();
  const kv = {
    map: new Map([['dyn_tool_settings', { enabled: true, allowSave: true, allowPropose: true, allowProjectPromote: true }]]),
    getDaemonControl(key) {
      return this.map.get(key);
    },
    setDaemonControl(key, value) {
      this.map.set(key, value);
    }
  };
  writeDynToolSettings(kv, { enabled: true, allowSave: true });
  const tool = createSaveAsTool({ getStore: () => store, settingsStore: kv });
  const result = await tool.execute(
    ctx({
      id: 's1',
      metadata: {},
      title: 't',
      mode: 'chat',
      status: 'idle',
      agentId: 'main',
      background: false,
      todo: [],
      createdAt: '',
      updatedAt: ''
    }),
    { name: 'add_one', description: 'add' }
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /ptc_exec|code/i);
});

test('AE1 MockLLM: save_as_tool then next turn tools[] contains name and cell runs', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dyn-save-repo-'));
  mkdirSync(join(repoRoot, 'docs'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs', 'readme.md'), 'hello');
  const stateDir = mkdtempSync(join(tmpdir(), 'dyn-save-state-'));
  const model = createMockLlm([
    mockToolUse({
      name: 'save_as_tool',
      input: {
        name: 'add_one',
        description: 'increment',
        code: 'return args.x + 1',
        inputSchema: { type: 'object', properties: { x: { type: 'number' } } }
      }
    }),
    mockToolUse({ name: 'add_one', input: { x: 1 } }),
    mockText('done')
  ]);
  const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: model });
  runtime.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  writeDynToolSettings(runtime.store, {
    enabled: true,
    allowSave: true,
    allowPropose: true
  });
  const session = runtime.createChatSession({
    title: 'harvest',
    message: 'save then call',
    metadata: { taskRunMode: 'dynamic_workflow', orchestrationEngine: 'ptc' }
  });
  const result = await runtime.runSession(session.id);
  assert.equal(result.status, 'idle');
  const second = model.calls[1];
  assert.ok(second, 'expected a second model turn');
  assert.ok(
    second.tools.some((t) => t.name === 'add_one'),
    `second turn tools=${second.tools.map((t) => t.name).join(',')}`
  );
  const msgs = runtime.getSessionMessages(session.id);
  const results = msgs.flatMap((m) => m.parts).filter((p) => p.type === 'tool_result');
  const dyn = results.find((p) => p.name === 'add_one');
  assert.ok(dyn);
  assert.equal(dyn.ok, true);
  assert.match(dyn.content, /2/);
});
