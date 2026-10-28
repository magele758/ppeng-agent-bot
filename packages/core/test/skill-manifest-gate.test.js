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
  resetActiveSkillManifests
} from '../dist/skills/skill-manifest-gate.js';
import { executeSingleTool } from '../dist/runtime/tool-loop.js';
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
