import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SKILL_PROPOSAL_BODY_MAX,
  SKILL_PROPOSAL_MAX_PENDING,
  SkillProposalStore,
  SkillCaptureService,
  buildSkillProposeReminder,
  createSkillProposeTool,
  defaultSkillProposalSettings,
  findSecretLikeContent,
  readSkillProposalSettings,
  validateSkillProposalDraft,
  writeSkillProposalSettings
} from '../dist/skill-proposals/index.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { PromptBuilder } from '../dist/model/prompt-builder.js';
import { resolveSkillLoad } from '../dist/runtime/skill-load.js';
import { builtinSkills, loadStateDirSkills } from '../dist/skills/builtin-skills.js';
import { bestCpuMs } from './helpers/timing.js';

function kvStore() {
  const map = new Map();
  return {
    getDaemonControl: (key) => map.get(key),
    setDaemonControl: (key, value) => map.set(key, value),
    getSession: () => undefined
  };
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

const GOOD = {
  name: 'deploy-staging',
  description: 'Deploy the app to staging and smoke-check it',
  body: '# Deploy staging\n\n1. Run the deploy script.\n2. Hit /healthz.\n'
};

function ctx(sessionId = 'sess_1') {
  return { session: { id: sessionId, metadata: {} }, agent: { id: 'general' } };
}

function makeTool(settings, stateDir, skills = []) {
  return createSkillProposeTool({
    captures: new SkillCaptureService({
      stateDir, settingsStore: settings, listSkills: async () => skills,
      getEvidence: () => 'Successfully completed the workflow',
      complete: async () => JSON.stringify(GOOD), reloadSkills: async () => {}
    })
  });
}

function enabledSettings() {
  const s = kvStore();
  writeSkillProposalSettings(s, { enabled: true });
  return s;
}

test('settings default to off / no reminders and persist via KV [AC:skill-proposals#AC-1]', () => {
  const s = kvStore();
  const d = readSkillProposalSettings(s);
  assert.equal(d.enabled, false);
  assert.equal(d.remindEveryNToolCalls, 0);
  assert.equal(defaultSkillProposalSettings().enabled, false);
  writeSkillProposalSettings(s, { enabled: true, remindEveryNToolCalls: 7 });
  assert.deepEqual(
    [readSkillProposalSettings(s).enabled, readSkillProposalSettings(s).remindEveryNToolCalls],
    [true, 7]
  );
  writeSkillProposalSettings(s, { remindEveryNToolCalls: 5000 });
  assert.equal(readSkillProposalSettings(s).remindEveryNToolCalls, 7, 'out-of-range value is ignored');
});

test('validation: name pattern, path traversal, size limits, frontmatter [AC:skill-proposals#AC-6]', () => {
  for (const bad of ['../evil', 'a/b', 'Upper', 'has space', '-lead', 'trail-', 'double--hyphen', '', 'x'.repeat(65), '..', '.hidden']) {
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, name: bad }), /name must be/, `name ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => validateSkillProposalDraft(GOOD));
  assert.throws(
    () => validateSkillProposalDraft({ ...GOOD, body: 'x'.repeat(SKILL_PROPOSAL_BODY_MAX + 1) }),
    /body exceeds/
  );
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, description: 'd'.repeat(301) }), /description exceeds/);
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: '---\nname: x\n---\nhi' }), /frontmatter/);
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: '  ' }), /body is required/);
});

test('validation: secret-looking content is rejected [AC:skill-proposals#AC-6]', () => {
  const secrets = [
    'key is sk-abcdefghijklmnopqrstuvwxyz123456',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAABCDEFGHIJKLMNOP',
    '-----BEGIN RSA PRIVATE KEY-----\nabc',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'API_KEY=abcd1234efgh5678ijkl',
    'password: "hunter2hunter2hunter2"',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
  ];
  for (const text of secrets) {
    assert.ok(findSecretLikeContent(text), text);
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: `${GOOD.body}\n${text}` }), /secret/);
  }
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, description: 'use sk-abcdefghijklmnopqrstuvwx' }), /secret/);
  assert.equal(findSecretLikeContent('Set API_KEY to your key from the dashboard.'), undefined);
  assert.equal(findSecretLikeContent('export TOKEN=$MY_TOKEN'), undefined);
});

test('validation: extra credential shapes are rejected', () => {
  const secrets = [
    `STRIPE=${'sk_'}${'live_'}abcdefghijklmnopqrstuvwx`,
    `use ${'sk_'}${'test_'}4eC39HqLyjWDarjtT1zdp7dc here`,
    `NPM=${'npm'}_abcdefghijklmnopqrstuvwxyz0123456789`,
    `${'hf'}_abcdefghijklmnopqrstuvwxyzABCDEF`,
    'SECRET_KEY=abcd1234',
    'export DJANGO_SECRET_KEY="s3cr3t-value-123"',
    'CLIENT_SECRET=abcdefgh',
    'GITHUB_TOKEN=abcdefghij',
    'DB_PASSWORD=hunter2hunter2',
    'token: "abcdefghijklmnop"',
    "auth = { token: 'abcdefghijklmnopqrstuv' }",
    'postgres://admin:s3cr3tpass@db.example.com:5432/app',
    'redis://default:abc123@cache.internal'
  ];
  for (const text of secrets) {
    assert.ok(findSecretLikeContent(text), text);
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: `${GOOD.body}\n${text}` }), /secret/);
  }
});

test('validation: placeholders and prose about credentials are not flagged [AC:skill-proposals#AC-6]', () => {
  const fine = [
    'Put your TOKEN in the header.',
    'password: <your-password>',
    'API_TOKEN=<your-token>',
    'API_TOKEN=${API_TOKEN}',
    'SECRET_KEY=$SECRET_KEY',
    'SECRET_KEY=your-secret-key-here',
    'GITHUB_TOKEN=xxxxxxxxxxxx',
    'DB_PASSWORD=short',
    'token: "<token>"',
    'token: $TOKEN',
    'token: "your-token-goes-here"',
    'the token: required for auth',
    'postgres://user:<password>@host/db',
    'postgres://user:${DB_PASSWORD}@host/db',
    'https://example.com:8080/path',
    'sk_live_ prefix marks Stripe keys',
    'npm_config_cache is an env var',
    'hf_hub download helper'
  ];
  for (const text of fine) assert.equal(findSecretLikeContent(text), undefined, text);
});

test('connection strings: placeholder passwords pass', () => {
  const fine = [
    'postgres://user:password@localhost:5432/db',
    'mysql://root:pass@127.0.0.1:3306/app',
    'mongodb://app:secret@db:27017/test',
    'redis://default:changeme@host:6379/0',
    'amqp://guest:guest@localhost:5672/',
    'postgres://user:<password>@prod-db.internal/app',
    'postgres://user:${DB_PASSWORD}@prod-db.internal/app',
    'mysql://user:$DB_PASS@prod-db.internal/app',
    'mysql://user:$(cat /run/pw)@prod-db.internal/app',
    'amqp://user:{{ rabbit_pw }}@mq.internal/',
    'amqp://user:%s@mq.internal/',
    'redis://:{password}@cache.internal',
    'postgres://user:YourPassword@prod-db.internal/app',
    'postgres://user:your-db-password@prod-db.internal/app',
    'postgres://user:Your_Password@prod-db.internal/app',
    'postgres://username:PASSWORD@prod-db.internal/app',
    'postgres://user:xxxxxxxx@prod-db.internal/app',
    'postgres://user:********@prod-db.internal/app',
    'postgres://user:........@prod-db.internal/app',
    'postgres://user:\u2026\u2026\u2026@prod-db.internal/app',
    'postgres://user:aaaaaa@prod-db.internal/app',
    'postgres://user:Example@prod-db.internal/app',
    'mongodb+srv://app:devonly@db.example.com/test',
    'mysql://app:letmein@localhost/test'
  ];
  for (const text of fine) {
    assert.equal(findSecretLikeContent(text), undefined, text);
    assert.doesNotThrow(() => validateSkillProposalDraft({ ...GOOD, body: `${GOOD.body}\n${text}` }), text);
  }
});

test('connection strings: realistic passwords are still rejected', () => {
  const ghToken = `${'gh'}p_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`;
  const secrets = [
    'postgres://admin:Xk9#mP2vQz@prod-db.internal/app',
    'mongodb+srv://u:9f8a7b6c5d4e@cluster0.mongodb.net',
    'redis://:hunter2hunter2@cache',
    `https://user:${ghToken}@github.com/org/repo.git`,
    'mysql://root:CorrectHorse@prod-db.internal/app',
    'postgres://app:hunter2!@localhost/app',
    'postgres://admin:s3cr3tpass@db.example.com:5432/app',
    'postgres://app:letmein@prod-db.internal/app'
  ];
  for (const text of secrets) {
    assert.ok(findSecretLikeContent(text), text);
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: `${GOOD.body}\n${text}` }), /secret/, text);
  }
});

