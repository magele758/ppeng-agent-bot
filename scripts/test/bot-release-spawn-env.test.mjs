import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function execFileCalls(source) {
  const token = 'execFileSync(';
  const calls = [];
  let from = 0;
  while (from < source.length) {
    const start = source.indexOf(token, from);
    if (start < 0) break;
    let depth = 0;
    let end = start + token.length - 1;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return calls;
}

function commandOf(call) {
  return call.match(/execFileSync\(\s*'([^']+)'/)?.[1];
}

test('HTTP soak and history benchmark git/ps children do not inherit the host environment [AC:runtime-gap-closures#AC-3]', () => {
  const files = [
    'scripts/bot-release/http-soak.mjs',
    'scripts/bot-release/history-benchmark.mjs'
  ];
  const wanted = [];
  for (const file of files) {
    const source = readFileSync(resolve(file), 'utf8');
    const calls = execFileCalls(source).filter((call) => ['git', 'ps'].includes(commandOf(call)));
    assert.ok(calls.length > 0, file);
    wanted.push(...calls.map((call) => ({ file, call, command: commandOf(call) })));
  }
  assert.ok(wanted.some((item) => item.command === 'git' && item.file.endsWith('http-soak.mjs')));
  assert.ok(wanted.some((item) => item.command === 'ps' && item.file.endsWith('http-soak.mjs')));
  assert.ok(wanted.some((item) => item.command === 'git' && item.file.endsWith('history-benchmark.mjs')));
  for (const item of wanted) {
    assert.match(item.call, /sanitizeSpawnEnv\(/, `${item.file} ${item.command} inherits the host environment`);
  }
});
