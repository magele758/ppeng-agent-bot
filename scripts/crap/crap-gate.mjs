#!/usr/bin/env node
/**
 * CRAP release gate.
 *
 *   npm run test:crap                     run unit + agent-loop vitest with coverage, then gate
 *   npm run test:crap -- --preflight      check runner/provider resolution without running tests
 *   npm run test:crap -- --update-baseline  accept the current debt as the new baseline
 *   node scripts/crap/crap-gate.mjs --node-cov <dir> --vitest-cov <coverage-final.json>
 *                                         reuse coverage collected by an earlier CI step
 *
 * Exit codes: 0 pass, 1 gate failed, 2 could not compute (e.g. a test suite failed).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin, sanitizeScriptEnv } from '../spawn-utils.mjs';
import { resolveCoverageToolchain } from './coverage-toolchain.mjs';
import {
  DEFAULT_THRESHOLD,
  allowedCrap,
  buildBaseline,
  collectFunctions,
  coveredLinesFromIstanbul,
  coveredSourceLines,
  decodeMappings,
  evaluateGate,
  paintV8Functions,
  scoreFunctions,
} from './crap-lib.mjs';

import { baseRevision, git, compareBaselines } from '../ci/base-revision.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASELINE_PATH = path.join(ROOT, 'scripts/crap/crap-baseline.json');
const SOURCE_ROOTS = ['packages/*/src', 'apps/daemon/src', 'apps/cli/src', 'apps/web-console'];

function parseArgs(argv) {
  const args = { threshold: DEFAULT_THRESHOLD, out: path.join(ROOT, 'coverage/crap'), update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update-baseline') args.update = true;
    else if (a === '--preflight') args.preflight = true;
    else if (a === '--node-cov') args.nodeCov = path.resolve(argv[++i]);
    else if (a === '--vitest-cov') args.vitestCov = path.resolve(argv[++i]);
    else if (a === '--threshold') args.threshold = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.threshold) || args.threshold <= 0) throw new Error('--threshold must be a positive number');
  return args;
}

function run(cmd, cmdArgs, opts) {
  console.log(`[crap] $ ${cmd} ${cmdArgs.join(' ')}`);
  const res = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit', ...opts, env: sanitizeScriptEnv(opts?.env ?? process.env)
  });
  if (res.status !== 0) {
    console.error(`[crap] command failed (exit ${res.status}); coverage would be incomplete, aborting.`);
    process.exit(2);
  }
}

function collectNodeCoverage(tmp) {
  const dir = path.join(tmp, 'v8');
  run(resolveBin('npm'), ['run', 'test:unit'], { cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: dir } });
  return dir;
}

function collectVitestCoverage(tmp, cli) {
  const dir = path.join(tmp, 'vitest');
  run(
    process.execPath,
    [
      cli, 'run',
      '--coverage.enabled', '--coverage.provider=v8', '--coverage.reporter=json',
      `--coverage.reportsDirectory=${dir}`,
    ],
    { cwd: path.join(ROOT, 'packages/agent-loop') },
  );
  return path.join(dir, 'coverage-final.json');
}

function listSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '__fixtures__' && !e.name.startsWith('.') && e.name !== 'dist') walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
        files.push(p);
      }
    }
  };
  for (const pattern of SOURCE_ROOTS) {
    const [head, tail] = pattern.split('/*/');
    const bases = tail
      ? fs.readdirSync(path.join(ROOT, head)).map((d) => path.join(ROOT, head, d, tail))
      : [path.join(ROOT, pattern)];
    for (const base of bases) if (fs.existsSync(base)) walk(base);
  }
  return files.sort();
}

function addLines(map, file, lines) {
  let set = map.get(file);
  if (!set) map.set(file, (set = new Set()));
  for (const l of lines) set.add(l);
}

function linesFromPaint(text, paint) {
  const lines = new Set();
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) line++;
    else if (paint[i] && c !== 32 && c !== 9 && c !== 13) lines.add(line);
  }
  return lines;
}

/** Merges every process' V8 coverage, then maps dist JS back to TS source lines via source maps. */
function nodeCoveredLines(covDir, sourceSet) {
  const paints = new Map();
  const texts = new Map();
  for (const name of fs.readdirSync(covDir)) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf8'));
    for (const script of data.result ?? []) {
      if (!script.url.startsWith('file://')) continue;
      const file = fileURLToPath(script.url);
      const isDist = file.includes(`${path.sep}dist${path.sep}`) && file.endsWith('.js');
      if (!file.startsWith(ROOT) || (!isDist && !sourceSet.has(file))) continue;
      if (!texts.has(file)) {
        if (!fs.existsSync(file)) continue;
        texts.set(file, fs.readFileSync(file, 'utf8'));
      }
      const paint = paintV8Functions(script.functions, texts.get(file).length);
      const prev = paints.get(file);
      if (!prev) paints.set(file, paint);
      else for (let i = 0; i < paint.length; i++) prev[i] |= paint[i];
    }
  }
  const covered = new Map();
  for (const [file, paint] of paints) {
    const text = texts.get(file);
    if (sourceSet.has(file)) {
      addLines(covered, file, linesFromPaint(text, paint));
      continue;
    }
    const mapPath = `${file}.map`;
    if (!fs.existsSync(mapPath)) continue;
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const mapDir = path.resolve(path.dirname(mapPath), map.sourceRoot ?? '');
    const bySource = coveredSourceLines(text, paint, decodeMappings(map.mappings));
    for (const [idx, lines] of bySource) {
      const src = path.resolve(mapDir, map.sources[idx]);
      if (sourceSet.has(src)) addLines(covered, src, lines);
    }
  }
  return covered;
}