test('validation: length limits are inclusive and fields are normalized', () => {
  const name = 'a'.repeat(64);
  assert.equal(validateSkillProposalDraft({ ...GOOD, name }).name, name, '64-char name is the maximum, not over it');
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, name: 'a'.repeat(65) }), /name must be/);
  const description = 'd'.repeat(300);
  assert.equal(validateSkillProposalDraft({ ...GOOD, description }).description, description);
  const normalized = validateSkillProposalDraft({
    name: '  deploy-staging  ',
    description: '  Deploy\n\tthe   app  ',
    body: '\r\n# Title\r\nline\r\n\r\n'
  });
  assert.deepEqual(normalized, { name: 'deploy-staging', description: 'Deploy the app', body: '# Title\nline' });
  for (const description of ['', '   \n\t', undefined, 42]) {
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, description }), /description is required/, String(description));
  }
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: undefined }), /body is required/);
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, name: undefined }), /name must be/);
});

test('validation: Slack / Google keys and case-insensitive token assignments are secrets', () => {
  const secrets = [
    ['Slack token', `bot ${'xox'}b-1234567890-abcdefghij`],
    ['Google API key', `key=${'AI'}za${'S'.repeat(5)}abcdefghijklmnopqrstuvwxyz0`],
    ['token assignment', 'Token: "abcdefghijklmnopqr"']
  ];
  for (const [label, text] of secrets) {
    assert.equal(findSecretLikeContent(text), label, text);
    assert.throws(() => validateSkillProposalDraft({ ...GOOD, body: `${GOOD.body}\n${text}` }), /secret/);
  }
  assert.throws(() => validateSkillProposalDraft({ ...GOOD, name: 'x', description: `has ${'xox'}p-1234567890-abc` }), /description looks like it contains a secret \(Slack token\)/);
});

