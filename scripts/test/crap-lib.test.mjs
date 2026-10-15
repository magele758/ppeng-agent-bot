import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  allowedCrap,
  buildBaseline,
  collectFunctions,
  coveredLinesFromIstanbul,
  coveredSourceLines,
  crapScore,
  decodeMappings,
  evaluateGate,
  paintV8Functions,
  scoreFunctions,
} from '../crap/crap-lib.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

test('crapScore follows comp^2 * (1 - cov)^3 + comp', () => {
  assert.equal(crapScore(1, 1), 1);
  assert.equal(crapScore(10, 0), 110);
  assert.equal(crapScore(5, 0.5), 25 * 0.125 + 5);
  assert.equal(crapScore(40, 1), 40, 'full coverage cannot hide complexity');
  assert.equal(crapScore(3, 1.5), 3, 'coverage is clamped to [0, 1]');
});

test('decodeMappings decodes relative VLQ fields across lines', () => {
  const decoded = decodeMappings('AAAA,EAAC;AACA;;ACDA');
  assert.deepEqual(decoded[0], [
    { genCol: 0, source: 0, line: 0 },
    { genCol: 2, source: 0, line: 0 },
  ]);
  assert.deepEqual(decoded[1], [{ genCol: 0, source: 0, line: 1 }]);
  assert.deepEqual(decoded[2], []);
  assert.deepEqual(decoded[3], [{ genCol: 0, source: 1, line: 0 }]);
  assert.throws(() => decodeMappings('A!'), /invalid base64/);
});

test('paintV8Functions lets nested uncovered blocks override their executed parent', () => {
  const paint = paintV8Functions(
    [
      { ranges: [{ startOffset: 0, endOffset: 10, count: 1 }, { startOffset: 4, endOffset: 6, count: 0 }] },
      { ranges: [{ startOffset: 8, endOffset: 20, count: 0 }] },
    ],
    12,
  );
  assert.deepEqual([...paint], [1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0]);
});

test('cyclomatic complexity counts decisions and short-circuits, not nested functions', () => {
  const src = `
    export function f(a, b, xs) {
      if (a && b) return 1;
      const c = a ? 2 : 3;
      for (const x of xs) { if (x ?? b) continue; }
      switch (a) { case 1: break; case 2: break; default: break; }
      try { g(); } catch { return 0; }
      xs.map((y) => (y || a ? 1 : 2));
      return c;
    }`;
  const [f, cb] = collectFunctions('m.ts', src);
  assert.equal(f.name, 'f');
  assert.equal(f.complexity, 1 + 2 + 1 + 1 + 2 + 2 + 1);
  assert.equal(cb.name, 'f.<cb:xs.map>');
  assert.equal(cb.complexity, 3);
});

test('function names are stable and line-free (routes, classes, duplicates)', () => {
  const src = `
    export class Store {
      constructor() {}
      get size() { return 1; }
      save(x) { return [1].map((v) => v); }
    }
    export const routes = [
      { method: 'GET', pattern: '/api/bots', handler: () => 1 },
      { method: 'POST', pattern: '/api/bots', handler: async () => 2 },
    ];
    const helper = function () { return 3; };
    [1].forEach(() => {});
    [2].forEach(() => {});
  `;
  const names = collectFunctions('r.ts', src).map((f) => f.name);
  assert.deepEqual(names, [
    'Store.constructor',
    'Store.get size',
    'Store.save',
    'Store.save.<cb:[1].map>',
    'GET /api/bots',
    'POST /api/bots',
    'helper',
    '<cb:[1].forEach>',
    '<cb:[2].forEach>',
  ]);
  const dup = collectFunctions('d.ts', 'const o = { a() {} };\nconst p = { a() {} };').map((f) => f.name);
  assert.deepEqual(dup, ['a', 'a#2']);
});

test('statement coverage excludes nested function bodies and type-only statements', () => {
  const src = [
    'export function outer(xs: number[]) {', // 0
    '  type T = number;', // 1
    '  const n: T = xs.length;', // 2
    '  xs.forEach((x) => {', // 3
    '    console.log(x);', // 4
    '  });', // 5
    '  return n;', // 6
    '}', // 7
  ].join('\n');
  const [outer, inner] = collectFunctions('s.ts', src);
  assert.deepEqual(outer.statementLines, [2, 3, 6]);
  assert.deepEqual(inner.statementLines, [4]);
  const [o, i] = scoreFunctions('s.ts', [outer, inner], new Set([2, 3, 6]));
  assert.equal(o.coverage, 1);
  assert.equal(i.coverage, 0);
  assert.equal(o.key, 's.ts::outer');
  const [missing] = scoreFunctions('s.ts', [outer], undefined);
  assert.equal(missing.coverage, 0, 'files never loaded count as uncovered');
});

