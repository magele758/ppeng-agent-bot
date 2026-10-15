#!/usr/bin/env node
/**
 * Mutation gate for critical core modules (see doc/MUTATION_TESTING.md).
 *
 *   npm run test:mutation                           all modules in scripts/mutation/mutation.config.json
 *   npm run test:mutation -- --module a,b           only these modules
 *   npm run test:mutation -- --update-baseline      ratchet mutation-baseline.json up to this run's scores
 *   npm run test:mutation -- --update-baseline --allow-decrease   also accept lower scores
 *   npm run test:mutation -- --list                 print the mutants, run nothing
 *   npm run test:mutation -- --shard 2/4 --no-gate --out <dir>   one interleaved quarter (CI matrix)
 *   npm run test:mutation -- --merge <dir>          gate on every mutation-report.json under <dir>
 *
 * Other flags: --concurrency <n> (default: CPU count), --operators a,b, --max-mutants <n> (even
 * sample per file, for quick local loops), --no-gate (always exit 0 after reporting), --out <dir>.
 *
 * Mutants are generated on the compiled dist JS and served in memory by mutant-loader.mjs, so
 * nothing on disk is ever modified. Needs a current build (`node scripts/build-workspace.mjs`).
 *
 * Exit codes: 0 pass, 1 gate failed, 2 could not run (stale/missing dist, clean test run failed,
 * target not loaded by its tests).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { SourceMap } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paintV8Functions } from '../crap/crap-lib.mjs';
import {
  DEFAULT_FLOOR,
  DEFAULT_TOLERANCE,
  OPERATORS,
  applyMutant,
  classifyRun,
  evaluateGate,
  functionRanges,
  generateMutants,
  isCovered,
  isSyntaxValid,
  mergeModuleReports,
  mutantTimeoutMs,
  parseShard,
  renderMarkdown,
  sampleEvenly,
  scoreResults,
  shardMutants,
  summarizeModule,
  updateBaseline,
} from './mutation-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(ROOT, 'scripts/mutation/mutation.config.json');
const BASELINE_PATH = path.join(ROOT, 'scripts/mutation/mutation-baseline.json');
const LOADER = path.join(ROOT, 'scripts/mutation/mutant-loader.mjs');
const BAIL_REPORTER = path.join(ROOT, 'scripts/mutation/bail-reporter.mjs');
const CLEAN_RUN_TIMEOUT_MS = 10 * 60 * 1000;

const active = new Set();
let tmpRoot;

class FatalError extends Error {}

function parseArgs(argv) {
  const args = {
    concurrency: os.availableParallelism(),
    operators: OPERATORS,
    maxMutants: 0,
    gate: true,
    update: false,
    allowDecrease: false,
    list: false,
    out: path.join(ROOT, 'coverage/mutation'),
  };
  const value = (i) => {
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--module') args.modules = value(i++).split(',').filter(Boolean);
    else if (a === '--concurrency') args.concurrency = Number(value(i++));
    else if (a === '--operators') args.operators = value(i++).split(',').filter(Boolean);
    else if (a === '--max-mutants') args.maxMutants = Number(value(i++));
    else if (a === '--shard') args.shard = parseShard(value(i++));
    else if (a === '--merge') args.merge = path.resolve(value(i++));
    else if (a === '--out') args.out = path.resolve(value(i++));
    else if (a === '--no-gate') args.gate = false;
    else if (a === '--update-baseline') args.update = true;
    else if (a === '--allow-decrease') args.allowDecrease = true;
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  validateArgs(args);
  return args;
}

function validateArgs(args) {
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw new Error('--concurrency must be a positive integer');
  const unknownOps = args.operators.filter((o) => !OPERATORS.includes(o));
  if (unknownOps.length) throw new Error(`unknown operators: ${unknownOps.join(', ')} (known: ${OPERATORS.join(', ')})`);
  const partial = args.shard?.count > 1 || args.maxMutants > 0 || args.operators.length !== OPERATORS.length;
  if (args.update && partial) throw new Error('--update-baseline needs a full run (no --shard / --max-mutants / --operators)');
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function loadSourceMap(distFile) {
  const mapFile = `${distFile}.map`;
  if (!fs.existsSync(mapFile)) return undefined;
  const payload = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const base = path.resolve(path.dirname(mapFile), payload.sourceRoot ?? '');
  return { map: new SourceMap(payload), sources: payload.sources.map((s) => path.resolve(base, s)) };
}

function assertFresh(distFile, sm) {
  const distTime = fs.statSync(distFile).mtimeMs;
  for (const src of sm?.sources ?? []) {
    if (fs.existsSync(src) && fs.statSync(src).mtimeMs > distTime + 1000) {
      throw new FatalError(`${rel(src)} is newer than ${rel(distFile)}; run node scripts/build-workspace.mjs first`);
    }
  }
}

function sourceLocation(sm, distRel, m) {
  const entry = sm?.map.findEntry(m.line - 1, m.column - 1);
  if (!entry?.originalSource) return `${distRel}:${m.line}`;
  const src = entry.originalSource.startsWith('file:')
    ? fileURLToPath(entry.originalSource)
    : path.resolve(path.dirname(path.join(ROOT, distRel)), entry.originalSource);
  return `${rel(src)}:${entry.originalLine + 1}`;
}

function resolveTargets(mod, args) {
  return mod.mutate.map((entry) => {
    const file = path.join(ROOT, typeof entry === 'string' ? entry : entry.file);
    if (!fs.existsSync(file)) throw new FatalError(`${rel(file)} missing; run node scripts/build-workspace.mjs first`);
    const text = fs.readFileSync(file, 'utf8');
    const sm = loadSourceMap(file);
    assertFresh(file, sm);
    const ranges = typeof entry === 'string' ? undefined : functionRanges(rel(file), text, entry.functions);
    const all = generateMutants(rel(file), text, { ranges, operators: args.operators });
    const mutants = shardMutants(sampleEvenly(all, args.maxMutants), args.shard);
    return { file, rel: rel(file), text, sm, mutants };
  });
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function tail(text, max = 4000) {
  return text.length > max ? text.slice(-max) : text;
}

function failureExcerpt(res) {
  const highlights = res.highlights?.trim();
  return highlights ? `${highlights}\n---\n${res.output}` : res.output;
}

function runChild(nodeArgs, env, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let highlights = '';
    let timedOut = false;
    const child = spawn(process.execPath, ['--import', LOADER, ...nodeArgs], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    active.add(child);
    const collect = (chunk) => {
      const text = String(chunk);
      output = tail(output + text);
      for (const line of text.split('\n')) {
        if (/not ok |AssertionError|ERR_TEST|took \d+(\.\d+)?ms/.test(line)) highlights = tail(highlights + line + '\n', 2000);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const done = (result) => {
      clearTimeout(timer);
      active.delete(child);
      resolve({ ...result, timedOut, ms: Date.now() - started, output, highlights });
    };
    child.on('error', (err) => done({ spawnError: err.message }));
    child.on('close', (code, signal) => done({ code, signal }));
  });
}

/**
 * Runs the module's test files in order; the first non-passing file decides.
 * TMPDIR is left alone: the bash tool's bwrap sandbox mounts a fresh /tmp, and tests that run
 * commands in a temp dir rely on it being the default one.
 */