test('connection strings: every placeholder word and shape passes on a non-example host', () => {
  const host = 'prod-db.internal';
  const fine = [
    'pass', 'passwd', 'pwd', 'secret', 'changeme', 'Password', 'yourpassword',
    '{{rabbit_pw}}', '$(pw_cmd)', 'x*.x*.', '<pw>', '{pw}', '${PW}', '$PW_VAR', 'zzz'
  ];
  for (const pw of fine) {
    const text = `postgres://user:${pw}@${host}/app`;
    assert.equal(findSecretLikeContent(text), undefined, text);
  }
});

test('connection strings: short lowercase passwords pass only on documentation hosts', () => {
  for (const host of ['localhost', '127.0.0.1', 'example.com', 'db', 'host', 'db.example.com', 'a.example.b.org', 'LOCALHOST']) {
    assert.equal(findSecretLikeContent(`mysql://app:abcdefgh@${host}/x`), undefined, `8-char lowercase @${host}`);
  }
  const flagged = [
    'mysql://app:abcdefghi@localhost/x',
    'mysql://app:abcdefgh@prod-db.internal.corp/x',
    'mysql://app:abcdefgh@example.org/x',
    'mysql://app:abcd1234@localhost/x'
  ];
  for (const text of flagged) assert.equal(findSecretLikeContent(text), 'credentials in connection string', text);
});

