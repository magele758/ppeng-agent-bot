import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = join(dirname(fileURLToPath(import.meta.url)), '..', 'acceptance', 'acceptance-gate.mjs');
const tag = (c) => '[AC:' + 'demo#' + c + ']';

const SPEC = `id: demo
title: Demo
status: implemented
requirement: 用户原话
criteria:
  - id: AC-1
    given: g
    when: w
    then: t
`;

function fixtureRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'acceptance-gate-'));
  const all = {
    'package.json': JSON.stringify({ scripts: { 'test:unit': 'node --test tests/*.test.mjs' } }),
    'acceptance/demo.yaml': SPEC,
    'tests/a.test.mjs': `test('works ${tag('AC-1')}', () => {});\n`,
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runGate(root, args = [], env = {}) {
  const { GITHUB_STEP_SUMMARY: _s, GITHUB_ACTIONS: _a, ...rest } = process.env;
  return spawnSync(process.execPath, [gate, '--root', root, ...args], { encoding: 'utf8', env: { ...rest, ...env }, timeout: 30_000 });
}

function junit(outcomeXml) {
  return `<testsuites><testsuite name="tests/a.test.mjs"><testcase name="works ${tag('AC-1')}">${outcomeXml}</testcase></testsuite></testsuites>`;
}

test('CLI static pass: exit 0, writes report.json + summary.md and appends to $GITHUB_STEP_SUMMARY [AC:acceptance-gate#AC-7]', () => {
  const root = fixtureRepo({});
  try {
    const summary = join(root, 'step-summary.md');
    writeFileSync(summary, '# earlier step\n');
    const r = runGate(root, [], { GITHUB_STEP_SUMMARY: summary });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Acceptance gate — ✅ pass \(static mode\)/);
    const report = JSON.parse(readFileSync(join(root, 'coverage/acceptance/report.json'), 'utf8'));
    assert.equal(report.ok, true);
    assert.equal(report.runnableTestFiles, 1);
    assert.equal(report.specs[0].criteria[0].state, 'covered');
    assert.ok(existsSync(join(root, 'coverage/acceptance/summary.md')));
    assert.match(readFileSync(summary, 'utf8'), /^# earlier step\n## Acceptance gate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI results mode: passing JUnit exits 0, failing exits 1 [AC:acceptance-gate#AC-2] [AC:acceptance-gate#AC-7]', () => {
  const root = fixtureRepo({ 'results/ok/unit.xml': junit(''), 'results/bad/unit.xml': junit('<failure message="x"/>') });
  try {
    const ok = runGate(root, ['--results', join(root, 'results/ok'), '--out', 'out-ok']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /results mode/);
    assert.equal(JSON.parse(readFileSync(join(root, 'out-ok/report.json'), 'utf8')).specs[0].criteria[0].state, 'passing');

    const bad = runGate(root, ['--results', join(root, 'results/bad/unit.xml'), '--out', 'out-bad']);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /AC-1 has failing tagged test/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI cannot evaluate: missing / empty / non-JUnit results and bad args exit 2 [AC:acceptance-gate#AC-7]', () => {
  const root = fixtureRepo({ 'results/empty/.keep': '', 'results/junk.xml': '{"not":"junit"}', 'results/zero.xml': '<testsuites/>' });
  try {
    for (const args of [
      ['--results', join(root, 'nope')],
      ['--results', join(root, 'results/empty')],
      ['--results', join(root, 'results/junk.xml')],
      ['--results', join(root, 'results/zero.xml')],
      ['--bogus'],
      ['--collect', 'jest'],
    ]) {
      const r = runGate(root, args);
      assert.equal(r.status, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /\[acceptance\] /);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI ignores acceptance tags copied into self-heal and evolution worktrees [AC:acceptance-gate#AC-8]', () => {
  const root = fixtureRepo({
    '.agent-state/workspaces/self-heal-x/apps/web-console/lib/ops-health.test.ts': `test('stale ${tag('AC-1')}', () => {});\n`,
    '.evolution-worktrees/old/e2e/ops.spec.ts': `test('stale e2e ${tag('AC-1')}', () => {});\n`,
  });
  try {
    const r = runGate(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /\.agent-state/);
    assert.doesNotMatch(r.stdout, /\.evolution-worktrees/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI fails when tags live in a file no test runner executes [AC:acceptance-gate#AC-6]', () => {
  const root = fixtureRepo({ 'other/test/forgotten.test.mjs': `test('x ${tag('AC-1')}', () => {});\n` });
  try {
    const r = runGate(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /other\/test\/forgotten\.test\.mjs: contains acceptance tags but is not executed by any configured test runner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI picks up runner file sets from vitest/playwright config and fails an untagged implemented criterion [AC:acceptance-gate#AC-1]', () => {
  const root = fixtureRepo({
    'tests/a.test.mjs': null,
    'packages/agent-loop/vitest.config.ts': `export default { test: { include: ['lib/**/*.test.ts'] } };`,
    'packages/agent-loop/lib/x/y.test.ts': `it('vitest ${tag('AC-1')}', () => {});`,
    'playwright.config.ts': `export default { testDir: './browser' };`,
    'browser/flow.spec.ts': `test('e2e ${tag('AC-1')}', () => {});`,
  });
  try {
    const r = runGate(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(join(root, 'coverage/acceptance/report.json'), 'utf8'));
    assert.deepEqual(report.specs[0].criteria[0].tests.map((t) => t.file).sort(), ['browser/flow.spec.ts', 'packages/agent-loop/lib/x/y.test.ts']);

    writeFileSync(join(root, 'browser/flow.spec.ts'), `test('e2e untagged', () => {});`);
    writeFileSync(join(root, 'packages/agent-loop/lib/x/y.test.ts'), `it('vitest untagged', () => {});`);
    const missing = runGate(root);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /acceptance\/demo\.yaml: AC-1 has no test tagged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
