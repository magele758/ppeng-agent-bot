import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  buildRetryArgs,
  buildShellCommand,
  classifyRetry,
  escapeData,
  escapeProperty,
  groupFailuresByFile,
  parseFailureLines,
  renderAnnotations,
  renderSummary,
  retryPlan,
  shellQuote,
  splitNodeTestCommand
} from '../ci/flaky-retry-lib.mjs';
import { dedupeResults, parseJUnit } from '../acceptance/acceptance-lib.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repoRoot, 'scripts', 'ci', 'retry-failed-tests.mjs');

test('splitNodeTestCommand separates node flags from file patterns', () => {
  assert.deepEqual(splitNodeTestCommand('node --experimental-strip-types --test a/*.test.js b.test.ts'), {
    flags: ['--experimental-strip-types', '--test'],
    patterns: ['a/*.test.js', 'b.test.ts']
  });
});

test('splitNodeTestCommand rejects non node --test scripts', () => {
  assert.throws(() => splitNodeTestCommand('vitest run'), /node \.\.\./);
  assert.throws(() => splitNodeTestCommand('node scripts/x.mjs'), /node --test/);
  assert.throws(() => splitNodeTestCommand('node --test'), /no test file patterns/);
});

test('the real test:unit script is a node --test command the retry wrapper can drive', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const { flags, patterns } = splitNodeTestCommand(pkg.scripts['test:unit']);
  assert.ok(flags.includes('--test'));
  assert.ok(patterns.includes('"scripts/**/*.test.mjs"'));
});

test('buildShellCommand quotes injected values but keeps globs unquoted for sh', () => {
  const cmd = buildShellCommand('node --test x/*.test.mjs', {
    nodeBin: '/opt/my node/bin/node',
    extraFlags: ['--test-reporter=spec', "--test-reporter-destination=/tmp/it's.jsonl"]
  });
  assert.equal(
    cmd,
    `'/opt/my node/bin/node' --test --test-reporter=spec '--test-reporter-destination=/tmp/it'\\''s.jsonl' x/*.test.mjs`
  );
  assert.equal(shellQuote('plain/path-1.mjs'), 'plain/path-1.mjs');
});

test('buildRetryArgs re-runs a single file with the original node flags', () => {
  assert.deepEqual(buildRetryArgs(['--experimental-strip-types', '--test'], 'a.test.js'), [
    '--experimental-strip-types',
    '--test',
    'a.test.js'
  ]);
});

test('parseFailureLines skips blank and truncated lines', () => {
  const events = parseFailureLines('{"file":"a","name":"x"}\n\n{"file":"b"\n42\n');
  assert.deepEqual(events, [{ file: 'a', name: 'x' }]);
});

test('groupFailuresByFile groups by relative file, drops parent suites, counts unattributed', () => {
  const { files, unattributed } = groupFailuresByFile(
    [
      { file: '/repo/b.test.mjs', name: 'leaf', failureType: 'testCodeFailure', message: 'boom' },
      { file: '/repo/b.test.mjs', name: 'suite', failureType: 'subtestsFailed' },
      { file: '/repo/b.test.mjs', name: 'leaf', failureType: 'testCodeFailure' },
      { file: '/repo/a.test.mjs', name: 'a.test.mjs', failureType: 'testCodeFailure' },
      { file: null, name: 'orphan' }
    ],
    '/repo'
  );
  assert.equal(unattributed, 1);
  assert.deepEqual(files, [
    { file: 'a.test.mjs', tests: [{ name: 'a.test.mjs', message: '' }] },
    { file: 'b.test.mjs', tests: [{ name: 'leaf', message: 'boom' }] }
  ]);
});