test('secret detection stays linear on 20KB adversarial input', () => {
  const inputs = [
    'a'.repeat(20_000),
    'a_'.repeat(10_000),
    '_TOKEN '.repeat(2_900),
    'token'.repeat(4_000),
    'token: "' + 'a'.repeat(20_000),
    'ab://' + 'a'.repeat(20_000),
    'ab://a:' + 'b'.repeat(20_000),
    'x://' + 'a:'.repeat(10_000),
    'ab://' + 'a:'.repeat(10_000),
    'ab://a:'.repeat(2_800),
    'ab://a:bbb@'.repeat(1_800),
    'ab://' + '@'.repeat(20_000),
    'ab://a:' + '@'.repeat(20_000),
    'ab://:' + ':@'.repeat(10_000),
    '://'.repeat(6_000),
    '_TOKEN=' + 'a'.repeat(20_000).replace(/a/g, '!').slice(0, 7),
    'SECRET_KEY' + ' '.repeat(20_000)
  ];
  for (const text of inputs) {
    // CPU time, best of 3: immune to the box being busy. ReDoS would take seconds;
    // V8 coverage instrumentation alone can add a few ms.
    const { ms } = bestCpuMs(() => findSecretLikeContent(text));
    const budget = process.env.NODE_V8_COVERAGE ? 25 : 5;
    assert.ok(ms < budget, `${text.slice(0, 20)} took ${ms.toFixed(2)}ms`);
  }
});

test('skill_propose is hidden unless the switch is on (and refuses when called while off) [AC:skill-proposals#AC-1]', async () => {
  const stateDir = tmp('sp-tool-vis');
  const off = kvStore();
  const tool = makeTool(off, stateDir);
  const other = { name: 'load_skill', description: '', inputSchema: {}, approvalMode: 'never', sideEffectLevel: 'none', execute: async () => ({ ok: true, content: '' }) };
  const agent = { id: 'general' };
  const session = { id: 's1', metadata: {} };
  const names = (settings) =>
    filterToolsForSession({ env: {}, tools: [other, tool], agent, session, settingsStore: settings }).tools.map((t) => t.name);
  assert.deepEqual(names(off), ['load_skill']);
  const on = enabledSettings();
  on.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
  assert.deepEqual(names(on), ['load_skill', 'skill_propose']);
  writeSkillProposalSettings(on, { enabled: false });
  assert.deepEqual(names(on), ['load_skill'], 'switch off takes effect immediately');

  const res = await tool.execute(ctx(), GOOD);
  assert.equal(res.ok, false);
  assert.match(res.content, /disabled/);
  assert.equal(existsSync(join(stateDir, 'skill-proposals')), false, 'nothing written while disabled');
});

test('legacy proposals remain pending until approved [AC:skill-proposals#AC-2]', async () => {
  const stateDir = tmp('sp-tool-queue');
  const store = new SkillProposalStore(stateDir);
  const rec = store.create({ ...GOOD, sessionId: 'sess_abc', agentId: 'general' });
  assert.equal(rec.sessionId, 'sess_abc');
  assert.equal(rec.status, 'pending');
  assert.equal(existsSync(join(stateDir, 'skills')), false);
  assert.equal((await loadStateDirSkills(stateDir)).length, 0);
  store.approve(rec.id);
  assert.equal((await loadStateDirSkills(stateDir)).length, 1);
});