async function runTests(testFiles, extraEnv, { timeoutMs, bail }) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const reporter = bail ? [`--test-reporter=${pathToFileURL(BAIL_REPORTER).href}`] : [];
  let last;
  let ms = 0;
  for (const testFile of testFiles) {
    last = await runChild([...reporter, testFile], env, timeoutMs);
    ms += last.ms;
    if (classifyRun(last) !== 'survived') break;
  }
  return { ...last, ms };
}

async function pool(items, size, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

function readPaint(covDir, target) {
  const url = pathToFileURL(target.file).href;
  let merged;
  for (const name of fs.existsSync(covDir) ? fs.readdirSync(covDir) : []) {
    const data = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf8'));
    for (const script of data.result ?? []) {
      if (script.url !== url) continue;
      // Paint each process separately and OR them: one process's zero counts must not hide another's hits.
      const paint = paintV8Functions(script.functions, target.text.length);
      if (!merged) merged = paint;
      else for (let i = 0; i < paint.length; i++) merged[i] |= paint[i];
    }
  }
  return merged;
}

/**
 * Clean run of the module's tests with the loader serving the unmodified target, `concurrency`
 * copies at once: proves the tests pass, tolerate running in parallel and really load the target.
 * Copy 0 also records V8 block coverage, so mutants in never-executed code need no test run.
 */
async function cleanRun(id, mod, target, concurrency) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${id}-clean-`));
  const sourceFile = path.join(dir, 'source.js');
  const covDir = path.join(dir, 'v8');
  fs.writeFileSync(sourceFile, target.text);
  let slowest = 0;
  await pool(Array.from({ length: concurrency }, (_, i) => i), concurrency, async (i) => {
    const hit = path.join(dir, `hit-${i}`);
    const env = { MUTATION_TARGET: target.file, MUTATION_SOURCE: sourceFile, MUTATION_HIT: hit };
    if (i === 0) env.NODE_V8_COVERAGE = covDir;
    const res = await runTests(mod.testFiles, env, { timeoutMs: CLEAN_RUN_TIMEOUT_MS, bail: false });
    if (classifyRun(res) !== 'survived') {
      throw new FatalError(`[${id}] clean test run failed (copy ${i + 1}/${concurrency}):\n${failureExcerpt(res)}`);
    }
    if (!fs.existsSync(hit)) throw new FatalError(`[${id}] ${mod.testFiles.join(', ')} never import ${target.rel}`);
    slowest = Math.max(slowest, res.ms);
  });
  return { cleanMs: slowest, paint: readPaint(covDir, target) };
}

async function runMutant(mod, target, m, dir, timeoutMs, paint) {
  const mutated = applyMutant(target.text, m);
  if (!isSyntaxValid(target.rel, mutated)) return { status: 'error', ms: 0 };
  if (!isCovered(paint, m)) return { status: 'no-coverage', ms: 0 };
  const sourceFile = path.join(dir, `m${m.id}.js`);
  fs.writeFileSync(sourceFile, mutated);
  const env = { MUTATION_TARGET: target.file, MUTATION_SOURCE: sourceFile };
  const res = await runTests(mod.testFiles, env, { timeoutMs, bail: true });
  fs.rmSync(sourceFile, { force: true });
  return { status: classifyRun(res), ms: res.ms };
}

async function runTarget(id, mod, target, args, onResult) {
  if (!target.mutants.length) return;
  const { cleanMs, paint } = await cleanRun(id, mod, target, args.concurrency);
  const timeoutMs = mutantTimeoutMs(cleanMs);
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${id}-`));
  await pool(target.mutants, args.concurrency, async (m) => {
    const { status, ms } = await runMutant(mod, target, m, dir, timeoutMs, paint);
    onResult({
      id: m.id,
      file: target.rel,
      where: sourceLocation(target.sm, target.rel, m),
      distLine: m.line,
      operator: m.operator,
      original: m.original,
      replacement: m.replacement,
      status,
      ms,
    });
  });
}

