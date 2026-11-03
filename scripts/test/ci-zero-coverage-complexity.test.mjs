import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectFunctions,
  coveredSourceLines,
  decodeMappings,
  paintV8Functions,
  scoreFunctions,
} from '../crap/crap-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VIEW_FILES = [
  'apps/web-console/components/SessionListRow.tsx',
  'apps/web-console/components/sections/tasks/OutboundDraftCard.tsx',
];

test('session list and outbound draft functions stay at complexity 5 or below [AC:ci-zero-coverage-complexity#AC-1]', () => {
  const over = [];
  for (const file of VIEW_FILES) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const fn of collectFunctions(file, text)) {
      if (fn.complexity > 5) over.push(`${fn.name} ${fn.complexity} ${file}:${fn.line}`);
    }
  }
  assert.deepEqual(over, []);
});

function inboxTestFiles() {
  return readdirSync(path.join(ROOT, 'packages/core/test'))
    .filter((name) => name.startsWith('agent-inbox') && name.endsWith('.test.js'))
    .map((name) => path.join('packages/core/test', name));
}

function mergePaint(covDir, generatedPath) {
  let paint = null;
  let text = null;
  for (const name of readdirSync(covDir)) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(path.join(covDir, name), 'utf8'));
    for (const script of data.result ?? []) {
      if (!script.url?.startsWith('file://')) continue;
      if (fileURLToPath(script.url) !== generatedPath) continue;
      text ??= readFileSync(generatedPath, 'utf8');
      const next = paintV8Functions(script.functions, text.length);
      if (!paint) paint = next;
      else for (let i = 0; i < next.length; i++) paint[i] |= next[i];
    }
  }
  return { paint, text };
}

function claimExecuteScore(covDir) {
  const sourceRel = 'packages/core/src/agent-inbox/tools.ts';
  const sourceAbs = path.join(ROOT, sourceRel);
  const source = readFileSync(sourceAbs, 'utf8');
  const generated = path.join(ROOT, 'packages/core/dist/agent-inbox/tools.js');
  const map = JSON.parse(readFileSync(`${generated}.map`, 'utf8'));
  const { paint, text } = mergePaint(covDir, generated);
  assert.ok(paint && text, 'agent inbox tool coverage was not recorded');
  const mapDir = path.resolve(path.dirname(`${generated}.map`), map.sourceRoot ?? '');
  const bySource = coveredSourceLines(text, paint, decodeMappings(map.mappings));
  let covered = null;
  for (const [idx, lines] of bySource) {
    if (path.resolve(mapDir, map.sources[idx]) === sourceAbs) covered = lines;
  }
  assert.ok(covered, 'source map did not cover tools.ts');
  const functions = collectFunctions(sourceRel, source);
  const rows = scoreFunctions(sourceRel, functions, covered);
  const claim = functions.find((fn) => {
    const slice = source.split('\n').slice(fn.line - 1, fn.line + 45).join('\n');
    return slice.includes('already_claimed');
  });
  assert.ok(claim, 'claim execute function was not found');
  const row = rows.find((item) => item.name === claim.name && item.line === claim.line);
  assert.ok(row, claim.name);
  return row;
}

test('claim inbox execute stays at CRAP 30 or below [AC:ci-zero-coverage-complexity#AC-2]', () => {
  const covDir = mkdtempSync(path.join(tmpdir(), 'inbox-crap-'));
  try {
    const env = { ...process.env, NODE_V8_COVERAGE: covDir };
    // A nested `node --test` inherits this and exits without running the files.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', ...inboxTestFiles()],
      { cwd: ROOT, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const row = claimExecuteScore(covDir);
    assert.equal(row.name, 'createAgentInboxTools.execute#3');
    assert.ok(row.crap <= 30, JSON.stringify(row));
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
});