test('skill_propose submits an intent, refuses bodies and protected targets', async () => {
  const stateDir = tmp('sp-intent-tool');
  const tool = makeTool(enabledSettings(), stateDir, [
    { id: 'deploy-staging', name: 'deploy-staging', description: 'x', content: 'old', source: 'workspace' },
    { id: 'harness', name: 'harness', description: 'x', content: 'b', source: 'builtin' }
  ]);
  const intent = { name: GOOD.name, description: GOOD.description, reason: 'Workflow succeeded', summary: 'Deploy and verify health' };
  const result = await tool.execute(ctx('s1'), intent);
  assert.equal(result.ok, true, result.content);
  const capture = JSON.parse(result.content).capture;
  assert.equal(capture.kind, 'update');
  assert.equal(capture.status, 'pending');
  assert.equal((await tool.execute(ctx('s1'), GOOD)).ok, false);
  assert.equal((await tool.execute(ctx('s1'), { ...intent, name: 'harness' })).ok, false);
  const again = JSON.parse((await tool.execute(ctx('s1'), intent)).content).capture;
  assert.equal(again.id, capture.id);
  assert.equal(new SkillProposalStore(stateDir).list().length, 0);
});

test('queue is capped', async () => {
  const stateDir = tmp('sp-cap');
  const store = new SkillProposalStore(stateDir);
  for (let i = 0; i < SKILL_PROPOSAL_MAX_PENDING; i += 1) {
    store.create({ ...GOOD, name: `skill-${i}`, sessionId: 's' });
  }
  assert.throws(() => store.create({ ...GOOD, name: 'one-more', sessionId: 's' }), /queue is full/);
});

test('approve installs under stateDir/skills, load_skill works; reject keeps record and stays unloadable [AC:skill-proposals#AC-3] [AC:skill-proposals#AC-4]', async () => {
  const prevOff = process.env.RAW_AGENT_AGENTS_SKILLS;
  process.env.RAW_AGENT_AGENTS_SKILLS = '0';
  try {
    const stateDir = tmp('sp-approve');
    const repoRoot = tmp('sp-repo');
    const repoSkillsBefore = existsSync(join(repoRoot, 'skills'));
    const settings = kvStore();
    const promptBuilder = new PromptBuilder({ store: settings, repoRoot, stateDir });
    const loader = { promptBuilder, emitTrace: () => {} };
    const store = new SkillProposalStore(stateDir);

    const a = store.create({ ...GOOD, sessionId: 's1' });
    const b = store.create({ ...GOOD, name: 'rejected-skill', sessionId: 's1' });

    const before = await resolveSkillLoad(loader, 'deploy-staging', 's1');
    assert.ok(before.error, 'not loadable before approval');

    store.reject(b.id, 'not reusable');
    promptBuilder.invalidateSkillsCache();
    assert.ok((await resolveSkillLoad(loader, 'rejected-skill', 's1')).error);
    const rejected = store.get(b.id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectReason, 'not reusable');
    assert.equal(existsSync(join(stateDir, 'skills', 'rejected-skill')), false);

    const approved = store.approve(a.id);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.installedPath, join('skills', 'deploy-staging', 'SKILL.md'));
    const file = join(stateDir, 'skills', 'deploy-staging', 'SKILL.md');
    assert.ok(readFileSync(file, 'utf8').startsWith('---\nname: deploy-staging\n'));
    promptBuilder.invalidateSkillsCache();
    const loaded = await resolveSkillLoad(loader, 'deploy-staging', 's1');
    assert.equal(loaded.error, undefined);
    assert.match(loaded.content, /Run the deploy script/);
    const all = await promptBuilder.allSkills();
    assert.equal(all.find((s) => s.name === 'deploy-staging')?.source, 'user');

    assert.equal(existsSync(join(repoRoot, 'skills')), repoSkillsBefore, 'repo skills/ untouched');
    assert.throws(() => store.approve(a.id), /already approved/);
    assert.throws(() => store.reject(a.id), /already approved/);
    assert.equal(store.list().length, 2);
  } finally {
    if (prevOff === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
    else process.env.RAW_AGENT_AGENTS_SKILLS = prevOff;
  }
});

