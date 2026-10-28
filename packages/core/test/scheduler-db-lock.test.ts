import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mutateGoalSnapshot } from '../src/bots/goals/store.ts';
import type { GoalSnapshot, GoalStore } from '../src/bots/goals/types.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent?.includes('/packages/core/src/') && (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
      const candidate = join(dirname(fileURLToPath(parent)), specifier).replace(/\.js$/, '.ts');
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes('/packages/core/src/') && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      const source = ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path
      }).outputText;
      return { format: 'module', source, shortCircuit: true };
    }
    return next(url, context);
  }
});

function emptySnapshot(): GoalSnapshot {
  return { goals: [], executions: [], events: [], processed: [], fence: 0 };
}

function busySnapshot(): Error {
  const error = new Error('database is locked') as Error & { code: string; errcode: number };
  error.code = 'ERR_SQLITE_ERROR';
  error.errcode = 517;
  return error;
}

test('stale snapshot lock is restarted and the goal snapshot is saved [AC:scheduler-db-lock#AC-1]', () => {
  let writes = 0;
  let saved: GoalSnapshot | undefined;
  const sql: string[] = [];
  const store: GoalStore = {
    getDaemonControl: () => emptySnapshot(),
    setDaemonControl: (_key, value) => {
      writes += 1;
      if (writes === 1) throw busySnapshot();
      saved = value as GoalSnapshot;
    },
    db: {
      isTransaction: false,
      exec(statement: string) { sql.push(statement); }
    }
  };
  const result = mutateGoalSnapshot(store, 'bot-a', (state) => {
    state.fence = 7;
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.equal(writes, 2);
  assert.equal(saved?.fence, 7);
  assert.equal(sql.filter((statement) => statement === 'BEGIN IMMEDIATE').length, 2);
  assert.ok(sql.includes('ROLLBACK'));
  assert.ok(sql.includes('COMMIT'));
  assert.equal(sql.includes('SAVEPOINT bot_goal_mutation'), false);

});

test('a runtime that does not own the state directory does not write from the scheduler [AC:scheduler-db-lock#AC-2]', async () => {
  // registerHooks must run before runtime.ts resolves its .js specifiers; a static import is evaluated first.
  const { RawAgentRuntime } = await import('../src/runtime.ts');
  const { tryAcquireFdLock } = await import('../src/teams/fd-lock.ts');
  const dir = mkdtempSync(join(tmpdir(), 'scheduler-lock-'));
  const held = tryAcquireFdLock(join(dir, 'runtime-recovery.lock.db'));
  assert.ok(held, 'test must hold the ownership lock first');
  const runtime = new RawAgentRuntime({
    repoRoot: dir,
    stateDir: dir,
    modelAdapter: { name: 'stub', async runTurn() { return { stopReason: 'end' as const, assistantParts: [] }; } }
  });
  let writes = 0;
  const original = runtime.store.setDaemonControl.bind(runtime.store);
  runtime.store.setDaemonControl = ((key: string, value: unknown) => {
    writes += 1;
    return original(key, value);
  }) as typeof runtime.store.setDaemonControl;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    await runtime.runScheduler();
    await runtime.runScheduler();
    assert.equal(writes, 0);
    assert.equal(warnings.some((line) => line.includes('scheduler loop failed')), false);
    assert.equal(warnings.filter((line) => line.includes('another runtime owns this state directory')).length, 1);
  } finally {
    console.warn = originalWarn;
    await runtime.destroy();
    held?.release();
    rmSync(dir, { recursive: true, force: true });
  }
});
