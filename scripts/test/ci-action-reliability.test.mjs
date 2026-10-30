import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
test('mutation modules run independently and retain complete failure-gated baseline coverage [AC:ci-action-reliability#AC-6]', () => {
 const w = parse(readFileSync('.github/workflows/mutation.yml', 'utf8'));
 const config = JSON.parse(readFileSync('scripts/mutation/mutation.config.json', 'utf8'));
 const entries = w.jobs.mutate.strategy.matrix.include;
 const modules = entries.map(entry => entry.args.match(/--module (\S+)/)[1]);
 assert.ok(modules.every(module => !module.includes(',')), 'each module must be independently retryable');
 assert.deepEqual([...new Set(modules)].sort(), Object.keys(config.modules).sort());
 assert.equal(w.jobs.mutate.strategy['fail-fast'], false);
 assert.ok(w.jobs.gate.steps.some(step => step.run === 'test "$SHARDS" = success'));
 assert.ok(w.jobs.gate.steps.some(step => step.run?.includes('--merge coverage/mutation-shards') && !step.run.includes('--no-gate')));
});
test('quick gate executes Bot contracts and HTTP integration within its budget [AC:ci-action-reliability#AC-1]', () => {
 const source = readFileSync('scripts/ci/quick-gate.mjs', 'utf8');
 for (const file of ['bots.test.js', 'bot-goal-result-return.test.js', 'scripts/integration-test.mjs', 'ci-action-reliability.test.mjs', 'feed-window.test.ts']) assert.ok(source.includes(file), file);
 assert.match(source, /budgetMs=90000/);
});
test('full PR validation stays label opt-in; core paths auto-run Formal only [AC:ci-action-reliability#AC-3] [AC:ci-action-reliability#AC-9]', () => {
 const w = parse(readFileSync('.github/workflows/pr-release-gate.yml', 'utf8'));
 assert.ok(w.on.pull_request.types.includes('labeled'));
 assert.match(w.jobs.full.if, /contains\(github.event.pull_request.labels\.\*\.name, 'full-validation'\)/);
 assert.doesNotMatch(w.jobs.full.if, /needs\.detect\.outputs\.core/);
 assert.equal(w.jobs.full.needs, 'detect');
 assert.equal(w.jobs.full.uses, './.github/workflows/release-gate.yml');
 assert.doesNotMatch(w.jobs.full.if, /head_ref/);
 assert.equal(w.jobs.formal.needs, 'detect');
 assert.equal(w.jobs.formal.uses, './.github/workflows/formal-only.yml');
 assert.match(w.jobs.formal.if, /needs\.detect\.outputs\.core == 'true'/);
 assert.match(w.jobs.formal.if, /!contains\(github.event.pull_request.labels\.\*\.name, 'full-validation'\)/);
 assert.deepEqual(w.permissions, { contents: 'read' });
 assert.equal(w.jobs.detect.permissions, undefined);
 assert.match(w.jobs.detect.steps.map(s => s.run ?? '').join('\n'), /pr-release-paths\.mjs/);
});
test('release-gate reuses formal-only workflow [AC:ci-action-reliability#AC-9]', () => {
 const rg = parse(readFileSync('.github/workflows/release-gate.yml', 'utf8'));
 assert.equal(rg.jobs.formal.uses, './.github/workflows/formal-only.yml');
 const fo = parse(readFileSync('.github/workflows/formal-only.yml', 'utf8'));
 assert.ok(Object.hasOwn(fo.on, 'workflow_call'));
 assert.match(fo.jobs.formal.steps.map(s => s.run ?? '').join('\n'), /validation-lane\.mjs formal/);
});
test('HTTP regression still fails the cloud gate and browser E2E is not run there [AC:ci-action-reliability#AC-4] [AC:ci-action-reliability#AC-5]', () => {
 const w = parse(readFileSync('.github/workflows/release-gate.yml', 'utf8'));
 const steps = w.jobs.browser.steps;
 const runs = steps.map(s => s.run ?? '').join('\n');
 assert.match(runs, /test:regression/);
 assert.match(runs, /test:integration/);
 assert.doesNotMatch(runs, /test:e2e/);
 assert.equal(w.jobs.browser.strategy, undefined);
 for (const step of steps) assert.notEqual(step['continue-on-error'], true);
 assert.match(w.jobs.acceptance.steps.map(s => s.run ?? '').join('\n'), /--omit-runners e2e/);
});
