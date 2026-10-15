#!/usr/bin/env node
/**
 * Acceptance gate: every criterion of an approved/implemented acceptance/<id>.yaml must be backed
 * by a test titled with [AC:<id>#<criterion>] (and, given results, by one that passed).
 *
 *   npm run test:acceptance                  static traceability only (no tests are run)
 *   npm run test:acceptance:results          gate against JUnit files in coverage/acceptance/results/
 *   npm run test:acceptance:full             run test:unit + agent-loop vitest + e2e with JUnit
 *                                            reporters into coverage/acceptance/results/, then gate
 *   node scripts/acceptance/acceptance-gate.mjs --results <file-or-dir> [--results ...]
 *   node scripts/acceptance/acceptance-gate.mjs --collect unit,vitest   (subset of runners)
 *
 * Options: --out <dir> (default coverage/acceptance), --root <dir> (default repo root).
 * Writes <out>/report.json and <out>/summary.md; appends the summary to $GITHUB_STEP_SUMMARY.
 * Exit codes: 0 pass, 1 gate failed, 2 could not evaluate (bad arguments, unreadable results).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  containsTag,
  evaluateAcceptance,
  globToRegExp,
  nodeTestPatterns,
  parseJUnit,
  parseSpec,
  renderMarkdown,
  scanTestSource,
} from './acceptance-lib.mjs';

import { baseRevision, git, compareAcceptance } from '../ci/base-revision.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNERS = ['unit', 'vitest', 'e2e'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  'test-results',
  'playwright-report',
  'out',
  'release',
  // Generated worktrees live inside the checkout and copy tagged tests.
  // They are not part of any runner's file set, so scanning them fails the gate.
  '.agent-state',
  '.evolution-worktrees'
]);
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;
const TESTISH_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:test|tests|e2e|__tests__)\/)/;

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { root: REPO_ROOT, out: null, results: [], collect: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--results') args.results.push(next());
    else if (a === '--out') args.out = next();
    else if (a === '--root') args.root = path.resolve(next());
    else if (a === '--collect') {
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : RUNNERS.join(',');
      args.collect = v.split(',').map((s) => s.trim()).filter(Boolean);
      for (const r of args.collect) if (!RUNNERS.includes(r)) throw new UsageError(`--collect: unknown runner "${r}" (use ${RUNNERS.join(',')})`);
    } else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  args.out = path.resolve(args.root, args.out ?? 'coverage/acceptance');
  args.results = args.results.map((p) => path.resolve(p));
  return args;
}

function walk(root, dir = root, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.tmp-')) continue;
      walk(root, path.join(dir, ent.name), out);
    } else if (ent.isFile() && SOURCE_EXT_RE.test(ent.name)) {
      out.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

/** Patterns of files each runner executes, read from the same config the runners use. */
function runnerPatterns(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const unit = nodeTestPatterns(pkg.scripts?.['test:unit'] ?? '');
  if (!unit.length) throw new UsageError('package.json scripts["test:unit"] has no `--test <patterns>`');

  const vitestDir = 'packages/agent-loop';
  let vitestInclude = ['src/**/*.test.ts'];
  const vitestCfg = path.join(root, vitestDir, 'vitest.config.ts');
  if (fs.existsSync(vitestCfg)) {
    const m = /include:\s*\[([^\]]*)\]/.exec(fs.readFileSync(vitestCfg, 'utf8'));
    if (m) vitestInclude = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
  }

  let e2eDir = 'e2e';
  const pwCfg = path.join(root, 'playwright.config.ts');
  if (fs.existsSync(pwCfg)) {
    const m = /testDir:\s*['"]\.?\/?([^'"]+)['"]/.exec(fs.readFileSync(pwCfg, 'utf8'));
    if (m) e2eDir = m[1].replace(/\/$/, '');
  }

  return {
    unit,
    vitest: vitestInclude.map((p) => `${vitestDir}/${p}`),
    e2e: [`${e2eDir}/**/*.spec.ts`, `${e2eDir}/**/*.test.ts`],
  };
}

function loadSpecs(root) {
  const dir = path.join(root, 'acceptance');
  const specs = [];
  const specErrors = [];
  const specWarnings = [];
  if (!fs.existsSync(dir)) return { specs, specErrors, specWarnings };
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const { spec, errors, warnings } = parseSpec(fs.readFileSync(path.join(dir, name), 'utf8'), name);
    specErrors.push(...errors);
    specWarnings.push(...warnings);
    if (spec) specs.push(spec);
  }
  return { specs, specErrors, specWarnings };
}