test('V8 coverage of compiled JS maps back to the right TypeScript lines', () => {
  const src = [
    'export function used(a: number): number {', // 0
    '  const b: number = a + 1;', // 1
    '  return b;', // 2
    '}', // 3
    'export function unused(a: number): number {', // 4
    '  if (a > 1) {', // 5
    '    return a;', // 6
    '  }', // 7
    '  return 0;', // 8
    '}', // 9
  ].join('\n');
  const out = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, sourceMap: true },
    fileName: 'm.ts',
  });
  const js = out.outputText;
  const map = JSON.parse(out.sourceMapText);
  const unusedStart = js.indexOf('export function unused');
  const paint = paintV8Functions(
    [
      { ranges: [{ startOffset: 0, endOffset: js.length, count: 1 }] },
      { ranges: [{ startOffset: js.indexOf('function unused'), endOffset: js.indexOf('}', js.lastIndexOf('return 0')) + 1, count: 0 }] },
    ],
    js.length,
  );
  assert.ok(unusedStart > 0);
  const lines = coveredSourceLines(js, paint, decodeMappings(map.mappings)).get(0);
  assert.ok(lines.has(1) && lines.has(2), 'executed body lines are covered');
  for (const l of [5, 6, 8]) assert.ok(!lines.has(l), `line ${l} of the unexecuted function stays uncovered`);
  const rows = scoreFunctions('m.ts', collectFunctions('m.ts', src), lines);
  assert.deepEqual(
    rows.map((r) => [r.name, r.coverage]),
    [
      ['used', 1],
      ['unused', 0],
    ],
  );
});

test('istanbul statements contribute executed lines', () => {
  const lines = coveredLinesFromIstanbul({
    statementMap: {
      0: { start: { line: 1 }, end: { line: 1 } },
      1: { start: { line: 3 }, end: { line: 4 } },
      2: { start: { line: 6 }, end: { line: 6 } },
    },
    s: { 0: 1, 1: 2, 2: 0 },
  });
  assert.deepEqual([...lines].sort(), [0, 2, 3]);
});

const row = (key, crap, extra = {}) => ({ key, file: key.split('::')[0], name: key.split('::')[1], line: 1, complexity: 10, coverage: 0, crap, ...extra });

test('gate fails on new functions over threshold, passes baselined debt', () => {
  const baseline = buildBaseline([row('a.ts::old', 110), row('a.ts::fine', 12)]);
  assert.deepEqual(Object.keys(baseline.functions), ['a.ts::old'], 'only debt is baselined');

  const ok = evaluateGate([row('a.ts::old', 110), row('a.ts::fine', 29.9)], baseline);
  assert.equal(ok.pass, true);
  assert.equal(ok.debtCount, 1);

  const bad = evaluateGate([row('a.ts::old', 110), row('a.ts::fresh', 31)], baseline);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.newViolations.map((r) => r.key), ['a.ts::fresh']);
});

test('gate fails when baselined debt grows beyond tolerance, and reports improvements', () => {
  const baseline = buildBaseline([row('a.ts::old', 100, { coverage: 0.1 }), row('a.ts::gone', 50)]);
  assert.equal(allowedCrap(100), 106);
  assert.equal(evaluateGate([row('a.ts::old', 105.9)], baseline).pass, true, 'noise within tolerance');

  const worse = evaluateGate([row('a.ts::old', 140)], baseline);
  assert.equal(worse.pass, false);
  assert.equal(worse.regressions[0].baselineCrap, 100);

  const better = evaluateGate([row('a.ts::old', 60)], baseline);
  assert.equal(better.pass, true);
  assert.deepEqual(better.improved.map((i) => i.key).sort(), ['a.ts::gone', 'a.ts::old']);
});

test('gate without a baseline treats all debt as new', () => {
  const result = evaluateGate([row('a.ts::x', 31), row('a.ts::y', 5)], null, 30);
  assert.equal(result.pass, false);
  assert.equal(result.newViolations.length, 1);
});