test('approve re-validates stored records: tampered traversal name / secret body are refused [AC:skill-proposals#AC-6]', () => {
  const stateDir = tmp('sp-tamper');
  const store = new SkillProposalStore(stateDir);
  const rec = store.create({ ...GOOD, sessionId: 's1' });
  const file = join(stateDir, 'skill-proposals', `${rec.id}.json`);
  const original = JSON.parse(readFileSync(file, 'utf8'));

  writeFileSync(file, JSON.stringify({ ...original, name: '../../escaped' }));
  assert.throws(() => store.approve(rec.id), /invalid name/);
  writeFileSync(file, JSON.stringify({ ...original, name: 'a/../../b' }));
  assert.throws(() => store.approve(rec.id), /invalid name/);
  writeFileSync(file, JSON.stringify({ ...original, body: 'leak sk-abcdefghijklmnopqrstuvwxyz123456' }));
  assert.throws(() => store.approve(rec.id), /secret/);
  assert.equal(existsSync(join(stateDir, 'skills')), false);
  assert.equal(existsSync(join(stateDir, '..', 'escaped')), false);

  assert.equal(store.get('../../etc/passwd'), undefined);
  assert.equal(store.get('sp_nothex'), undefined);
  assert.throws(() => store.approve('../evil'), /not found/);
});

test('merge priority: workspace < user(stateDir) < ~/.agents; update proposal overrides repo skill', async () => {
  const stateDir = tmp('sp-prio');
  const repoRoot = tmp('sp-prio-repo');
  const agentsDir = tmp('sp-prio-agents');
  const mk = (root, dir, name, body) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
  };
  mk(repoRoot, 'skills/deploy-staging', 'deploy-staging', 'REPO body');
  mk(repoRoot, 'skills/only-repo', 'only-repo', 'REPO only');
  mk(agentsDir, 'shared', 'shared-skill', 'AGENTS body');
  mk(repoRoot, 'skills/shared-skill', 'shared-skill', 'REPO shared');

  const prevDir = process.env.RAW_AGENT_AGENTS_SKILLS_DIR;
  const prevOff = process.env.RAW_AGENT_AGENTS_SKILLS;
  process.env.RAW_AGENT_AGENTS_SKILLS_DIR = agentsDir;
  delete process.env.RAW_AGENT_AGENTS_SKILLS;
  try {
    const store = new SkillProposalStore(stateDir);
    store.approve(store.create({ ...GOOD, sessionId: 's', replaces: { name: 'deploy-staging', source: 'workspace' } }).id);
    store.approve(store.create({ ...GOOD, name: 'shared-skill', body: 'USER shared body', sessionId: 's' }).id);
    const pb = new PromptBuilder({ store: kvStore(), repoRoot, stateDir });
    const all = await pb.allSkills();
    const byName = (n) => all.find((s) => s.name === n);
    assert.match(byName('deploy-staging').content, /Run the deploy script/, 'user layer overrides workspace');
    assert.equal(byName('deploy-staging').source, 'user');
    assert.match(byName('only-repo').content, /REPO only/);
    assert.match(byName('shared-skill').content, /AGENTS body/, '~/.agents still wins over user layer');
    assert.ok(builtinSkills.length > 0);
  } finally {
    if (prevDir === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS_DIR;
    else process.env.RAW_AGENT_AGENTS_SKILLS_DIR = prevDir;
    if (prevOff !== undefined) process.env.RAW_AGENT_AGENTS_SKILLS = prevOff;
  }
});

test('approved description with quotes / brackets / colons round-trips through the skill loader', async () => {
  const stateDir = tmp('sp-desc');
  const store = new SkillProposalStore(stateDir);
  const rec = store.create({
    name: 'odd-desc',
    description: '[note] use "quotes": and colons',
    body: 'Body text here.',
    sessionId: 's'
  });
  store.approve(rec.id);
  const [skill] = await loadStateDirSkills(stateDir);
  assert.equal(skill.name, 'odd-desc');
  assert.equal(skill.description, "[note] use 'quotes': and colons");
  assert.equal(skill.content, 'Body text here.');
  assert.equal(readdirSync(join(stateDir, 'skills')).length, 1);
});

