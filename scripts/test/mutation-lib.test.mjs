import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from '../mutation/mutation-lib.mjs';

const mutate = (src, opts) => generateMutants('f.js', src, opts);
const results = (src, operator) =>
  mutate(src, { operators: [operator] }).map((m) => applyMutant(src, m));

test('boundary, equality and logical operators swap exactly one token', () => {
  assert.deepEqual(results('if (a < b) f();', 'boundary'), ['if (a <= b) f();']);
  assert.deepEqual(results('x = a >= b;', 'boundary'), ['x = a > b;']);
  assert.deepEqual(results('x = a === b && c != d;', 'equality'), ['x = a !== b && c != d;', 'x = a === b && c == d;']);
  assert.deepEqual(results('x = a && b || c;', 'logical'), ['x = a && b && c;', 'x = a || b || c;']);
});

test('negate wraps if / while / ternary conditions and drops a leading !', () => {
  assert.deepEqual(results('if (ok) f();', 'negate'), ['if (!(ok)) f();']);
  assert.deepEqual(results('x = ok ? 1 : 2;', 'negate'), ['x = !(ok) ? 1 : 2;']);
  assert.deepEqual(results('while (n) n--;', 'negate'), ['while (!(n)) n--;']);
  assert.deepEqual(results('x = !y;', 'negate'), ['x = y;']);
});

test('boolean flips literals', () => {
  assert.deepEqual(results('x = [true, false];', 'boolean'), ['x = [false, false];', 'x = [true, true];']);
});

test('return-value and remove-guard only touch guard (early) returns and jumps', () => {
  const src = 'function f(a) {\n  if (a) return a.b;\n  if (!a) { throw new Error("x"); }\n  return 1;\n}';
  assert.deepEqual(results(src, 'return-value'), [src.replace('return a.b;', 'return undefined;')]);
  const removed = results(src, 'remove-guard');
  assert.equal(removed.length, 2);
  assert.ok(removed[0].includes('if (a) ;'));
  assert.ok(removed[1].includes('if (!a) { ; }'));
  assert.ok(removed.every((r) => r.includes('return 1;')), 'the final return is not a guard');
  assert.deepEqual(results('function f(a) { if (a) return true; }', 'return-value'), [], 'boolean returns are left to the boolean operator');
});

test('remove-call drops call statements inside functions, never top-level, super() or console', () => {
  const src = 'init();\nclass A extends B { constructor() { super(); this.x = 1; } }\nfunction f(s) { s.push(1); console.warn("w"); await g(); }';
  const out = mutate(src, { operators: ['remove-call'] }).map((m) => m.original);
  assert.deepEqual(out, ['s.push(1);', 'await g();']);
});

test('string-empty targets patterns and discriminators, not messages, keys or module specifiers', () => {
  const src = [
    "import x from 'mod';",
    "export { y } from './y.js';",
    "const SET = new Set(['rm', 'dd']);",
    "function f(a) {",
    "  if (a === 'bash' || a.startsWith('sudo ')) throw new Error('blocked');",
    "  switch (a) { case 'x': return { key: 'value' }; }",
    "  return import('./lazy.js');",
    "}",
  ].join('\n');
  const out = mutate(src, { operators: ['string-empty'] }).map((m) => m.original);
  assert.deepEqual(out, ["'rm'", "'dd'", "'bash'", "'sudo '", "'x'"]);
});

test('regex produces a never-matching and an always-matching variant, keeping flags', () => {
  assert.deepEqual(results('const R = /ab+c/gi;', 'regex'), ['const R = /(?!)/gi;', 'const R = /(?:)/gi;']);
});

test('generateMutants: ranges, ignore marker, de-duplication and positions', () => {
  const src = 'function a(x) { return x < 1; }\nfunction b(x) {\n  // mutation-ignore-next-line\n  return x < 2;\n}\nfunction c(x) { return x < 3; }';
  const all = mutate(src, { operators: ['boundary'] });
  assert.deepEqual(all.map((m) => m.line), [1, 6], 'line 4 is ignored');
  const inC = mutate(src, { operators: ['boundary'], ranges: functionRanges('f.js', src, ['c']) });
  assert.deepEqual(inC.map((m) => [m.id, m.line, m.column, m.original, m.replacement]), [[1, 6, 26, '<', '<=']]);
  const dup = mutate('x = !!y;', { operators: ['negate'] });
  assert.equal(dup.length, 1, 'removing either ! of !!y gives the same program');
  for (const op of OPERATORS) assert.ok(Array.isArray(mutate(src, { operators: [op] })));
});

