import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL;
    if (parent?.includes('/packages/agent-loop/src/') && specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
      const candidate = join(dirname(fileURLToPath(parent)), specifier).replace(/\.js$/, '.ts');
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.includes('/packages/agent-loop/src/') && url.endsWith('.ts')) {
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

const { decideGoalTurn } = await import('../../agent-loop/src/goal/decide-goal-turn.ts');
const { createGoalGateFromMetadata, defaultGoalMaxTurns } = await import('../../agent-loop/src/goal/goal-gate.ts');

test('goal auto-continue past the old 25-turn cap stays open when the cap is off [AC:unlimited-bot-rounds#AC-3]', () => {
  const env = { RAW_AGENT_GOAL_GATE: '1' } as NodeJS.ProcessEnv;
  assert.equal(defaultGoalMaxTurns(env), 0);
  const decision = decideGoalTurn({
    evalResult: { met: false, reason: 'still going', source: 'llm' },
    steerTexts: [],
    ledger: [],
    turnsUsed: 26,
    maxTurns: 0
  });
  assert.equal(decision.kind, 'continue');
  const gate = createGoalGateFromMetadata({ goalCondition: 'finish the report', goalMaxTurns: 25 }, env);
  assert.equal(gate?.metadataPatch().goalMaxTurns, 0);
});