test('revoke: deletes the installed skill, keeps the record, load_skill no longer finds it [AC:skill-proposals#AC-5]', async () => {
  const prevOff = process.env.RAW_AGENT_AGENTS_SKILLS;
  process.env.RAW_AGENT_AGENTS_SKILLS = '0';
  try {
    const stateDir = tmp('sp-revoke');
    const repoRoot = tmp('sp-revoke-repo');
    const promptBuilder = new PromptBuilder({ store: kvStore(), repoRoot, stateDir });
    const loader = { promptBuilder, emitTrace: () => {} };
    const store = new SkillProposalStore(stateDir);
    const a = store.create({ ...GOOD, sessionId: 's1' });
    const keep = store.create({ ...GOOD, name: 'keep-me', sessionId: 's1' });
    store.approve(a.id);
    store.approve(keep.id);
    promptBuilder.invalidateSkillsCache();
    assert.equal((await resolveSkillLoad(loader, 'deploy-staging', 's1')).error, undefined);

    const { proposal, outcome } = store.revoke(a.id);
    assert.equal(outcome, 'removed');
    assert.equal(proposal.status, 'revoked');
    assert.ok(proposal.revokedAt);
    assert.ok(proposal.decidedAt, 'approval time is kept');
    assert.equal(existsSync(join(stateDir, 'skills', 'deploy-staging')), false);
    assert.equal(existsSync(join(stateDir, 'skills', 'keep-me', 'SKILL.md')), true, 'other skills untouched');
    assert.equal(store.get(a.id).status, 'revoked', 'record is kept');
    assert.equal(store.list({ status: 'revoked' }).length, 1);

    promptBuilder.invalidateSkillsCache();
    assert.ok((await resolveSkillLoad(loader, 'deploy-staging', 's1')).error, 'not loadable after revoke');
    assert.equal(existsSync(join(repoRoot, 'skills')), false, 'repo skills/ untouched');

    assert.throws(() => store.revoke(a.id), /only approved/);
    assert.throws(() => store.approve(a.id), /already revoked/);
    assert.throws(() => store.reject(a.id), /already revoked/);
  } finally {
    if (prevOff === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
    else process.env.RAW_AGENT_AGENTS_SKILLS = prevOff;
  }
});

test('revoke: only approved is revocable; bad ids are not_found; missing dir is success', () => {
  const stateDir = tmp('sp-revoke-guard');
  const store = new SkillProposalStore(stateDir);
  const pending = store.create({ ...GOOD, sessionId: 's1' });
  const rejected = store.create({ ...GOOD, name: 'rejected-one', sessionId: 's1' });
  store.reject(rejected.id);
  for (const id of [pending.id, rejected.id]) {
    assert.throws(() => store.revoke(id), (e) => e.code === 'conflict');
  }
  for (const id of ['../../etc/passwd', '..', 'sp_nothex', 'sp_00000000000000000000000000000000']) {
    assert.throws(() => store.revoke(id), (e) => e.code === 'not_found', id);
  }

  store.approve(pending.id);
  rmSync(join(stateDir, 'skills', 'deploy-staging'), { recursive: true });
  const res = store.revoke(pending.id);
  assert.equal(res.outcome, 'missing');
  assert.equal(res.proposal.status, 'revoked');
});

test('revoke: tampered record name cannot delete outside stateDir/skills', () => {
  const stateDir = tmp('sp-revoke-tamper');
  const victim = join(stateDir, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'SKILL.md'), 'precious');
  const store = new SkillProposalStore(stateDir);
  const rec = store.create({ ...GOOD, sessionId: 's1' });
  store.approve(rec.id);
  const file = join(stateDir, 'skill-proposals', `${rec.id}.json`);
  const original = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of ['../victim', '..', 'a/../../victim', '/etc']) {
    writeFileSync(file, JSON.stringify({ ...original, name }));
    assert.throws(() => store.revoke(rec.id), /invalid name/, name);
  }
  assert.equal(readFileSync(join(victim, 'SKILL.md'), 'utf8'), 'precious');
  assert.equal(existsSync(join(stateDir, 'skills', 'deploy-staging', 'SKILL.md')), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'approved', 'failed revoke keeps status');
});

