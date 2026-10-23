import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  agentToolScope,
  botNameIssue,
  filterAgents,
  filterBots,
  filterSkills,
  type SkillItem
} from './agents-view.ts';
import { readBotSettings } from './bot-policy.ts';
import type { BotInfo } from './types.ts';

const agents = [
  { id: 'general', name: '通用助手', role: 'General assistant' },
  { id: 'evaluator', name: 'Evaluator', role: 'Skeptical QA / reviewer' },
  { id: 'sre-oncall', name: 'SRE On-call', role: 'Incident responder', domainId: 'sre' }
];

const bot = (over: Partial<BotInfo>): BotInfo => ({
  id: 'b',
  name: 'b',
  title: 'b',
  description: '',
  agentId: 'b',
  canonicalSessionId: 's',
  hidden: false,
  createdAt: '',
  updatedAt: '',
  ...over
});

const skills: SkillItem[] = [
  { id: 'planning', name: 'Planning', description: 'Use TodoWrite for multi-step work', source: 'builtin', triggerWords: ['roadmap'] },
  { id: 'mine', name: 'My Release Notes', description: 'Write release notes', source: 'user' }
];

describe('agents view filters', () => {
  test('filterAgents matches name, role, id and domain, all words must match [AC:agents-management#AC-1]', () => {
    assert.equal(filterAgents(agents, '').length, 3);
    assert.deepEqual(filterAgents(agents, 'qa').map((a) => a.id), ['evaluator']);
    assert.deepEqual(filterAgents(agents, '通用').map((a) => a.id), ['general']);
    assert.deepEqual(filterAgents(agents, 'sre incident').map((a) => a.id), ['sre-oncall']);
    assert.deepEqual(filterAgents(agents, 'zzz'), []);
  });

  test('filterBots matches name, title, description and agent [AC:agents-management#AC-5]', () => {
    const bots = [
      bot({ id: 'a', name: 'Alpha', title: 'Daily digest', description: 'summarises news' }),
      bot({ id: 'b', name: 'Beta', title: 'Beta', agentId: 'coder' })
    ];
    assert.deepEqual(filterBots(bots, 'digest').map((b) => b.id), ['a']);
    assert.deepEqual(filterBots(bots, 'NEWS').map((b) => b.id), ['a']);
    assert.deepEqual(filterBots(bots, 'coder').map((b) => b.id), ['b']);
    assert.deepEqual(filterBots(bots, 'nope'), []);
  });

  test('filterSkills combines keyword and source filters [AC:agents-management#AC-10]', () => {
    assert.equal(filterSkills(skills, '').length, 2);
    assert.deepEqual(filterSkills(skills, 'roadmap').map((s) => s.id), ['planning']);
    assert.deepEqual(filterSkills(skills, '', 'user').map((s) => s.id), ['mine']);
    assert.deepEqual(filterSkills(skills, 'release', 'builtin'), []);
  });
});

describe('agent tool scope', () => {
  test('no allowedTools means every tool is available [AC:agents-management#AC-2]', () => {
    assert.deepEqual(agentToolScope({}), { kind: 'all' });
    assert.deepEqual(agentToolScope({ allowedTools: [] }), { kind: 'all' });
  });

  test('a declared allowlist is listed sorted [AC:agents-management#AC-2]', () => {
    assert.deepEqual(agentToolScope({ allowedTools: ['web_fetch', 'bash'] }), {
      kind: 'limited',
      tools: ['bash', 'web_fetch']
    });
  });
});

describe('bot name validation', () => {
  test('empty or whitespace-only names are rejected [AC:agents-management#AC-4]', () => {
    assert.equal(botNameIssue(''), 'empty');
    assert.equal(botNameIssue('   '), 'empty');
    assert.equal(botNameIssue('Daily digest'), null);
  });

  test('a trimmed name that matches an existing bot is taken', () => {
    const taken = ['Daily digest', 'Ada'];
    assert.equal(botNameIssue('  daily digest  ', taken), 'taken');
    assert.equal(botNameIssue('ada', taken), 'taken');
    assert.equal(botNameIssue('Ada Lovelace', taken), null);
    assert.equal(botNameIssue('Daily digest'), null);
  });
});

describe('bot settings snapshot', () => {
  test('defaults match the daemon when nothing is stored [AC:agents-management#AC-6]', () => {
    assert.deepEqual(readBotSettings(undefined), {
      maxTurns: 0,
      allowedTools: [],
      allowedSkills: [],
      permissionMode: 'auto',
      modelOverride: null
    });
  });

  test('stored policy is read back from session metadata [AC:agents-management#AC-6]', () => {
    const got = readBotSettings({
      maxTurns: 48,
      allowedTools: ['bash', '', 3],
      allowedSkills: ['planning'],
      permissionMode: 'ask',
      modelOverride: { providerId: 'p', modelId: 'm' }
    });
    assert.equal(got.maxTurns, 48);
    assert.deepEqual(got.allowedTools, ['bash']);
    assert.deepEqual(got.allowedSkills, ['planning']);
    assert.equal(got.permissionMode, 'ask');
    assert.deepEqual(got.modelOverride, { providerId: 'p', modelId: 'm' });
  });

  test('unknown permission or turn values fall back to defaults [AC:agents-management#AC-6]', () => {
    const got = readBotSettings({ maxTurns: 7, permissionMode: 'root' });
    assert.equal(got.maxTurns, 0);
    assert.equal(got.permissionMode, 'auto');
  });
});
