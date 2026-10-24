import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
test('quick gate executes Bot contracts and HTTP integration within its budget [AC:ci-action-reliability#AC-1]', () => {
 const source = readFileSync('scripts/ci/quick-gate.mjs', 'utf8');
 for (const file of ['bots.test.js', 'bot-goal-result-return.test.js', 'scripts/integration-test.mjs', 'ci-action-reliability.test.mjs']) assert.ok(source.includes(file), file);
 assert.match(source, /budgetMs=90000/);
});
test('full PR validation is opt-in on every branch and responds to labeling [AC:ci-action-reliability#AC-3]', () => {
 const w = parse(readFileSync('.github/workflows/pr-release-gate.yml', 'utf8'));
 assert.ok(w.on.pull_request.types.includes('labeled'));
 assert.match(w.jobs.full.if, /contains\(github.event.pull_request.labels\.\*\.name, 'full-validation'\)/);
 assert.doesNotMatch(w.jobs.full.if, /head_ref/);
});
test('browser evidence survives an earlier HTTP failure without ignoring failures [AC:ci-action-reliability#AC-4]', () => {
 const w = parse(readFileSync('.github/workflows/release-gate.yml', 'utf8'));
 for (const name of ['Install Playwright Chromium', 'E2E (Agent Lab)']) {
  const step = w.jobs.browser.steps.find(s => s.name === name);
  assert.equal(step.if, '${{ !cancelled() }}');
  assert.notEqual(step['continue-on-error'], true);
 }
});