function scanTests(root) {
  const patterns = runnerPatterns(root);
  const regexes = Object.values(patterns).flat().map(globToRegExp);
  const files = walk(root);
  const runnable = files.filter((f) => regexes.some((re) => re.test(f)));
  const runnableSet = new Set(runnable);
  const staticTests = [];
  for (const f of runnable) staticTests.push(...scanTestSource(fs.readFileSync(path.join(root, f), 'utf8'), f));
  const orphanFiles = files.filter(
    (f) => !runnableSet.has(f) && TESTISH_RE.test(f) && containsTag(fs.readFileSync(path.join(root, f), 'utf8')),
  );
  return { staticTests, orphanFiles, runnableCount: runnable.length };
}

function listXml(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs
    .readdirSync(p, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.xml'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

function loadResults(paths, root) {
  const results = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new UsageError(`results path not found: ${p}`);
    const files = listXml(p);
    if (!files.length) throw new UsageError(`no *.xml JUnit files under ${p}`);
    for (const f of files) {
      let cases;
      try {
        cases = parseJUnit(fs.readFileSync(f, 'utf8'));
      } catch (e) {
        throw new UsageError(`${f}: ${e.message}`);
      }
      const source = path.relative(root, f).split(path.sep).join('/');
      for (const c of cases) results.push({ ...c, source });
    }
  }
  if (!results.length) throw new UsageError('the supplied JUnit files contain no test cases');
  return results;
}

function collect(root, runners, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const steps = {
    unit: () => {
      const file = path.join(dir, 'unit.xml');
      const reporters = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${file}`;
      return ['npm', ['run', 'test:unit'], { cwd: root, env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${reporters}`.trim() } }];
    },
    vitest: () => [
      'npx',
      ['--no-install', 'vitest', 'run', '--reporter=default', '--reporter=junit', `--outputFile.junit=${path.join(dir, 'vitest.xml')}`],
      { cwd: path.join(root, 'packages/agent-loop') },
    ],
    e2e: () => [
      'npm',
      ['run', 'test:e2e', '--', '--reporter=list,junit'],
      { cwd: root, env: { ...process.env, PLAYWRIGHT_JUNIT_OUTPUT_FILE: path.join(dir, 'e2e.xml') } },
    ],
  };
  for (const r of runners) {
    const [cmd, cmdArgs, opts] = steps[r]();
    console.log(`[acceptance] $ ${cmd} ${cmdArgs.join(' ')}`);
    const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
    if (res.status !== 0) console.warn(`[acceptance] ${r} exited ${res.status}; gating on whatever results it wrote`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.collect) {
    const dir = path.join(args.out, 'results');
    collect(args.root, args.collect, dir);
    args.results.push(dir);
  }
  const { specs, specErrors, specWarnings } = loadSpecs(args.root);
  const base = baseRevision(args.root);
  if (base) {
    const baseSpecs = git(args.root, ['ls-tree', '-r', '--name-only', base, '--', 'acceptance']).split('\n').filter(f => f.endsWith('.yaml')).map(file => {
      const parsed = parseSpec(git(args.root, ['show', base + ':' + file]), path.basename(file));
      if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
      return parsed.spec;
    });
    specErrors.push(...compareAcceptance(baseSpecs, specs));
  }
  const { staticTests, orphanFiles, runnableCount } = scanTests(args.root);
  const results = args.results.length ? loadResults(args.results, args.root) : null;
  const report = evaluateAcceptance({ specs, specErrors, specWarnings, staticTests, orphanFiles, results });

  const md = renderMarkdown(report);
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify({ ...report, runnableTestFiles: runnableCount }, null, 2) + '\n');
  fs.writeFileSync(path.join(args.out, 'summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  console.log(`[acceptance] scanned ${runnableCount} runnable test files; report: ${path.relative(args.root, args.out)}/report.json`);
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const e of report.errors) console.log(`::error::${e}`);
    for (const w of report.warnings) console.log(`::warning::${w}`);
  }
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`[acceptance] ${e instanceof UsageError ? '' : 'internal error: '}${e.message}`);
  process.exitCode = 2;
}
