import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import {
  gateMandatorySkills,
  noteLoadedSkill,
  resetLoadedMandatorySkills,
  MANDATORY_SKILL_NAMES
} from '../dist/skills/mandatory-skill-gate.js';
import { loadWorkspaceSkills } from '../dist/skills/skill-registry.js';
import { executeSingleTool } from '../dist/runtime/tool-loop.js';
import { SqliteStateStore } from '../dist/storage.js';

const repoRoot = join(fileURLToPath(new URL('../../..', import.meta.url)));

test('workspace skills include bundled shopping skill [AC:shopping-mandatory-skill#AC-1]', async () => {
  const skills = await loadWorkspaceSkills(repoRoot);
  const shopping = skills.find((skill) => skill.name.toLowerCase() === 'shopping');
  assert.ok(shopping, 'skills/shopping must be discoverable via loadWorkspaceSkills');
  assert.equal(shopping.source, 'workspace');
  assert.ok(shopping.manifest, 'shopping skill must ship a sibling Manifest');
  const allowed = new Set((shopping.manifest.allowTools ?? []).map((name) => name.toLowerCase()));
  assert.ok(allowed.has('vault_fill'));
  assert.ok(allowed.has('browser_click'));
  assert.ok(allowed.has('browser_type'));
  assert.match(shopping.content, /vault_fill/i);
  assert.match(shopping.content, /checkout|purchase/i);
  assert.match(shopping.content, /plaintext/i);
  assert.match(shopping.content, /Grok|Canvas/i);
  assert.match(shopping.content, /login/i);
});

test('without load_skill(shopping) vault_fill / checkout browser stay fail-closed [AC:shopping-mandatory-skill#AC-2]', () => {
  assert.equal(gateMandatorySkills([], 'vault_fill', { fields: [] }).ok, false);
  assert.match(gateMandatorySkills([], 'vault_fill', { fields: [] }).content, /load_skill\(shopping\)/);
  assert.equal(gateMandatorySkills([], 'browser_click', { checkout: true }).ok, false);
  assert.match(gateMandatorySkills([], 'browser_click', { checkout: true }).content, /load_skill\(shopping\)/);
});

test('load_skill(shopping) unlocks vault_fill (non-card) [AC:shopping-mandatory-skill#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shopping-mandatory-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'shopping', mode: 'chat', metadata: {} });
  t.after(() => {
    resetLoadedMandatorySkills(session.id);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const tools = createBuiltinTools({
    loadSkill: async () => ({ content: 'shopping skill body', skillId: 'shopping', skillName: 'shopping' })
  });
  const load = tools.find((item) => item.name === 'load_skill');
  assert.ok(load);
  const loaded = await load.execute(context, { name: 'shopping' });
  assert.equal(loaded.ok, true);
  assert.ok(session.metadata.loadedSkillNames.map((name) => name.toLowerCase()).includes('shopping'));

  let ran = 0;
  const vaultFill = {
    name: 'vault_fill',
    description: 'vault_fill',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      ran += 1;
      return { ok: true, content: 'fill-ok' };
    }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [vaultFill],
    modelAdapter: {
      name: 'test',
      runTurn: async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }),
      summarizeMessages: async () => ''
    },
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
  const result = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'f1', name: 'vault_fill', input: { fields: [{ ref: 'entry:username' }] } },
    context,
    false,
    session.id
  );
  assert.equal(ran, 1);
  assert.equal(result.ok, true);
  assert.equal(MANDATORY_SKILL_NAMES.shopping, 'shopping');
  const sessionId = 'shopping-note';
  t.after(() => resetLoadedMandatorySkills(sessionId));
  assert.equal(gateMandatorySkills(noteLoadedSkill(sessionId, 'shopping', null, {}), 'browser_type', { purchase: true }).ok, true);
});