test('groupFailuresByFile keeps the file name when the reporter realpath differs from the temp root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retry-root-'));
  try {
    writeFileSync(join(dir, 'flaky.test.mjs'), '');
    const reported = join(realpathSync(dir), 'flaky.test.mjs');
    const { files } = groupFailuresByFile(
      [{ file: reported, name: 'flips', failureType: 'testCodeFailure', message: 'first run' }],
      dir
    );
    assert.deepEqual(files.map((g) => g.file), ['flaky.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retryPlan only retries attributable, bounded failures', () => {
  const one = [{ file: 'a', tests: [] }];
  assert.deepEqual(retryPlan({ exitCode: 0, files: [], unattributed: 0 }), { retry: false, pass: true, reason: null });
  assert.deepEqual(retryPlan({ exitCode: 1, files: one, unattributed: 0 }), { retry: true, pass: false, reason: null });
  assert.match(retryPlan({ exitCode: 1, files: [], unattributed: 0 }).reason, /without attributable/);
  assert.match(retryPlan({ exitCode: 1, files: one, unattributed: 2 }).reason, /2 failure\(s\) without a test file/);
  const many = Array.from({ length: 4 }, (_, i) => ({ file: `f${i}`, tests: [] }));
  const plan = retryPlan({ exitCode: 1, files: many, unattributed: 0, maxRetryFiles: 3 });
  assert.equal(plan.retry, false);
  assert.match(plan.reason, /4 failing files exceeds retry limit 3/);
});

test('classifyRetry: pass on retry is flaky, anything else (incl. missing) is failed', () => {
  const files = [{ file: 'a' }, { file: 'b' }, { file: 'c' }];
  const { flaky, failed } = classifyRetry(files, { a: 0, b: 1 });
  assert.deepEqual(flaky.map((g) => g.file), ['a']);
  assert.deepEqual(failed.map((g) => g.file), ['b', 'c']);
});

test('workflow-command escaping follows the actions toolkit rules', () => {
  assert.equal(escapeData('50%\r\nnext'), '50%25%0D%0Anext');
  assert.equal(escapeProperty('a:b,c%'), 'a%3Ab%2Cc%25');
});

test('renderAnnotations emits warning for flaky and error for failed-twice', () => {
  const lines = renderAnnotations(
    {
      flaky: [{ file: 'x,y.test.mjs', tests: [{ name: 't1' }, { name: 't2' }] }],
      failed: [{ file: 'z.test.mjs', tests: [] }]
    },
    'unit'
  );
  assert.deepEqual(lines, [
    '::warning file=x%2Cy.test.mjs,title=Flaky test (unit)::Failed, then passed on isolated retry: t1; t2',
    '::error file=z.test.mjs,title=Test failed twice (unit)::Failed on first run and on isolated retry: (file-level failure)'
  ]);
});

test('renderSummary lists flaky and failed sections, empty when clean', () => {
  assert.equal(renderSummary({ flaky: [], failed: [] }, 'unit'), '');
  const md = renderSummary(
    { flaky: [{ file: 'a.test.mjs', tests: [{ name: 'x | y' }] }], failed: [{ file: 'b.test.mjs', tests: [{ name: 'z' }] }] },
    'unit'
  );
  assert.match(md, /### Flaky tests \(unit\)/);
  assert.match(md, /\| `a\.test\.mjs` \| x \\\| y \|/);
  assert.match(md, /### Failed twice \(unit\)/);
});

test('buildReport passes when clean or when every retried file passed', () => {
  const base = { label: 'unit', script: 'test:unit', flaky: [], failed: [] };
  assert.equal(buildReport({ ...base, firstExitCode: 0, plan: { retry: false, pass: true, reason: null } }).pass, true);
  assert.equal(buildReport({ ...base, firstExitCode: 1, plan: { retry: true, pass: false, reason: null } }).pass, true);
  const bad = buildReport({ ...base, firstExitCode: 1, plan: { retry: true, pass: false, reason: null }, failed: [{ file: 'a' }] });
  assert.equal(bad.pass, false);
  assert.equal(bad.schema, 1);
});

function runCli(files, script, { junit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'retry-cli-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { 'test:unit': script } }));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const junitArgs = junit ? ['--junit', join(dir, 'results', 'unit.xml')] : [];
    // A nested `node --test` must not inherit the parent runner's child-process protocol.
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const r = spawnSync(process.execPath, [cli, '--cwd', dir, '--report', join(dir, 'report.json'), ...junitArgs], {
      env: { ...env, GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
      timeout: 60_000
    });
    const resultsDir = join(dir, 'results');
    return {
      status: r.status,
      stdout: r.stdout,
      report: JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')),
      summary: readFileSync(summary, 'utf8'),
      junit: junit
        ? Object.fromEntries(readdirSync(resultsDir).sort().map((f) => [f, readFileSync(join(resultsDir, f), 'utf8')]))
        : null
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fails the first time it runs in a given directory, passes afterwards.
const FLAKY = `import test from 'node:test';
import fs from 'node:fs';
test('flips', () => {
  const marker = new URL('./ran-once', import.meta.url);
  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ''); throw new Error('first run'); }
});
`;
const STABLE = `import test from 'node:test';\ntest('ok', () => {});\n`;
const BROKEN = `import test from 'node:test';\ntest('always', () => { throw new Error('nope'); });\n`;

test('CLI: a file that passes on isolated retry is reported flaky and the step fails', () => {
  const r = runCli({ 'flaky.test.mjs': FLAKY, 'stable.test.mjs': STABLE }, 'node --test *.test.mjs');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.report.pass, false);
  assert.equal(r.report.retried, true);
  assert.deepEqual(r.report.flaky.map((g) => g.file), ['flaky.test.mjs']);
  assert.deepEqual(r.report.failed, []);
  assert.match(r.stdout, /::warning file=flaky\.test\.mjs,title=Flaky test \(unit\)::.*flips/);
  assert.match(r.summary, /### Flaky tests \(unit\)/);
});

test('CLI --junit: the retry gets its own JUnit file and the acceptance gate retains the initial failure', () => {
  const r = runCli({ 'flaky.test.mjs': FLAKY, 'stable.test.mjs': STABLE }, 'node --test *.test.mjs', { junit: true });
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(Object.keys(r.junit), ['unit.retry-1.xml', 'unit.xml']);
  const results = Object.entries(r.junit).flatMap(([f, xml]) => parseJUnit(xml).map((c) => ({ ...c, source: `results/${f}` })));
  const flips = results.filter((c) => c.name === 'flips');
  assert.deepEqual(flips.map((c) => c.outcome).sort(), ['failed', 'passed']);
  const merged = dedupeResults(results);
  assert.deepEqual(merged.filter((c) => c.name === 'flips').map((c) => c.outcome), ['failed']);
  assert.deepEqual(merged.filter((c) => c.name === 'ok').map((c) => c.outcome), ['passed']);
});

test('CLI: a file that fails twice fails the step', () => {
  const r = runCli({ 'broken.test.mjs': BROKEN, 'stable.test.mjs': STABLE }, 'node --test *.test.mjs');
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.report.pass, false);
  assert.deepEqual(r.report.failed.map((g) => g.file), ['broken.test.mjs']);
  assert.match(r.stdout, /::error file=broken\.test\.mjs,title=Test failed twice/);
  assert.match(r.summary, /### Failed twice \(unit\)/);
});

test('CLI: a clean run passes without retrying and writes an empty report', () => {
  const r = runCli({ 'stable.test.mjs': STABLE }, 'node --test *.test.mjs');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual({ retried: r.report.retried, flaky: r.report.flaky, failed: r.report.failed }, { retried: false, flaky: [], failed: [] });
  assert.equal(r.summary, '');
});