function progressLogger(id, total) {
  const results = [];
  let lastStep = -1;
  const onResult = (r) => {
    results.push(r);
    const step = Math.floor((results.length / total) * 10);
    if (step === lastStep) return;
    lastStep = step;
    const s = scoreResults(results);
    console.log(
      `[mutation] ${id}: ${results.length}/${total} (killed ${s.killed}, timeout ${s.timeout}, survived ${s.survived}, no cov ${s.noCoverage})`,
    );
  };
  return { results, onResult };
}

async function runModule(id, mod, args) {
  const started = Date.now();
  const targets = resolveTargets(mod, args);
  const total = targets.reduce((n, t) => n + t.mutants.length, 0);
  console.log(`[mutation] ${id}: ${total} mutant(s) in ${targets.map((t) => t.rel).join(', ')}`);
  const { results, onResult } = progressLogger(id, total);
  for (const target of targets) await runTarget(id, mod, target, args, onResult);
  return summarizeModule({ id, description: mod.description, results, durationMs: Date.now() - started });
}

function listMutants(config, ids, args) {
  for (const id of ids) {
    for (const t of resolveTargets(config.modules[id], args)) {
      console.log(`# ${id} ${t.rel}: ${t.mutants.length} mutant(s)`);
      for (const m of t.mutants) {
        const flat = (s) => s.replace(/\s+/g, ' ').slice(0, 60);
        console.log(`${sourceLocation(t.sm, t.rel, m)}\t${m.operator}\t${flat(m.original)} -> ${flat(m.replacement)}`);
      }
    }
  }
}