test('every generated mutant still parses', () => {
  const src = [
    'export function f(a, list) {',
    '  if (!a || a.length > 3) return null;',
    '  for (let i = 0; i < list.length; i++) { if (list[i] === a) continue; list.push(a); }',
    "  const ok = /^x$/.test(a) && list.includes('y') ? true : false;",
    '  while (ok) { break; }',
    '  return ok;',
    '}',
  ].join('\n');
  const ms = mutate(src);
  assert.equal(ms.length, 20);
  assert.deepEqual(new Set(ms.map((m) => m.operator)), new Set(OPERATORS), 'the sample exercises every operator');
  for (const m of ms) assert.ok(isSyntaxValid('f.js', applyMutant(src, m)), `${m.operator} ${m.original}`);
  assert.equal(isSyntaxValid('f.js', 'if ('), false);
});

test('functionRanges finds functions and class methods by name and refuses unknown names', () => {
  const src = 'function one() {\n  return 1;\n}\nclass S {\n  get(x) {\n    return x;\n  }\n}';
  assert.deepEqual(functionRanges('f.js', src, ['get', 'one']), [[5, 7], [1, 3]]);
  assert.throws(() => functionRanges('f.js', src, ['missing']), /functions not found: missing/);
});

test('scoreResults: no-coverage counts as undetected, errors are excluded', () => {
  const s = scoreResults(['killed', 'timeout', 'survived', 'no-coverage', 'error', 'weird'].map((status) => ({ status })));
  assert.deepEqual(
    { ...s },
    { total: 6, killed: 1, timeout: 1, survived: 1, noCoverage: 1, error: 2, score: 50 },
  );
  assert.equal(scoreResults([{ status: 'killed' }, { status: 'killed' }, { status: 'survived' }]).score, 66.66);
  assert.equal(scoreResults([{ status: 'error' }]).score, null);
});

test('classifyRun maps child outcomes to statuses', () => {
  assert.equal(classifyRun({ code: 0 }), 'survived');
  assert.equal(classifyRun({ code: 1 }), 'killed');
  assert.equal(classifyRun({ code: null, signal: 'SIGSEGV' }), 'killed');
  assert.equal(classifyRun({ code: 0, timedOut: true }), 'timeout');
  assert.equal(classifyRun({ spawnError: 'ENOENT' }), 'error');
});

test('mutantTimeoutMs scales the clean run with a floor', () => {
  assert.equal(mutantTimeoutMs(500), 10000);
  assert.equal(mutantTimeoutMs(5000), 23000);
  assert.equal(mutantTimeoutMs(1000, { factor: 2, minMs: 0 }), 5000);
});

test('isCovered checks any executed character of the span; no paint means covered', () => {
  const paint = Uint8Array.from([0, 0, 1, 0]);
  assert.equal(isCovered(paint, { start: 0, end: 2 }), false);
  assert.equal(isCovered(paint, { start: 1, end: 3 }), true);
  assert.equal(isCovered(paint, { start: 2, end: 2 }), true, 'empty spans look at their start');
  assert.equal(isCovered(undefined, { start: 0, end: 1 }), true);
});

test('parseShard / shardMutants split mutants into disjoint interleaved slices', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
  assert.equal(parseShard(undefined), undefined);
  assert.throws(() => parseShard('4/3'), /out of range/);
  assert.throws(() => parseShard('0/3'), /out of range/);
  assert.throws(() => parseShard('x'), /look like/);
  const items = [0, 1, 2, 3, 4, 5, 6];
  const slices = [1, 2, 3].map((index) => shardMutants(items, { index, count: 3 }));
  assert.deepEqual(slices, [[0, 3, 6], [1, 4], [2, 5]]);
  assert.equal(shardMutants(items, undefined), items);
});

test('sampleEvenly keeps order and spreads picks', () => {
  assert.deepEqual(sampleEvenly([0, 1, 2, 3, 4, 5, 6, 7], 4), [0, 2, 4, 6]);
  assert.deepEqual(sampleEvenly([1, 2], 5), [1, 2]);
  assert.deepEqual(sampleEvenly([1, 2], 0), [1, 2]);
});

const r = (id, status, file = 'a.js', distLine = id) => ({ id, status, file, distLine, where: `src/a.ts:${id}` });

