/**
 * Verify the domain-bundle extension points on RawAgentRuntime:
 *   1. extraTools append, never replace builtins.
 *   2. extraAgents append, builtin personas remain.
 *   3. extraSkills surface in PromptBuilder.allSkills().
 *   4. AgentSpec.allowedTools narrows the per-turn tool list.
 *   5. mergeDomainBundles dedupes by id/name and stamps domainId.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { mergeDomainBundles } from '../dist/domain.js';

class CapturingAdapter {
  constructor() {
    this.name = 'capture';
    this.lastTools = undefined;
  }
  async runTurn(input) {
    this.lastTools = input.tools.map((t) => t.name);
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  }
  async summarizeMessages() {
    return '';
  }
}

function makeDirs() {
  return {
    repoRoot: mkdtempSync(join(tmpdir(), 'rt-extras-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'rt-extras-state-')),
  };
}

const dummyTool = (name, sideEffect = 'none') => ({
  name,
  description: `dummy ${name}`,
  inputSchema: { type: 'object', properties: {} },
  approvalMode: 'never',
  sideEffectLevel: sideEffect,
  async execute() {
    return { ok: true, content: '' };
  },
});

const dummyAgent = (id, allowedTools, domainId) => ({
  id,
  name: id,
  role: `dummy ${id}`,
  instructions: 'dummy',
  capabilities: [],
  allowedTools,
  domainId,
});

test('extraTools append on top of builtins', () => {
  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new CapturingAdapter(),
    extraTools: [dummyTool('demo_tool')],
  });
  const names = rt.tools.map((t) => t.name);
  assert.ok(names.includes('demo_tool'), 'extraTool should be present');
  assert.ok(names.includes('read_file'), 'builtin tool should still be present');
});

test('extraAgents append on top of builtinAgents', () => {
  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new CapturingAdapter(),
    extraAgents: [dummyAgent('demo-agent', undefined, 'demo')],
  });
  const ids = rt.listAgents().map((a) => a.id);
  assert.ok(ids.includes('demo-agent'), 'extra agent should be persisted');
  assert.ok(ids.includes('general'), 'builtin general agent should still exist');
});

test('extraSkills appear in PromptBuilder.allSkills()', async () => {
  const { repoRoot, stateDir } = makeDirs();
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: new CapturingAdapter(),
    extraSkills: [
      {
        id: 'demo-skill',
        name: 'Demo Skill',
        description: 'verifies extraSkills wiring',
        content: 'just a marker',
        source: 'agents',
      },
    ],
  });
  const skills = await rt.promptBuilder.allSkills();
  assert.ok(
    skills.some((s) => s.id === 'demo-skill'),
    'extraSkills should be merged into the skill pool'
  );
});

test('agent.allowedTools filters the per-turn tool list', async () => {
  const { repoRoot, stateDir } = makeDirs();
  const adapter = new CapturingAdapter();
  const rt = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: adapter,
    extraTools: [dummyTool('only_this')],
    extraAgents: [dummyAgent('narrow', ['only_this'], 'demo')],
  });
  rt.store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});

  const session = rt.createChatSession({ agentId: 'narrow', title: 'narrow' });
  await rt.runSession(session.id);

  assert.deepEqual(adapter.lastTools, ['only_this'], 'turnTools should be scoped to allowedTools');
});

test('mergeDomainBundles dedupes by agent.id and tool.name and stamps domainId', () => {
  const a = {
    id: 'foo',
    label: 'Foo',
    agents: [
      { id: 'foo-agent', name: 'foo', role: 'r', instructions: 'i', capabilities: [] },
    ],
    tools: [dummyTool('foo_tool')],
    skills: [{ id: 'foo-skill', name: 'Foo Skill', description: 'd' }],
  };
  const b = {
    id: 'bar',
    label: 'Bar',
    agents: [
      { id: 'foo-agent', name: 'foo dup', role: 'r', instructions: 'i', capabilities: [] },
      { id: 'bar-agent', name: 'bar', role: 'r', instructions: 'i', capabilities: [], domainId: 'override' },
    ],
    tools: [dummyTool('foo_tool'), dummyTool('bar_tool')],
    skills: [{ id: 'bar-skill', name: 'Bar Skill', description: 'd' }],
  };
  const merged = mergeDomainBundles([a, b]);
  assert.deepEqual(
    merged.agents.map((x) => x.id),
    ['foo-agent', 'bar-agent']
  );
  // First wins for foo-agent → defaulted to bundle id "foo"
  assert.equal(merged.agents.find((x) => x.id === 'foo-agent').domainId, 'foo');
  // Author-provided domainId on bar-agent is preserved
  assert.equal(merged.agents.find((x) => x.id === 'bar-agent').domainId, 'override');
  assert.deepEqual(
    merged.tools.map((x) => x.name),
    ['foo_tool', 'bar_tool']
  );
  assert.deepEqual(
    merged.skills.map((x) => x.name),
    ['Foo Skill', 'Bar Skill']
  );
});