function findReports(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findReports(p));
    else if (e.name === 'mutation-report.json') out.push(p);
  }
  return out;
}

function writeReports(gate, args, durationMs) {
  fs.mkdirSync(args.out, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), durationMs, shard: args.shard ?? null, pass: gate.pass, modules: gate.modules };
  fs.writeFileSync(path.join(args.out, 'mutation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const scope = args.shard ? ` (shard ${args.shard.index}/${args.shard.count})` : '';
  const md = `${renderMarkdown(gate)}\nRuntime${scope}: ${Math.round(durationMs / 1000)}s.\n`;
  fs.writeFileSync(path.join(args.out, 'mutation-summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  console.log(`\n${md}`);
  console.log(`[mutation] report: ${rel(path.join(args.out, 'mutation-report.json'))}`);
}

async function collectModules(config, args) {
  if (args.merge) {
    const files = findReports(args.merge);
    if (!files.length) throw new FatalError(`no mutation-report.json under ${args.merge}`);
    const reports = files.map((f) => readJson(f));
    const merged = mergeModuleReports(reports);
    // A shard that crashed leaves its modules out; they then fail the gate as "no valid mutants".
    for (const id of args.modules ?? Object.keys(config.modules)) {
      if (!merged.some((m) => m.id === id)) merged.push(summarizeModule({ id, description: config.modules[id].description, results: [], durationMs: 0 }));
    }
    return { modules: merged, durationMs: Math.max(...reports.map((r) => r.durationMs ?? 0)) };
  }
  const started = Date.now();
  const ids = args.modules ?? Object.keys(config.modules);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-'));
  const modules = [];
  for (const id of ids) modules.push(await runModule(id, config.modules[id], args));
  return { modules, durationMs: Date.now() - started };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJson(CONFIG_PATH);
  const unknown = (args.modules ?? []).filter((id) => !config.modules[id]);
  if (unknown.length) throw new Error(`unknown modules: ${unknown.join(', ')} (known: ${Object.keys(config.modules).join(', ')})`);
  if (args.list) return listMutants(config, args.modules ?? Object.keys(config.modules), args);

  const { modules, durationMs } = await collectModules(config, args);
  const baseline = readJson(BASELINE_PATH, { version: 1, modules: {} });
  const opts = { floor: config.floor ?? DEFAULT_FLOOR, tolerance: config.tolerance ?? DEFAULT_TOLERANCE };
  const gate = evaluateGate(modules, baseline, opts);
  writeReports(gate, args, durationMs);

  if (args.update) {
    const { baseline: next, changes } = updateBaseline(baseline, modules, { allowDecrease: args.allowDecrease });
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    for (const c of changes) console.log(`[mutation] baseline ${c.id}: ${c.from ?? 'new'} -> ${c.to}`);
    if (!changes.length) console.log('[mutation] baseline unchanged');
    return;
  }
  if (!gate.pass && args.gate) process.exitCode = 1;
}

function cleanup() {
  for (const child of active) killGroup(child);
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

main()
  .catch((err) => {
    console.error(`[mutation] ${err instanceof FatalError ? err.message : (err.stack ?? err)}`);
    process.exitCode = 2;
  })
  .finally(cleanup);