test('summarizeModule sorts results and lists undetected mutants', () => {
  const m = summarizeModule({ id: 'x', description: 'd', durationMs: 5, results: [r(3, 'survived'), r(1, 'killed'), r(2, 'no-coverage')] });
  assert.deepEqual(m.results.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(m.survivors.map((x) => x.id), [2, 3]);
  assert.equal(m.score, 33.33);
});

test('mergeModuleReports recombines shards per module', () => {
  const shard = (results) => ({ modules: [{ id: 'x', description: 'd', durationMs: results.length, results }] });
  const merged = mergeModuleReports([shard([r(1, 'killed'), r(3, 'survived')]), shard([r(2, 'killed')])]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].total, 3);
  assert.equal(merged[0].score, 66.66);
  assert.equal(merged[0].durationMs, 2);
});

test('evaluateGate: ratchet against the baseline with tolerance, floor for new modules', () => {
  const mods = [
    { id: 'held', score: 79 },
    { id: 'dropped', score: 77.9 },
    { id: 'new-ok', score: 60 },
    { id: 'new-low', score: 59.99 },
    { id: 'empty', score: null },
  ];
  const baseline = { modules: { held: { score: 80 }, dropped: { score: 80 }, empty: { score: 10 } } };
  const gate = evaluateGate(mods, baseline, { floor: 60, tolerance: 2 });
  assert.deepEqual(
    gate.modules.map((m) => [m.id, m.pass, m.required]),
    [
      ['held', true, 78],
      ['dropped', false, 78],
      ['new-ok', true, 60],
      ['new-low', false, 60],
      ['empty', false, 8],
    ],
  );
  assert.match(gate.modules[1].reason, /below baseline 80 - 2/);
  assert.match(gate.modules[3].reason, /below floor 60/);
  assert.equal(gate.modules[4].reason, 'no valid mutants');
  assert.equal(gate.pass, false);
  assert.equal(evaluateGate([{ id: 'held', score: 80 }], baseline).pass, true);
});

test('updateBaseline only raises scores unless decreases are allowed, and keeps other modules', () => {
  const prev = { version: 1, modules: { a: { score: 70, mutants: 10 }, b: { score: 90, mutants: 5 }, keep: { score: 50, mutants: 1 } } };
  const mods = [
    { id: 'a', score: 83.96, total: 12 },
    { id: 'b', score: 85, total: 5 },
    { id: 'c', score: 61.25, total: 8 },
    { id: 'd', score: null, total: 0 },
  ];
  const { baseline, changes } = updateBaseline(prev, mods);
  assert.deepEqual(changes, [{ id: 'a', from: 70, to: 83.9 }, { id: 'c', from: null, to: 61.2 }]);
  assert.deepEqual(baseline.modules.b, { score: 90, mutants: 5 });
  assert.deepEqual(baseline.modules.keep, { score: 50, mutants: 1 });
  assert.equal(baseline.modules.d, undefined);
  assert.equal(prev.modules.a.score, 70, 'input is not mutated');
  const lowered = updateBaseline(prev, [{ id: 'b', score: 85, total: 5 }], { allowDecrease: true });
  assert.deepEqual(lowered.changes, [{ id: 'b', from: 90, to: 85 }]);
});

test('renderMarkdown marks failing modules and lists undetected mutants with escaping', () => {
  const md = renderMarkdown({
    pass: false,
    modules: [
      { id: 'ok', total: 10, killed: 9, timeout: 0, survived: 1, noCoverage: 0, error: 0, score: 90, baseline: 85, required: 83, pass: true, survivors: [] },
      {
        id: 'low',
        total: 2,
        killed: 1,
        timeout: 0,
        survived: 1,
        noCoverage: 0,
        error: 0,
        score: 50,
        baseline: null,
        required: 60,
        pass: false,
        reason: 'below floor 60',
        durationMs: 1500,
        survivors: [{ where: 'src/x.ts:3', operator: 'logical', original: 'a || b', replacement: 'a && `b`', status: 'survived' }],
      },
    ],
  });
  assert.match(md, /Mutation testing: FAIL/);
  assert.match(md, /\| ok \| 10 \| 9 \| 0 \| 1 \| 0 \| 0 \| 90\.00% \| 85% \| 83% \|/);
  assert.match(md, /\| low ❌ below floor 60 \| 2 .* \| new \| 60% \| 2s \|/);
  assert.match(md, /`src\/x\.ts:3` \| logical \| `a \\\|\\\| b` → `a && 'b'` \| survived/);
  assert.doesNotMatch(md, /ok: \d+ undetected/);
});

test('model error mutation targets the implementation behind the core re-export', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../mutation/mutation.config.json', import.meta.url), 'utf8'));
  const files = config.modules['model-error-class'].mutate;
  assert.deepEqual(files, ['packages/agent-loop/dist/model/error-class.js']);
  for (const file of files) assert.ok(generateMutants(file, readFileSync(file, 'utf8')).length > 0);
});
