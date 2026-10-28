import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { PLANNING_SKILL_MANIFEST } from '../dist/skills/skill-manifest.js';
import { loadWorkspaceSkills } from '../dist/skills/skill-registry.js';
import {
  gateActiveSkillManifests,
  noteActiveSkillManifest,
  resetActiveSkillManifests
} from '../dist/skills/skill-manifest-gate.js';
import { executeSingleTool, executeToolCalls } from '../dist/runtime/tool-loop.js';
import { SqliteStateStore } from '../dist/storage.js';

const adapter = {
  name: 'test',
  runTurn: async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }),
  summarizeMessages: async () => ''
};

function sessionFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'skill-manifest-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'manifest', mode: 'chat', metadata: {} });
  t.after(() => {
    resetActiveSkillManifests(session.id);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, session };
}

test('loaded skill cannot run shell or fetch, and the tool loop does not execute them [AC:skill-manifest-boundary#AC-1]', async (t) => {
  const { dir, store, session } = sessionFixture(t);
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const tools = createBuiltinTools({
    loadSkill: async () => ({ content: 'plan', manifest: PLANNING_SKILL_MANIFEST, skillId: 'planning' })
  });
  const load = tools.find((tool) => tool.name === 'load_skill');
  assert.ok(load);
  const loaded = await load.execute(context, { name: 'Planning' });
  assert.equal(loaded.ok, true);
  resetActiveSkillManifests(session.id);
  assert.ok(Array.isArray(session.metadata.activeSkillManifests));

  let ran = 0;
  const bash = {
    name: 'bash',
    description: 'bash',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    execute: async () => {
      ran += 1;
      return { ok: true, content: 'ran' };
    }
  };
  const fetchTool = {
    name: 'web_fetch',
    description: 'fetch',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      ran += 1;
      return { ok: true, content: 'fetched' };
    }
  };
  const deps = { store, stateDir: dir, tools: [bash, fetchTool], modelAdapter: adapter, maxParallelToolCalls: 1, emitTrace() {} };
  const shell = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'shell', name: 'bash', input: { command: 'echo hi' } },
    context,
    false,
    session.id
  );
  const fetched = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'fetch', name: 'web_fetch', input: { url: 'https://evil.test/x' } },
    context,
    false,
    session.id
  );
  assert.equal(ran, 0);
  assert.equal(shell.ok, false);
  assert.match(shell.content, /skill manifest/);
  assert.equal(fetched.ok, false);
  assert.match(fetched.content, /skill manifest/);
});

test('path escape is refused before the file tool runs [AC:skill-manifest-boundary#AC-2]', async (t) => {
  const { dir, store, session } = sessionFixture(t);
  const manifest = {
    version: '1',
    allowTools: ['read_file'],
    allowPaths: ['/workspace'],
    network: { mode: 'none' }
  };
  session.metadata = { activeSkillManifests: [manifest] };
  let ran = 0;
  const read = {
    name: 'read_file',
    description: 'read',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      ran += 1;
      return { ok: true, content: 'secret' };
    }
  };
  const deps = { store, stateDir: dir, tools: [read], modelAdapter: adapter, maxParallelToolCalls: 1, emitTrace() {} };
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const escaped = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'read', name: 'read_file', input: { path: '/workspace/../etc/passwd' } },
    context,
    false,
    session.id
  );
  assert.equal(ran, 0);
  assert.equal(escaped.ok, false);
  assert.match(escaped.content, /allowPaths|denied by skill manifest/);
  const allowed = gateActiveSkillManifests([manifest], 'read_file', { path: '/workspace/src/a.ts' });
  assert.equal(allowed.ok, true);
});

test('shell without a listed host is refused, and load_skill wins the same wave [AC:skill-manifest-boundary#AC-4]', async (t) => {
  const offline = {
    version: '1',
    allowTools: ['load_skill', 'bash'],
    network: { mode: 'none' }
  };
  assert.equal(gateActiveSkillManifests([offline], 'bash', { command: 'echo hi' }).ok, false);
  const listed = {
    version: '1',
    allowTools: ['bash'],
    network: { mode: 'allowlist', hosts: ['example.com'] }
  };
  assert.equal(gateActiveSkillManifests([listed], 'bash', { command: 'curl https://api.example.com/x' }).ok, true);
  assert.equal(gateActiveSkillManifests([listed], 'bash', { command: 'python -c "print(1)"' }).ok, false);

  const { dir, store, session } = sessionFixture(t);
  const order = [];
  const load = {
    name: 'load_skill',
    description: 'load',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async (ctx) => {
      order.push('load');
      noteActiveSkillManifest(ctx.session.id, offline);
      ctx.session.metadata = { ...(ctx.session.metadata ?? {}), activeSkillManifests: [offline] };
      return { ok: true, content: 'loaded' };
    }
  };
  const bash = {
    name: 'bash',
    description: 'bash',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    execute: async () => {
      order.push('bash');
      return { ok: true, content: 'PWNED_NET' };
    }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [load, bash],
    modelAdapter: adapter,
    maxParallelToolCalls: 4,
    emitTrace() {}
  };
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const results = await executeToolCalls(
    deps,
    [
      { type: 'tool_call', toolCallId: 'bash-1', name: 'bash', input: { command: 'echo hi' } },
      { type: 'tool_call', toolCallId: 'load-1', name: 'load_skill', input: { name: 'Net' } }
    ],
    context,
    false,
    session.id
  );
  assert.deepEqual(order, ['load']);
  assert.equal(results[0].toolCallId, 'bash-1');
  assert.equal(results[0].ok, false);
  assert.match(results[0].content, /network|skill manifest/);
  assert.doesNotMatch(results[0].content, /PWNED_NET/);
  assert.equal(results[1].toolCallId, 'load-1');
  assert.equal(results[1].ok, true);
});

test('broken sibling manifest does not load the skill unconstrained [AC:skill-manifest-boundary#AC-3]', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-tree-'));
  try {
    const badDir = join(root, 'skills', 'bad-skill');
    const goodDir = join(root, 'skills', 'good-skill');
    mkdirSync(badDir, { recursive: true });
    mkdirSync(goodDir, { recursive: true });
    writeFileSync(join(badDir, 'SKILL.md'), '---\nname: Bad\ndescription: broken\n---\nbody\n');
    writeFileSync(join(badDir, 'skill.manifest.json'), '{');
    writeFileSync(join(goodDir, 'SKILL.md'), '---\nname: Good\ndescription: ok\n---\nbody\n');
    writeFileSync(
      join(goodDir, 'skill.manifest.json'),
      JSON.stringify({ version: '1', allowTools: ['read_file'], network: 'none' })
    );
    const skills = await loadWorkspaceSkills(root);
    assert.equal(skills.some((skill) => skill.name === 'Bad'), false);
    const good = skills.find((skill) => skill.name === 'Good');
    assert.ok(good);
    assert.equal(good.manifest?.version, '1');
    assert.equal(gateActiveSkillManifests([good.manifest], 'bash', { command: 'echo hi' }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
