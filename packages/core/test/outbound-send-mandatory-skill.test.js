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

test('workspace skills include bundled outbound-send skill [AC:outbound-send-mandatory-skill#AC-1]', async () => {
  const skills = await loadWorkspaceSkills(repoRoot);
  const outbound = skills.find((skill) => skill.name.toLowerCase() === 'outbound-send');
  assert.ok(outbound, 'skills/outbound-send must be discoverable via loadWorkspaceSkills');
  assert.equal(outbound.source, 'workspace');
  assert.ok(outbound.manifest, 'outbound-send skill must ship a sibling Manifest');
  const allowed = new Set((outbound.manifest.allowTools ?? []).map((name) => name.toLowerCase()));
  assert.ok(allowed.has('schedule_social_post'));
  assert.match(outbound.content, /Draft/i);
  assert.match(outbound.content, /Confirm/i);
  assert.match(outbound.content, /Send/i);
  assert.match(outbound.content, /style sampling/i);
  assert.match(outbound.content, /NEVER send without confirmation|without confirmation/i);
});

test('without load_skill(outbound-send) schedule_social_post stays fail-closed [AC:outbound-send-mandatory-skill#AC-2]', () => {
  assert.equal(gateMandatorySkills([], 'schedule_social_post', { body: 'hi', channels: ['x'], publish_at: '2099-01-01T00:00:00Z' }).ok, false);
  assert.match(
    gateMandatorySkills([], 'schedule_social_post', { body: 'hi', channels: ['x'], publish_at: '2099-01-01T00:00:00Z' }).content,
    /load_skill\(outbound-send\)/
  );
});

test('load_skill(outbound-send) unlocks schedule_social_post [AC:outbound-send-mandatory-skill#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-mandatory-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const session = store.createSession({ agentId: 'general', title: 'outbound', mode: 'chat', metadata: {} });
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
    loadSkill: async () => ({
      content: 'outbound skill body',
      skillId: 'outbound-send',
      skillName: 'outbound-send'
    })
  });
  const load = tools.find((item) => item.name === 'load_skill');
  assert.ok(load);
  const loaded = await load.execute(context, { name: 'outbound-send' });
  assert.equal(loaded.ok, true);
  assert.ok(session.metadata.loadedSkillNames.map((name) => name.toLowerCase()).includes('outbound-send'));

  let ran = 0;
  const schedule = {
    name: 'schedule_social_post',
    description: 'schedule_social_post',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      ran += 1;
      return { ok: true, content: 'queued' };
    }
  };
  const deps = {
    store,
    stateDir: dir,
    tools: [schedule],
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
    {
      type: 'tool_call',
      toolCallId: 's1',
      name: 'schedule_social_post',
      input: { body: 'hi', channels: ['x'], publish_at: '2099-01-01T00:00:00Z' }
    },
    context,
    false,
    session.id
  );
  assert.equal(ran, 1);
  assert.equal(result.ok, true);
  assert.equal(MANDATORY_SKILL_NAMES.outboundSend, 'outbound-send');
  const sessionId = 'outbound-note';
  t.after(() => resetLoadedMandatorySkills(sessionId));
  assert.equal(
    gateMandatorySkills(noteLoadedSkill(sessionId, 'outbound-send', null, {}), 'schedule_social_post', {
      body: 'x',
      channels: ['x'],
      publish_at: '2099-01-01T00:00:00Z'
    }).ok,
    true
  );
});