function fmtPct(cov) {
  return `${Math.round(cov * 100)}%`;
}

function tableRows(rows, withBaseline) {
  return rows
    .map((r) => {
      const base = withBaseline ? ` | ${r.baselineCrap} (≤ ${Math.round(allowedCrap(r.baselineCrap, r.baselineCoverage) * 10) / 10})` : '';
      return `| ${r.crap} | ${r.complexity} | ${fmtPct(r.coverage)}${base} | \`${r.file}:${r.line}\` \`${r.name}\` |`;
    })
    .join('\n');
}

function renderMarkdown(result, rows, args, metadata) {
  const lines = [];
  lines.push(`## CRAP gate: ${result.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push(`Runtime: Node ${metadata.node} (${metadata.platform}/${metadata.arch}); ` +
    `Vitest ${metadata.vitest}; coverage-v8 ${metadata.coverageV8}.`, '');
  lines.push(
    `Threshold ${args.threshold}. Functions scored: ${rows.length}. ` +
      `Over threshold: ${result.debtCount} (all baselined unless listed below).`,
  );
  if (result.newViolations.length) {
    lines.push('', `### New functions over threshold (${result.newViolations.length})`, '');
    lines.push('Add tests (raise coverage) or split the function (lower complexity).', '');
    lines.push('| CRAP | complexity | coverage | function |', '|---:|---:|---:|---|');
    lines.push(tableRows(result.newViolations, false));
  }
  if (result.regressions.length) {
    lines.push('', `### Baselined functions that got worse (${result.regressions.length})`, '');
    lines.push('| CRAP | complexity | coverage | baseline (allowed) | function |', '|---:|---:|---:|---:|---|');
    lines.push(tableRows(result.regressions, true));
  }
  if (result.improved.length) {
    lines.push(
      '',
      `${result.improved.length} baselined function(s) improved or were removed; ` +
        'run `npm run test:crap -- --update-baseline` to lock in the gain.',
    );
  }
  const worst = [...rows].sort((a, b) => b.crap - a.crap).slice(0, 15);
  lines.push('', '<details><summary>Top 15 riskiest functions</summary>', '');
  lines.push('| CRAP | complexity | coverage | function |', '|---:|---:|---:|---|');
  lines.push(tableRows(worst, false));
  lines.push('', '</details>', '');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const toolchain = resolveCoverageToolchain(ROOT);
  console.log(`[crap] toolchain ${JSON.stringify(toolchain.metadata)}`);
  if (args.preflight) return;
  const base = baseRevision(ROOT);
  if (!base) throw new Error('CRAP gate requires a Git base revision');
  const baseline = JSON.parse(git(ROOT, ['show', base + ':scripts/crap/crap-baseline.json']));
  // Bootstrap newly scanned web code from the BASE tree, never from candidate scores.
  const baseWeb = git(ROOT, ['ls-tree', '-r', '--name-only', base, '--', 'apps/web-console']).split('\n')
    .filter(f => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
  for (const file of baseWeb) {
    const source = git(ROOT, ['show', base + ':' + file]);
    const debt = buildBaseline(scoreFunctions(file, collectFunctions(file, source)), baseline.threshold);
    for (const [key, entry] of Object.entries(debt.functions)) baseline.functions[key] ??= entry;
  }
  const local = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const relaxations = compareBaselines(baseline, local);
  if (args.threshold > baseline.threshold) relaxations.push('CRAP threshold exceeds base threshold');
  if (relaxations.length) throw new Error(relaxations.join('\n'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crap-'));
  const nodeCov = args.nodeCov ?? collectNodeCoverage(tmp);
  const vitestCov = args.vitestCov ?? collectVitestCoverage(tmp, toolchain.cli);
  if (!fs.existsSync(nodeCov)) throw new Error(`node coverage dir not found: ${nodeCov}`);
  if (!fs.existsSync(vitestCov)) throw new Error(`vitest coverage file not found: ${vitestCov}`);

  const sources = listSourceFiles();
  const sourceSet = new Set(sources);
  const covered = nodeCoveredLines(nodeCov, sourceSet);
  const vitest = JSON.parse(fs.readFileSync(vitestCov, 'utf8'));
  for (const [file, fileCov] of Object.entries(vitest)) {
    if (sourceSet.has(file)) addLines(covered, file, coveredLinesFromIstanbul(fileCov));
  }

  const rows = [];
  for (const abs of sources) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const fns = collectFunctions(abs, fs.readFileSync(abs, 'utf8'));
    rows.push(...scoreFunctions(rel, fns, covered.get(abs)));
  }

  fs.mkdirSync(args.out, { recursive: true });
  if (args.update) {
    const baseline = buildBaseline(rows, args.threshold);
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`[crap] baseline updated: ${Object.keys(baseline.functions).length} function(s) over ${args.threshold}`);
  }
  const result = evaluateGate(rows, baseline, args.threshold);
  const metadata = {
    ...toolchain.metadata,
    generatedAt: new Date().toISOString(),
    coverageMode: args.nodeCov || args.vitestCov ? 'reused' : 'fresh'
  };
  const md = renderMarkdown(result, rows, args, metadata);
  fs.writeFileSync(path.join(args.out, 'crap-report.json'), JSON.stringify({ metadata, result, rows }, null, 2));
  fs.writeFileSync(path.join(args.out, 'crap-summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(md);
  console.log(`[crap] report: ${path.relative(ROOT, args.out)}/crap-report.json`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(result.pass ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(`[crap] ${err instanceof Error ? err.stack : err}`);
  process.exit(2);
}