test('revoke: a directory not written by this approval is left in place (foreign)', () => {
  const stateDir = tmp('sp-revoke-foreign');
  const store = new SkillProposalStore(stateDir);
  const first = store.create({ ...GOOD, sessionId: 's1' });
  store.approve(first.id);
  const second = store.create({ ...GOOD, body: 'Second version body.', sessionId: 's2' });
  store.approve(second.id);
  const res = store.revoke(first.id);
  assert.equal(res.outcome, 'foreign');
  assert.equal(res.proposal.status, 'revoked');
  assert.match(readFileSync(join(stateDir, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8'), /Second version body/);
  assert.equal(store.revoke(second.id).outcome, 'removed');
  assert.equal(existsSync(join(stateDir, 'skills', 'deploy-staging')), false);
});

test('revoke: an update proposal only removes the user copy, so the repo version is restored [AC:skill-proposals#AC-5]', async () => {
  const prevOff = process.env.RAW_AGENT_AGENTS_SKILLS;
  process.env.RAW_AGENT_AGENTS_SKILLS = '0';
  try {
    const stateDir = tmp('sp-revoke-upd');
    const repoRoot = tmp('sp-revoke-upd-repo');
    mkdirSync(join(repoRoot, 'skills', 'deploy-staging'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'skills', 'deploy-staging', 'SKILL.md'),
      '---\nname: deploy-staging\ndescription: repo version\n---\nREPO body\n'
    );
    const promptBuilder = new PromptBuilder({ store: kvStore(), repoRoot, stateDir });
    const loader = { promptBuilder, emitTrace: () => {} };
    const store = new SkillProposalStore(stateDir);
    const rec = store.create({ ...GOOD, sessionId: 's', replaces: { name: 'deploy-staging', source: 'workspace' } });
    assert.equal(rec.kind, 'update');
    store.approve(rec.id);
    promptBuilder.invalidateSkillsCache();
    assert.match((await resolveSkillLoad(loader, 'deploy-staging', 's')).content, /Run the deploy script/);

    assert.equal(store.revoke(rec.id).outcome, 'removed');
    promptBuilder.invalidateSkillsCache();
    const restored = await resolveSkillLoad(loader, 'deploy-staging', 's');
    assert.equal(restored.error, undefined);
    assert.match(restored.content, /REPO body/);
    assert.doesNotMatch(restored.content, /Run the deploy script/);
    const skill = (await promptBuilder.allSkills()).find((x) => x.name === 'deploy-staging');
    assert.equal(skill.source, 'workspace');
    assert.match(readFileSync(join(repoRoot, 'skills', 'deploy-staging', 'SKILL.md'), 'utf8'), /REPO body/);
  } finally {
    if (prevOff === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
    else process.env.RAW_AGENT_AGENTS_SKILLS = prevOff;
  }
});

test('reminder: every N iterations on the user side, off by default', () => {
  const s = kvStore();
  const base = { settingsStore: s, agent: { id: 'general' }, session: { metadata: {} } };
  assert.equal(buildSkillProposeReminder({ ...base, turn: 4 }), '');
  writeSkillProposalSettings(s, { enabled: true });
  assert.equal(buildSkillProposeReminder({ ...base, turn: 4 }), '', 'N=0 never reminds');
  writeSkillProposalSettings(s, { remindEveryNToolCalls: 4 });
  assert.equal(buildSkillProposeReminder({ ...base, turn: 0 }), '');
  assert.equal(buildSkillProposeReminder({ ...base, turn: 3 }), '');
  assert.match(buildSkillProposeReminder({ ...base, turn: 4 }), /skill_propose/);
  assert.match(buildSkillProposeReminder({ ...base, turn: 8 }), /8 tool iterations/);
  assert.equal(
    buildSkillProposeReminder({ ...base, turn: 4, agent: { id: 'x', allowedTools: ['bash'] } }),
    '',
    'no reminder when the agent cannot call the tool'
  );
  writeSkillProposalSettings(s, { enabled: false });
  assert.equal(buildSkillProposeReminder({ ...base, turn: 4 }), '');
});
