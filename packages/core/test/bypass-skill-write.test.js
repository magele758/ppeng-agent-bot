import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function adapter(calls) {
  return {
    name: 'bypass-skill-test',
    runTurn: async () => ({ assistantParts: [], stopReason: 'end' }),
    summarizeMessages: async () => '',
    completeText: async (input) => {
      calls.push(String(input.system));
      if (String(input.system).includes('Determine whether')) return JSON.stringify({ authorized: false });
      return JSON.stringify({ description: 'Grade a repository', body: '# Grade\n1. Read the diff.\n2. Check tests.' });
    }
  };
}

async function lab(t) {
  const { RawAgentRuntime } = await import('../dist/runtime.js');
  const { writeSkillProposalSettings, SkillProposalStore } = await import('../dist/skill-proposals/index.js');
  const { loadStateDirSkills } = await import('../dist/skills/builtin-skills.js');
  const dir = mkdtempSync(join(tmpdir(), 'bypass-skill-'));
  const calls = [];
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: join(dir, 'state'), modelAdapter: adapter(calls) });
  t.after(async () => { await runtime.destroy(); rmSync(dir, { recursive: true, force: true }); });
  writeSkillProposalSettings(runtime.store, { enabled: true });
  return { runtime, calls, dir, loadStateDirSkills, SkillProposalStore };
}

const create = {
  action: 'create',
  name: 'grade-check',
  description: 'Grade a repository',
  reason: 'The review steps worked',
  summary: 'Read the diff and check tests'
};

test('bypass bot saves its skill without a confirmation [AC:bypass-skill-write#AC-1]', async (t) => {
  const x = await lab(t);
  const bot = x.runtime.createBot({ name: 'Bypass Bot' });
  x.runtime.mergeSessionMetadata(bot.canonicalSessionId, { permissionMode: 'bypass' });
  const session = x.runtime.store.getSession(bot.canonicalSessionId);
  const manage = x.runtime.tools.find((item) => item.name === 'skill_manage');
  const saved = JSON.parse((await manage.execute({ session, agent: { id: bot.agentId } }, create)).content);
  assert.equal(saved.status, 'saved', JSON.stringify(saved));
  assert.equal(x.calls.some((system) => system.includes('Determine whether')), false);
  const skills = await x.loadStateDirSkills(join(x.dir, 'state'));
  const own = skills.find((skill) => skill.name === 'grade-check');
  assert.equal(own.ownerBotId, bot.id);
  assert.match(own.content, /Read the diff/);
  const stored = new x.SkillProposalStore(join(x.dir, 'state')).list({ status: 'approved' }).find((row) => row.name === 'grade-check');
  assert.match(stored.installedPath, /^skills\/\.bots\/bot-skill-[0-9a-f]+\/SKILL\.md$/);
  assert.equal(existsSync(join(x.dir, 'state', stored.installedPath)), true);
  const other = x.runtime.createBot({ name: 'Other Bot' });
  const otherSession = x.runtime.store.getSession(other.canonicalSessionId);
  const listed = JSON.parse((await manage.execute({ session: otherSession, agent: { id: other.agentId } }, { action: 'list' })).content);
  assert.equal(listed.skills.some((skill) => skill.name === 'grade-check'), false);
  const propose = x.runtime.tools.find((item) => item.name === 'skill_propose');
  const proposed = JSON.parse((await propose.execute({ session, agent: { id: bot.agentId } }, {
    name: 'release-grade', description: 'Grade a release', reason: 'Release checks worked', summary: 'Build, then check health'
  })).content);
  assert.equal(proposed.operation.status, 'saved', JSON.stringify(proposed));
  assert.equal(proposed.capture, undefined);
});

test('a bot that is not bypass still waits for confirmation [AC:bypass-skill-write#AC-2]', async (t) => {
  const x = await lab(t);
  const bot = x.runtime.createBot({ name: 'Ask Bot' });
  const session = x.runtime.store.getSession(bot.canonicalSessionId);
  x.runtime.store.appendMessage(session.id, 'user', [{ type: 'text', text: '看看这个仓库' }]);
  const manage = x.runtime.tools.find((item) => item.name === 'skill_manage');
  const op = JSON.parse((await manage.execute({ session, agent: { id: bot.agentId } }, { ...create, name: 'repo-notes' })).content);
  assert.equal(op.status, 'pending');
  assert.equal(x.calls.some((system) => system.includes('Determine whether')), true);
  const skills = await x.loadStateDirSkills(join(x.dir, 'state'));
  assert.equal(skills.some((skill) => skill.name === 'repo-notes'), false);
});
