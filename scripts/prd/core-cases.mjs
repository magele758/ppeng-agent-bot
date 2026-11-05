#!/usr/bin/env node
/**
 * Run only the tests tagged for the specs named in doc/prd/core-cases.yaml.
 *
 *   node scripts/prd/core-cases.mjs --list
 *   node scripts/prd/core-cases.mjs
 *   node scripts/prd/core-cases.mjs --cases <file> --list
 *
 * A named spec that is missing, not implemented, or has no active tagged test
 * fails the command before any test runs.
 */
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoreCases, planCoreRun } from './core-cases-plan.mjs';
import { indexActiveTests, loadSpecs } from './test-index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = { list: false, cases: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--list') args.list = true;
    else if (token === '--cases') {
      const value = argv[++i];
      if (!value) {
        console.error('--cases needs a file');
        process.exit(1);
      }
      args.cases = isAbsolute(value) ? value : resolve(process.cwd(), value);
    } else if (token === '--help' || token === '-h') {
      console.log('node scripts/prd/core-cases.mjs [--list] [--cases <file>]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${token}`);
      process.exit(1);
    }
  }
  return args;
}

function runSlice(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  return result.status ?? 1;
}

function runPlanned(byRunner) {
  const chunk = 80;
  if (byRunner.unit.length) console.error(`unit ${byRunner.unit.length}`);
  for (let i = 0; i < byRunner.unit.length; i += chunk) {
    const status = runSlice(
      process.execPath,
      ['--experimental-strip-types', '--test', '--test-concurrency=1', ...byRunner.unit.slice(i, i + chunk)],
      root,
    );
    if (status !== 0) return status;
  }
  if (byRunner.vitest.length) {
    console.error(`vitest ${byRunner.vitest.length}`);
    const prefix = 'packages/agent-loop/';
    const rel = byRunner.vitest.map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file));
    const status = runSlice('pnpm', ['exec', 'vitest', 'run', ...rel], join(root, 'packages/agent-loop'));
    if (status !== 0) return status;
  }
  if (byRunner.e2e.length) {
    console.error(`e2e ${byRunner.e2e.length}`);
    const status = runSlice(process.execPath, ['scripts/e2e-run.mjs', ...byRunner.e2e], root);
    if (status !== 0) return status;
  }
  return 0;
}

const args = parseArgs(process.argv.slice(2));
let loaded;
try {
  loaded = loadCoreCases(root, args.cases ?? undefined);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
let specs;
let indexed;
try {
  specs = loadSpecs(root);
  indexed = indexActiveTests(root);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const plan = planCoreRun(loaded.cases, {
  specsById: new Map(specs.map((spec) => [spec.id, spec])),
  testsBySpec: indexed.testsBySpec,
  runnerByFile: indexed.runnerByFile,
});
if (!plan.ok) {
  for (const error of plan.errors) console.error(error);
  process.exit(1);
}
if (args.list) {
  process.stdout.write(`${plan.files.join('\n')}\n`);
  process.exit(0);
}
process.exit(runPlanned(plan.byRunner));
