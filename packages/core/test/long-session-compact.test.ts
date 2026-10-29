import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';

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

function scripted(summary: string) {
  const calls: unknown[] = [];
  return {
    calls,
    adapter: {
      name: 'scripted',
      contextWindow: 131072,
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages(input: unknown) {
        calls.push(input);
        return summary;
      }
    }
  };
}

test('a bot history over the send ceiling and under half the window is summarized [AC:long-session-compact#AC-1]', async () => {
  const { SqliteStateStore } = await import('../src/storage.ts');
  const { autoCompactSession } = await import('../src/runtime/compact-host.ts');
  const { createExtensionRegistry } = await import('../src/extensions/extension-registry.ts');
  const { estimateMessageTokens } = await import('../src/model/token-estimate.ts');
  const { resolveBotWindowBudget } = await import('../src/session/history/window.ts');
  const dir = mkdtempSync(join(tmpdir(), 'long-compact-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    const session = store.createSession({
      title: 'bot chat',
      mode: 'chat',
      agentId: 'bot-a',
      metadata: { canonicalBotChat: true, botId: 'bot-a' }
    });
    for (let i = 0; i < 30; i += 1) {
      store.appendMessage(session.id, 'user', [{ type: 'text', text: `turn-${i} ${'h'.repeat(6000)}` }]);
    }
    const estimated = estimateMessageTokens(store.foldMessages(session.id));
    const shape = new Map([[session.id, { systemPromptChars: 372288, toolCount: 0 }]]);
    const budget = resolveBotWindowBudget(store, { contextWindow: 131072 }, shape.get(session.id));
    assert.ok(estimated > budget.historyTokens);
    assert.ok(estimated < budget.structuredTokens);
    assert.ok(store.foldMessages(session.id).length < 56);
    const model = scripted('Goal: keep the long middle\nConstraints: none\nProgress: mid\nDecisions: none\nFiles: none\nNext steps: continue');
    const result = await autoCompactSession(
      {
        store,
        stateDir: dir,
        modelAdapter: model.adapter,
        extensionRegistry: createExtensionRegistry(),
        turnShapeBySession: shape,
        emitTrace() {},
        prepareMessagesForModel: async (_session: unknown, messages: unknown) => messages
      },
      {
        repoRoot: '/repo',
        stateDir: dir,
        session: store.getSession(session.id),
        agent: { id: 'bot-a', name: 'bot-a', role: 'assistant', instructions: '', capabilities: [] }
      }
    );
    assert.ok(result.replaced);
    assert.equal(model.calls.length, 1);
    assert.match(store.getSession(session.id)?.summary ?? '', /keep the long middle/);
  } finally {
    store.db.close();
  }
});

test('a long session under the token threshold still gets an LLM summary [AC:long-session-compact#AC-2]', async () => {
  const { SqliteStateStore } = await import('../src/storage.ts');
  const { autoCompactSession, LONG_SESSION_COMPACT_MESSAGES } = await import('../src/runtime/compact-host.ts');
  const { createExtensionRegistry } = await import('../src/extensions/extension-registry.ts');
  const { estimateMessageTokens } = await import('../src/model/token-estimate.ts');
  const { resolveHistoryTokenBudget } = await import('../src/session/session-budget.ts');
  const { resolveBotWindowBudget } = await import('../src/session/history/window.ts');
  assert.equal(LONG_SESSION_COMPACT_MESSAGES, 56);
  assert.equal(resolveHistoryTokenBudget('RAW_AGENT_COMPACT_TOKEN_THRESHOLD', {}), 109072);
  const dir = mkdtempSync(join(tmpdir(), 'long-count-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  try {
    for (const kind of ['plain', 'canonical'] as const) {
      const session = store.createSession({
        title: kind,
        mode: 'chat',
        agentId: kind === 'plain' ? 'general' : 'bot-a',
        metadata: kind === 'canonical' ? { canonicalBotChat: true, botId: 'bot-a' } : {}
      });
      for (let i = 0; i < 60; i += 1) {
        store.appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', [{ type: 'text', text: `m${i}` }]);
      }
      const tokens = estimateMessageTokens(store.foldMessages(session.id));
      const budget = resolveBotWindowBudget(store, { contextWindow: 131072 }, {});
      assert.ok(tokens < budget.structuredTokens);
      assert.ok(tokens < budget.historyTokens);
      assert.ok(tokens < 109072);
      const model = scripted(`SUMMARY ${kind}`);
      const result = await autoCompactSession(
        {
          store,
          stateDir: dir,
          modelAdapter: model.adapter,
          extensionRegistry: createExtensionRegistry(),
          turnShapeBySession: new Map(),
          emitTrace() {},
          prepareMessagesForModel: async (_session: unknown, messages: unknown) => messages
        },
        {
          repoRoot: '/repo',
          stateDir: dir,
          session: store.getSession(session.id),
          agent: { id: session.agentId, name: session.agentId, role: 'assistant', instructions: '', capabilities: [] }
        }
      );
      assert.ok(result.replaced, kind);
      assert.equal(model.calls.length, 1, kind);
      assert.match(store.getSession(session.id)?.summary ?? '', new RegExp(`SUMMARY ${kind}`));
    }
  } finally {
    store.db.close();
  }
});

test('a bot turn inside the send ceiling does not record context_budget [AC:long-session-compact#AC-3]', async () => {
  const { shouldRecordContextBudgetSkip } = await import('../src/session/bot-compact-policy.ts');
  const source = readFileSync(fileURLToPath(new URL('../src/runtime/l5-bindings.ts', import.meta.url)), 'utf8');
  assert.match(source, /shouldRecordContextBudgetSkip\(estimated, budget, compacted\)/);
  assert.equal(
    shouldRecordContextBudgetSkip(1_000, { structuredTokens: 65_536, historyTokens: 113_072 }, false),
    false
  );
  assert.equal(
    shouldRecordContextBudgetSkip(70_000, { structuredTokens: 65_536, historyTokens: 113_072 }, true),
    false
  );
});

test('a needed compact that does not land still records context_budget [AC:long-session-compact#AC-4]', async () => {
  const { shouldRecordContextBudgetSkip } = await import('../src/session/bot-compact-policy.ts');
  assert.equal(
    shouldRecordContextBudgetSkip(70_000, { structuredTokens: 65_536, historyTokens: 113_072 }, false),
    true
  );
  assert.equal(
    shouldRecordContextBudgetSkip(20_000, { structuredTokens: 65_536, historyTokens: 12_000 }, false),
    true
  );
});
