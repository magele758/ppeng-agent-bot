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

test('workspace skills include bundled payment skill [AC:payment-mandatory-skill#AC-1]', async () => {
  const skills = await loadWorkspaceSkills(repoRoot);
  const payment = skills.find((skill) => skill.name.toLowerCase() === 'payment');
  assert.ok(payment, 'skills/payment must be discoverable via loadWorkspaceSkills');
  assert.equal(payment.source, 'workspace');
  assert.ok(payment.manifest, 'payment skill must ship a sibling Manifest');
  const allowed = new Set((payment.manifest.allowTools ?? []).map((name) => name.toLowerCase()));
  assert.ok(allowed.has('secure_form'));
  assert.ok(allowed.has('vault_fill'));
  assert.match(payment.content, /cardNumber|CVV|card/i);
  assert.match(payment.content, /NEVER|never/i);
  assert.match(payment.content, /login/i);
  assert.match(payment.content, /plaintext|secret/i);
});

test('without load_skill(payment) card secure_form / card vault_fill stay fail-closed [AC:payment-mandatory-skill#AC-2]', () => {
  assert.equal(gateMandatorySkills([], 'secure_form', { field: 'cvv' }).ok, false);
  assert.match(gateMandatorySkills([], 'secure_form', { field: 'cvv' }).content, /load_skill\(payment\)/);
  const denied = gateMandatorySkills(['shopping'], 'vault_fill', {
    fields: [{ ref: 'entry:cardNumber' }]
  });
  assert.equal(denied.ok, false);
  assert.match(denied.content, /load_skill\(payment\)/);
});

test('load_skill(payment)+shopping unlocks card vault_fill; payment unlocks card secure_form [AC:payment-mandatory-skill#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'payment-mandatory-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'payment', mode: 'chat', metadata: {} });
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
    loadSkill: async ({ name }) => ({
      content: `${name} skill body`,
      skillId: name,
      skillName: name
    })
  });
  const load = tools.find((item) => item.name === 'load_skill');
  assert.ok(load);
  assert.equal((await load.execute(context, { name: 'shopping' })).ok, true);
  assert.equal((await load.execute(context, { name: 'payment' })).ok, true);
  const names = session.metadata.loadedSkillNames.map((name) => name.toLowerCase());
  assert.ok(names.includes('shopping'));
  assert.ok(names.includes('payment'));

  let formRan = 0;
  let fillRan = 0;
  const secureForm = {
    name: 'secure_form',
    description: 'secure_form',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      formRan += 1;
      return { ok: true, content: 'form-ok' };
    }
  };
  const vaultFill = {
    name: 'vault_fill',
    description: 'vault_fill',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      fillRan += 1;
      return { ok: true, content: 'fill-ok' };
    }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [secureForm, vaultFill],
    modelAdapter: {
      name: 'test',
      runTurn: async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }),
      summarizeMessages: async () => ''
    },
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
  const formResult = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'p1', name: 'secure_form', input: { field: 'cardNumber' } },
    context,
    false,
    session.id
  );
  const fillResult = await executeSingleTool(
    deps,
    {
      type: 'tool_call',
      toolCallId: 'p2',
      name: 'vault_fill',
      input: { fields: [{ ref: 'entry:cvv' }] }
    },
    context,
    false,
    session.id
  );
  assert.equal(formRan, 1);
  assert.equal(fillRan, 1);
  assert.equal(formResult.ok, true);
  assert.equal(fillResult.ok, true);
  assert.equal(MANDATORY_SKILL_NAMES.payment, 'payment');
  const sessionId = 'payment-note';
  t.after(() => resetLoadedMandatorySkills(sessionId));
  assert.equal(
    gateMandatorySkills(noteLoadedSkill(sessionId, 'payment', null, {}), 'secure_form', { field: 'card' }).ok,
    true
  );
});
