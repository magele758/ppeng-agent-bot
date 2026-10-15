import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseRevision, git, compareBaselines } from '../ci/base-revision.mjs';
import { parse } from 'yaml';

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'base-revision-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  const commit = (threshold) => {
    writeFileSync(join(root, 'baseline.json'), JSON.stringify({ threshold }));
    git(root, ['add', '.']);
    git(root, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const before = commit(30);
  const parent = commit(40);
  const head = commit(40);
  git(root, ['update-ref', 'refs/remotes/origin/main', head]);
  return { root, before, parent, head };
}

test('multi-commit pushes compare against the pre-push baseline [AC:ci-audit-p1-p2#AC-3]', (t) => {
  const { root, before } = repository(t);
  const base = baseRevision(root, { GITHUB_EVENT_NAME: 'push', CI_PUSH_BEFORE: before });
  assert.equal(base, before);
  const baseline = JSON.parse(git(root, ['show', `${base}:baseline.json`]));
  assert.deepEqual(compareBaselines(baseline, { threshold: 40 }), ['CRAP baseline threshold relaxed']);
});

test('pull requests use their event base even when origin/main has advanced', (t) => {
  const { root, before, head } = repository(t);
  assert.equal(baseRevision(root, {
    GITHUB_EVENT_NAME: 'pull_request', CI_PR_BASE_SHA: before, CI_PUSH_BEFORE: head,
  }), before);
});

test('missing or zero event bases fall back to merge-base, then HEAD parent', (t) => {
  const { root, before, parent } = repository(t);
  for (const value of ['', '0'.repeat(40), 'f'.repeat(40)]) {
    assert.equal(baseRevision(root, { GITHUB_EVENT_NAME: 'push', CI_PUSH_BEFORE: value }), parent);
    assert.equal(baseRevision(root, { GITHUB_EVENT_NAME: 'pull_request', CI_PR_BASE_SHA: value }), parent);
  }
  git(root, ['update-ref', 'refs/remotes/origin/main', before]);
  assert.equal(baseRevision(root, {}), before);
  assert.equal(baseRevision(root, { GITHUB_EVENT_NAME: 'push', CI_PUSH_BEFORE: '0'.repeat(40) }), before);
  assert.equal(baseRevision(root, { GITHUB_EVENT_NAME: 'workflow_dispatch', CI_PUSH_BEFORE: parent, CI_PR_BASE_SHA: parent }), before);
  git(root, ['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.equal(baseRevision(root, {}), parent);
});

test('non-repository fixtures have no comparison base', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'base-no-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(baseRevision(root, {}), null);
});

test('release workflow passes inherited event context to the shared resolver and gate jobs', () => {
  const workflow = parse(readFileSync('.github/workflows/release-gate.yml', 'utf8'));
  assert.equal(workflow.env.CI_PUSH_BEFORE, '${{ github.event.before }}');
  assert.equal(workflow.env.CI_PR_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
  const step = workflow.jobs['secrets-gate'].steps.find(s => s.id === 'base');
  assert.match(step.run, /baseRevision/);
  assert.match(step.run, /GITHUB_OUTPUT/);
});
