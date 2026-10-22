import { describe, expect, it } from 'vitest';
import { createAssembledLoop } from './create-assembled-loop.js';
import { createDefaultMemoryStore, DEFAULT_EMBED_AGENT } from './store-adapter.js';
import { shellHistoryFromFold } from '../tools/shell-policy.js';
import type { ModelAdapter, ModelTurnResult, ToolContract } from '../types.js';

function stubAdapter(
  impl: () => ModelTurnResult | Promise<ModelTurnResult>,
  identity: { name?: string; modelName?: string } = {}
): ModelAdapter {
  return {
    name: identity.name ?? 'heuristic',
    ...(identity.modelName ? { modelName: identity.modelName } : {}),
    async runTurn() {
      return impl();
    },
    async summarizeMessages() {
      return 'summary';
    },
  };
}

async function runCommand(opts: {
  name?: string;
  modelName?: string;
  repeatGuard?: 'weak' | 'all' | 'off';
  prior?: string[];
  command: string;
}) {
  const { store, surface } = createDefaultMemoryStore({ agent: DEFAULT_EMBED_AGENT });
  if (opts.repeatGuard) {
    store.getDaemonControl = (key: string) =>
      key === 'loop_settings' ? { repeatGuard: opts.repeatGuard } : undefined;
  }
  const session = surface.createSession({
    title: 't',
    mode: 'chat',
    agentId: DEFAULT_EMBED_AGENT.id,
  });
  surface.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
  for (const [i, command] of (opts.prior ?? []).entries()) {
    surface.appendMessage(session.id, 'assistant', [
      { type: 'tool_call', toolCallId: `prior-${i}`, name: 'bash', input: { command } },
    ]);
    surface.appendMessage(session.id, 'tool', [
      { type: 'tool_result', toolCallId: `prior-${i}`, name: 'bash', ok: true, content: 'ok' },
    ]);
  }
  const historyLength = shellHistoryFromFold(store.foldMessages(session.id)).length;
  let executed = 0;
  const bash: ToolContract<Record<string, unknown>> = {
    name: 'bash',
    description: 'bash',
    inputSchema: {},
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => {
      executed += 1;
      return { ok: true, content: 'ran' };
    },
  };
  let calls = 0;
  const assembled = await createAssembledLoop({
    preset: 'max',
    io: {
      store,
      tools: [bash],
      model: stubAdapter(() => {
        calls += 1;
        if (calls === 1) {
          return {
            stopReason: 'tool_use',
            assistantParts: [
              {
                type: 'tool_call',
                toolCallId: 'next',
                name: 'bash',
                input: { command: opts.command },
              },
            ],
          };
        }
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      }, { name: opts.name, modelName: opts.modelName }),
    },
  });
  await assembled.run(session.id);
  const text = store
    .foldMessages(session.id)
    .flatMap((message) => message.parts)
    .map((part) => (part.type === 'tool_result' && typeof part.content === 'string' ? part.content : ''))
    .join('\n');
  return { text, executed, historyLength };
}

const eightLists = Array.from({ length: 8 }, (_, i) => `ls src ${i}`);
const fourSearches = ['rg a', 'rg b', 'rg c', 'rg d'];

describe('max-host', () => {
  it('blocks extra directory listing and code search for a weak model by default [AC:loop-guard-model-switch#AC-1]', async () => {
    const listed = await runCommand({ prior: eightLists, command: 'ls src extra' });
    expect(listed.historyLength).toBe(8);
    expect(listed.text).toMatch(/Directory browse limit/);
    expect(listed.executed).toBe(0);

    const searched = await runCommand({ prior: fourSearches, command: 'rg zzz' });
    expect(searched.text).toMatch(/Code search limit/);
    expect(searched.executed).toBe(0);
  });

  it('lets a strong model list and search past the old caps [AC:loop-guard-model-switch#AC-2]', async () => {
    const listed = await runCommand({
      name: 'openai-compatible',
      modelName: 'gpt-4o',
      prior: eightLists,
      command: 'ls src extra',
    });
    expect(listed.text).toContain('ran');
    expect(listed.text).not.toMatch(/Directory browse limit/);
    expect(listed.executed).toBe(1);

    const searched = await runCommand({
      name: 'openai-compatible',
      modelName: 'gpt-4o',
      prior: fourSearches,
      command: 'rg zzz',
    });
    expect(searched.text).toContain('ran');
    expect(searched.executed).toBe(1);
  });

  it('blocks a strong model after repeat detection is saved as all [AC:loop-guard-model-switch#AC-3]', async () => {
    const listed = await runCommand({
      name: 'openai-compatible',
      modelName: 'gpt-4o',
      repeatGuard: 'all',
      prior: eightLists,
      command: 'ls src extra',
    });
    expect(listed.text).toMatch(/Directory browse limit/);
    expect(listed.executed).toBe(0);
  });

  it('lets a weak model list directories after repeat detection is turned off [AC:loop-guard-model-switch#AC-4]', async () => {
    const listed = await runCommand({
      repeatGuard: 'off',
      prior: eightLists,
      command: 'ls src extra',
    });
    expect(listed.text).toContain('ran');
    expect(listed.executed).toBe(1);
  });

  it('still blocks GUI launch and unbounded walks when repeat detection is off [AC:loop-guard-model-switch#AC-4]', async () => {
    const gui = await runCommand({ repeatGuard: 'off', command: 'open /Applications' });
    expect(gui.text).toMatch(/GUI launch/);
    expect(gui.executed).toBe(0);

    const walk = await runCommand({ repeatGuard: 'off', command: 'find /usr -name "*.so"' });
    expect(walk.text).toMatch(/maxdepth/);
    expect(walk.executed).toBe(0);
  });
});
