import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { validateSkillManifest } from '../dist/skills/skill-manifest.js';
import {
  gateMandatorySkills,
  mandatorySkillsForTool,
  noteLoadedSkill,
  resetLoadedMandatorySkills,
  MANDATORY_SKILL_NAMES
} from '../dist/skills/mandatory-skill-gate.js';
import { executeSingleTool } from '../dist/runtime/tool-loop.js';
import { SqliteStateStore } from '../dist/storage.js';

const adapter = {
  name: 'test',
  runTurn: async () => ({ stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] }),
  summarizeMessages: async () => ''
};

function sessionFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mandatory-skill-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'gate', mode: 'chat', metadata: {} });
  t.after(() => {
    resetLoadedMandatorySkills(session.id);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, session };
}

function tool(name) {
  let ran = 0;
  return {
    ran: () => ran,
    contract: {
      name,
      description: name,
      inputSchema: { type: 'object' },
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => {
        ran += 1;
        return { ok: true, content: 'ran' };
      }
    }
  };
}

test('gated tool without load_skill fails closed and does not run [AC:mandatory-skill-gate#AC-1]', async (t) => {
  const { dir, store, session } = sessionFixture(t);
  const vault = tool('vault_fill');
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const deps = { store, stateDir: dir, tools: [vault.contract], modelAdapter: adapter, maxParallelToolCalls: 1, emitTrace() {} };
  const denied = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'fill', name: 'vault_fill', input: { fields: [] } },
    context,
    false,
    session.id
  );
  assert.equal(vault.ran(), 0);
  assert.equal(denied.ok, false);
  assert.match(denied.content, /load_skill\(shopping\)/);
});

test('load_skill of the required name lets the gated tool proceed [AC:mandatory-skill-gate#AC-2]', async (t) => {
  const { dir, store, session } = sessionFixture(t);
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const tools = createBuiltinTools({
    loadSkill: async () => ({ content: 'shop carefully', skillId: 'shopping' })
  });
  const load = tools.find((item) => item.name === 'load_skill');
  assert.ok(load);
  const loaded = await load.execute(context, { name: 'shopping' });
  assert.equal(loaded.ok, true);
  assert.ok(session.metadata.loadedSkillNames.map((name) => name.toLowerCase()).includes('shopping'));

  const vault = tool('vault_fill');
  const deps = { store, stateDir: dir, tools: [vault.contract], modelAdapter: adapter, maxParallelToolCalls: 1, emitTrace() {} };
  const allowed = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'fill', name: 'vault_fill', input: { fields: [{ ref: 'uvref:1:username', selector: '#user' }] } },
    context,
    false,
    session.id
  );
  assert.equal(vault.ran(), 1);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.content, 'ran');
});

test('ungated tools are not blocked when no skill is loaded [AC:mandatory-skill-gate#AC-3]', async (t) => {
  const { dir, store, session } = sessionFixture(t);
  const read = tool('read_file');
  const browse = tool('browser_click');
  const context = {
    session,
    repoRoot: dir,
    stateDir: dir,
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [read.contract, browse.contract],
    modelAdapter: adapter,
    maxParallelToolCalls: 1,
    emitTrace() {}
  };
  const readResult = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'read', name: 'read_file', input: { path: 'a.ts' } },
    context,
    false,
    session.id
  );
  const click = await executeSingleTool(
    deps,
    { type: 'tool_call', toolCallId: 'click', name: 'browser_click', input: { selector: '#nav' } },
    context,
    false,
    session.id
  );
  assert.equal(read.ran(), 1);
  assert.equal(browse.ran(), 1);
  assert.equal(readResult.ok, true);
  assert.equal(click.ok, true);
});

test('gate helper covers each high-risk surface and ignores other tools [AC:mandatory-skill-gate#AC-4]', () => {
  assert.deepEqual(
    mandatorySkillsForTool('vault_fill', {}).map((item) => item.surface),
    ['shopping']
  );
  assert.deepEqual(
    mandatorySkillsForTool('vault_fill', { fields: [{ ref: 'uvref:card:cardNumber', selector: '#pan' }] }).map((item) => item.skills[0]),
    [MANDATORY_SKILL_NAMES.shopping, MANDATORY_SKILL_NAMES.payment]
  );
  assert.equal(mandatorySkillsForTool('collect_credentials', {})[0].skills[0], MANDATORY_SKILL_NAMES.login);
  assert.equal(mandatorySkillsForTool('vault_get', { id: '1' })[0].skills[0], MANDATORY_SKILL_NAMES.login);
  assert.equal(mandatorySkillsForTool('schedule_social_post', { body: 'hi' })[0].skills[0], MANDATORY_SKILL_NAMES.outboundSend);
  assert.equal(mandatorySkillsForTool('secure_form', { field: 'otp' }).length, 0);
  assert.equal(mandatorySkillsForTool('secure_form', { field: 'cvv' })[0].skills[0], MANDATORY_SKILL_NAMES.payment);
  assert.equal(mandatorySkillsForTool('secure_form', { field: 'cardNumber' })[0].skills[0], MANDATORY_SKILL_NAMES.payment);
  assert.equal(mandatorySkillsForTool('browser_click', { selector: '#a' }).length, 0);
  assert.equal(mandatorySkillsForTool('browser_type', { checkout: true }).length, 1);
  assert.equal(mandatorySkillsForTool('browser_click', {}, { checkout: true })[0].surface, 'shopping');
  assert.equal(mandatorySkillsForTool('read_file', { path: 'a.ts' }).length, 0);

  const denied = gateMandatorySkills([], 'collect_credentials', {});
  assert.equal(denied.ok, false);
  assert.match(denied.content, /load_skill\(login\)/);
  const opened = gateMandatorySkills(['login'], 'collect_credentials', {});
  assert.equal(opened.ok, true);
  const card = gateMandatorySkills(['shopping'], 'vault_fill', {
    fields: [{ ref: 'uvref:1:cvv', selector: '#cvv' }]
  });
  assert.equal(card.ok, false);
  assert.match(card.content, /load_skill\(payment\)/);
  const both = gateMandatorySkills(['Shopping', 'payment'], 'vault_fill', {
    fields: [{ ref: 'uvref:1:cvv', selector: '#cvv' }]
  });
  assert.equal(both.ok, true);
  assert.equal(gateMandatorySkills([], 'bash', { command: 'echo hi' }).ok, true);
});

test('Manifest requiredSkills are satisfied by loading the declaring skill [AC:mandatory-skill-gate#AC-2]', (t) => {
  const parsed = validateSkillManifest({
    version: '1',
    allowTools: ['vault_fill'],
    requiredSkills: ['shopping', 'payment']
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const sessionId = 'manifest-required-skills';
  t.after(() => resetLoadedMandatorySkills(sessionId));
  noteLoadedSkill(sessionId, 'checkout-helper', parsed.manifest, {});
  const decision = gateMandatorySkills(
    noteLoadedSkill(sessionId, 'checkout-helper', parsed.manifest, {}),
    'vault_fill',
    { fields: [{ ref: 'uvref:1:cardNumber', selector: '#pan' }] }
  );
  assert.equal(decision.ok, true);
  assert.equal(validateSkillManifest({ version: '1', requiredSkills: ['bad name'] }).ok, false);
});
