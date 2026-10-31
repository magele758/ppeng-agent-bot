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

test('workspace skills include bundled login skill with login-surface tools [AC:login-mandatory-skill#AC-1]', async () => {
  const skills = await loadWorkspaceSkills(repoRoot);
  const login = skills.find((skill) => skill.name.toLowerCase() === 'login');
  assert.ok(login, 'skills/login must be discoverable via loadWorkspaceSkills');
  assert.equal(login.source, 'workspace');
  assert.ok(login.manifest, 'login skill must ship a sibling Manifest');
  const allowed = new Set((login.manifest.allowTools ?? []).map((name) => name.toLowerCase()));
  assert.ok(allowed.has('collect_credentials'));
  assert.ok(allowed.has('vault_get'));
  assert.ok(allowed.has('vault_list'));
  assert.ok(allowed.has('secure_form'));
  assert.match(login.content, /vaultEntryId|entryId/i);
  assert.match(login.content, /vault_list/i);
  assert.match(login.content, /handoff/i);
  assert.match(login.content, /vault_fill/i);
  assert.match(login.content, /plaintext/i);
});

test('without load_skill(login) collect_credentials/vault_get stay fail-closed [AC:login-mandatory-skill#AC-2]', () => {
  assert.equal(gateMandatorySkills([], 'collect_credentials', {}).ok, false);
  assert.equal(gateMandatorySkills([], 'vault_get', { id: 'x' }).ok, false);
  assert.match(gateMandatorySkills([], 'collect_credentials', {}).content, /load_skill\(login\)/);
});

test('load_skill(login) unlocks collect_credentials and vault_get [AC:login-mandatory-skill#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'login-mandatory-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'login', mode: 'chat', metadata: {} });
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
    loadSkill: async () => ({ content: 'login skill body', skillId: 'login', skillName: 'login' })
  });
  const load = tools.find((item) => item.name === 'load_skill');
  assert.ok(load);
  const loaded = await load.execute(context, { name: 'login' });
  assert.equal(loaded.ok, true);
  assert.ok(session.metadata.loadedSkillNames.map((name) => name.toLowerCase()).includes('login'));

  let credRan = 0;
  let vaultRan = 0;
  const cred = {
    name: 'collect_credentials',
    description: 'collect_credentials',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      credRan += 1;
      return { ok: true, content: 'cred-ok' };
    }
  };
  const vaultGet = {
    name: 'vault_get',
    description: 'vault_get',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      vaultRan += 1;
      return { ok: true, content: 'vault-ok' };
    }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [cred, vaultGet],
    modelAdapter: {
      name: 'test',
      runTurn: async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }),
      summarizeMessages: async () => ''
    },
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
  const credResult = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'c1', name: 'collect_credentials', input: {} },
    context,
    false,
    session.id
  );
  const vaultResult = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'v1', name: 'vault_get', input: { id: '1' } },
    context,
    false,
    session.id
  );
  assert.equal(credRan, 1);
  assert.equal(vaultRan, 1);
  assert.equal(credResult.ok, true);
  assert.equal(vaultResult.ok, true);
  assert.equal(MANDATORY_SKILL_NAMES.login, 'login');
  // noteLoadedSkill path also satisfies the gate helper directly
  const sessionId = 'login-note';
  t.after(() => resetLoadedMandatorySkills(sessionId));
  assert.equal(gateMandatorySkills(noteLoadedSkill(sessionId, 'login', null, {}), 'vault_get', { id: '1' }).ok, true);
});
