#!/usr/bin/env node
/**
 * Run a `node --test` npm script; when it fails, re-run each failing test FILE once in its own
 * process. Files that pass on retry are flaky: unlisted failures fail the step, which emits ::warning
 * annotations, a step-summary section and a JSON report. A file that fails twice fails the step.
 *
 * Usage: node scripts/ci/retry-failed-tests.mjs [--script test:unit] [--label unit] [--report <file.json>]
 *        [--junit <file.xml>] [--max-retry-files 10] [--cwd <dir with package.json>]
 *
 * --junit writes JUnit for the first pass to <file.xml> and for each retry to <file>.retry-N.xml.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_RETRY_FILES,
  buildReport,
  buildRetryArgs,
  buildShellCommand,
  classifyRetry,
  groupFailuresByFile,
  parseFailureLines,
  renderAnnotations,
  renderSummary,
  retryPlan,
  splitNodeTestCommand
} from './flaky-retry-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPORTER = fileURLToPath(new URL('./failed-tests-reporter.mjs', import.meta.url));

function parseArgs(argv) {
  const args = { script: 'test:unit', label: 'unit', report: null, junit: null, maxRetryFiles: DEFAULT_MAX_RETRY_FILES, cwd: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--script') args.script = argv[++i];
    else if (a === '--junit') args.junit = path.resolve(argv[++i]);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--report') args.report = argv[++i];
    else if (a === '--max-retry-files') args.maxRetryFiles = Number(argv[++i]);
    else if (a === '--cwd') args.cwd = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.cwd;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = pkg.scripts?.[args.script];
  if (!command) throw new Error(`package.json has no script "${args.script}"`);
  const { flags } = splitNodeTestCommand(command);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-failed-tests-'));
  const failuresFile = path.join(tmp, 'failures.jsonl');
  if (args.junit) fs.mkdirSync(path.dirname(args.junit), { recursive: true });
  const junitFlags = (file) => (file ? ['--test-reporter=junit', `--test-reporter-destination=${file}`] : []);
  const shellCommand = buildShellCommand(command, {
    nodeBin: process.execPath,
    extraFlags: [
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${REPORTER}`,
      `--test-reporter-destination=${failuresFile}`,
      ...junitFlags(args.junit)
    ]
  });

  console.log(`[retry-failed-tests] npm run ${args.script} (first pass)`);
  const first = spawnSync('sh', ['-c', shellCommand], { cwd: root, stdio: 'inherit', env: process.env });
  const firstExitCode = first.status ?? 1;
  const failures = fs.existsSync(failuresFile) ? parseFailureLines(fs.readFileSync(failuresFile, 'utf8')) : [];
  const { files, unattributed } = groupFailuresByFile(failures, root);
  const plan = retryPlan({ exitCode: firstExitCode, files, unattributed, maxRetryFiles: args.maxRetryFiles });

  let flaky = [];
  let failed = plan.pass ? [] : files;
  if (plan.retry) {
    const retryExitCodes = {};
    for (const [i, group] of files.entries()) {
      console.log(`\n[retry-failed-tests] retrying in isolation: ${group.file}`);
      // The acceptance gate reads `<name>.retry-N.xml` as another run of `<name>.xml`.
      const retryJunit = args.junit ? args.junit.replace(/(\.xml)?$/, `.retry-${i + 1}.xml`) : null;
      const retryFlags = [
        ...flags,
        ...(retryJunit ? ['--test-reporter=spec', '--test-reporter-destination=stdout', ...junitFlags(retryJunit)] : [])
      ];
      const r = spawnSync(process.execPath, buildRetryArgs(retryFlags, group.file), { cwd: root, stdio: 'inherit', env: process.env });
      retryExitCodes[group.file] = r.status ?? 1;
    }
    ({ flaky, failed } = classifyRetry(files, retryExitCodes));
  } else if (!plan.pass) {
    console.log(`\n::error title=${args.script} failed::${plan.reason}; not retried`);
  }

  const report = buildReport({ label: args.label, script: args.script, firstExitCode, plan, flaky, failed });
  if (!report.pass && flaky.length) console.log('::error::Unlisted retry recovery is not a clean pass');
  for (const line of renderAnnotations({ flaky, failed: plan.retry ? failed : [] }, args.label)) console.log(line);
  const summary = renderSummary({ flaky, failed: plan.retry ? failed : [] }, args.label);
  if (summary && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (args.report) {
    fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(
    `\n[retry-failed-tests] ${report.pass ? 'PASS' : 'FAIL'}: first exit=${firstExitCode}, ` +
      `flaky=${flaky.length}, failed=${report.pass ? 0 : failed.length}`
  );
  process.exit(report.pass ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`[retry-failed-tests] ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
}
