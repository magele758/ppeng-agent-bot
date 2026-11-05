/**
 * Runnable acceptance-tagged tests, using the same file set as the acceptance gate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { globToRegExp, nodeTestPatterns, parseSpec, scanTestSource } from '../acceptance/acceptance-lib.mjs';

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
  '.agent-state',
  '.evolution-worktrees',
]);
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.tmp-')) continue;
      walk(root, join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

function runnerPatterns(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const unit = nodeTestPatterns(pkg.scripts?.['test:unit'] ?? '');
  if (!unit.length) throw new Error('package.json scripts["test:unit"] has no --test patterns');

  let vitestInclude = ['src/**/*.test.ts'];
  const vitestCfg = join(root, 'packages/agent-loop/vitest.config.ts');
  try {
    const match = /include:\s*\[([^\]]*)\]/.exec(readFileSync(vitestCfg, 'utf8'));
    if (match) vitestInclude = [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
  } catch {
    // default include
  }

  let e2eDir = 'e2e';
  try {
    const match = /testDir:\s*['"]\.?\/?([^'"]+)['"]/.exec(readFileSync(join(root, 'playwright.config.ts'), 'utf8'));
    if (match) e2eDir = match[1].replace(/\/$/, '');
  } catch {
    // default e2e directory
  }

  return {
    unit,
    vitest: vitestInclude.map((pattern) => `packages/agent-loop/${pattern}`),
    e2e: [`${e2eDir}/**/*.spec.ts`, `${e2eDir}/**/*.test.ts`],
  };
}

export function loadSpecs(root) {
  const dir = join(root, 'acceptance');
  const specs = [];
  const errors = [];
  for (const name of readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    const parsed = parseSpec(readFileSync(join(dir, name), 'utf8'), name);
    if (parsed.errors.length || !parsed.spec) {
      errors.push(...(parsed.errors.length ? parsed.errors : [`acceptance/${name}: no spec`]));
      continue;
    }
    specs.push(parsed.spec);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return specs;
}

/** Active tagged tests grouped by spec id, plus which runner executes each file. */
export function indexActiveTests(root) {
  const patterns = runnerPatterns(root);
  const regexes = {
    unit: patterns.unit.map(globToRegExp),
    vitest: patterns.vitest.map(globToRegExp),
    e2e: patterns.e2e.map(globToRegExp),
  };
  const byRunner = { unit: [], vitest: [], e2e: [] };
  for (const file of walk(root)) {
    if (regexes.unit.some((re) => re.test(file))) byRunner.unit.push(file);
    else if (regexes.vitest.some((re) => re.test(file))) byRunner.vitest.push(file);
    else if (regexes.e2e.some((re) => re.test(file))) byRunner.e2e.push(file);
  }
  const runnerByFile = new Map();
  const grouped = new Map();
  for (const [runner, files] of Object.entries(byRunner)) {
    for (const file of files) {
      runnerByFile.set(file, runner);
      for (const hit of scanTestSource(readFileSync(join(root, file), 'utf8'), file)) {
        if (!hit.active) continue;
        for (const tag of hit.tags) {
          if (tag.error || !tag.featureId) continue;
          let filesForSpec = grouped.get(tag.featureId);
          if (!filesForSpec) {
            filesForSpec = new Set();
            grouped.set(tag.featureId, filesForSpec);
          }
          filesForSpec.add(file);
        }
      }
    }
  }
  const testsBySpec = new Map();
  for (const [id, files] of grouped) testsBySpec.set(id, [...files].sort());
  const runnableCount = byRunner.unit.length + byRunner.vitest.length + byRunner.e2e.length;
  return { testsBySpec, runnerByFile, runnableCount };
}
