import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const PLANTED = 'planted-message-body-should-not-leak-9f3a';

test('prepare, prompt, and MCP expansion keep separate durations [AC:bot-startup-trace#AC-4]', async () => {
  const { prepareTurnInput } = await import('../src/turn/prepare-turn-input.ts');
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const { McpManager } = await import('../src/mcp/mcp-manager.ts');
  const { setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');
  const emitted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const traced: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  setStartupPhaseEmitter((sessionId, event) => {
    assert.equal(sessionId, 's1');
    emitted.push(event);
  });
  try {
    const session = {
      id: 's1',
      mode: 'chat',
      todo: [],
      summary: '',
      metadata: { botId: 's1' }
    };
    const folded = [message(PLANTED, 1)];
    await prepareTurnInput('s1', {
      store: {
        getSession: () => session,
        foldMessages: () => folded,
        hideByKey: () => 0,
        appendMessage: () => folded[0]
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      prepareView: async (_session, messages) => messages,
      buildAppendix: async () => PLANTED,
      emitTrace: (_id, event) => {
        traced.push(event);
      }
    });

    const preparePhases = traced.map((event) => event.payload.phase);
    for (const phase of ['auto_compact', 'fold_messages', 'prepare_view', 'prepare_turn', 'fold_budget', 'memory_appendix', 'seal_exposure', 'embed_quotes']) {
      assert.ok(preparePhases.includes(phase), phase);
    }

    const builder = new PromptBuilder({
      store: { getSession: () => session, listSessionMemory: () => [] },
      repoRoot: '/nonexistent-repo-root-xyz',
      extraSkills: [
        { id: 'sk-1', name: 'alpha', description: PLANTED, content: PLANTED }
      ]
    });
    const prompt = await builder.buildSystemPrompt(
      {
        agent: { id: 'general', name: 'Bot', role: 'assistant', instructions: 'Be helpful.', capabilities: [] },
        session,
        repoRoot: '/nonexistent-repo-root-xyz'
      },
      [message(PLANTED, 2)]
    );
    assert.match(prompt, /Be helpful/);

    const mgr = new McpManager({
      stateDir: '/tmp',
      tools: [],
      env: {
        RAW_AGENT_MCP_URLS: 'http://secret.example/mcp',
        RAW_AGENT_MCP_EXPAND_HTTP: '1',
        RAW_AGENT_MCP_HEADERS: `Authorization=${PLANTED}`
      },
      log: { warn() {} }
    });
    const timed = mgr as unknown as {
      connectHttp: () => Promise<void>;
      expandListedHttpTools: () => Promise<void>;
      connectStdioMcpServers: () => Promise<void>;
    };
    timed.connectHttp = async () => undefined;
    timed.expandListedHttpTools = async () => undefined;
    timed.connectStdioMcpServers = async () => undefined;
    await mgr.ensureLoaded('s1');

    const phases = [...traced, ...emitted].map((event) => event.payload);
    const byName = (name: string) => phases.filter((payload) => payload.phase === name);
    for (const phase of ['skill_catalog', 'skill_route', 'memory_appendix', 'mcp_expand', 'mcp_http_connect', 'mcp_http_list', 'mcp_stdio']) {
      assert.equal(byName(phase).length, 1, phase);
      assert.equal(typeof byName(phase)[0]?.durationMs, 'number');
    }
    assert.notEqual(byName('skill_catalog')[0], byName('skill_route')[0]);
    assert.notEqual(byName('memory_appendix')[0], byName('mcp_expand')[0]);
    assert.equal(byName('skill_catalog')[0]?.scope, 'prompt');
    assert.equal(byName('mcp_expand')[0]?.scope, 'mcp');
    assert.equal(typeof byName('skill_catalog')[0]?.skillCount, 'number');
    assert.equal(typeof byName('mcp_expand')[0]?.endpointCount, 'number');
    assert.equal(JSON.stringify(phases).includes(PLANTED), false);
    assert.equal(JSON.stringify(phases).includes('secret.example'), false);
  } finally {
    setStartupPhaseEmitter(undefined);
  }
});

test('a throwing startup emitter does not fail prepare or the prompt [AC:bot-startup-trace#AC-4]', async () => {
  const { prepareTurnInput } = await import('../src/turn/prepare-turn-input.ts');
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const { setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');
  setStartupPhaseEmitter(() => {
    throw new Error(PLANTED);
  });
  try {
    const session = { id: 's1', mode: 'chat', todo: [], metadata: {} };
    await prepareTurnInput('s1', {
      store: {
        getSession: () => session,
        foldMessages: () => [message(PLANTED, 1)],
        hideByKey: () => 0,
        appendMessage: () => message('x', 1)
      },
      autoCompact: async () => undefined,
      claimNextStep: () => [],
      prepareView: async (_session, messages) => messages,
      buildAppendix: async () => '',
      emitTrace: () => {
        throw new Error(PLANTED);
      }
    });
    const builder = new PromptBuilder({
      store: { getSession: () => session },
      repoRoot: '/nonexistent-repo-root-xyz',
      extraSkills: []
    });
    const prompt = await builder.buildSystemPrompt(
      {
        agent: { id: 'general', name: 'Bot', role: 'assistant', instructions: 'ok', capabilities: [] },
        session,
        repoRoot: '/nonexistent-repo-root-xyz'
      },
      []
    );
    assert.match(prompt, /ok/);
  } finally {
    setStartupPhaseEmitter(undefined);
  }
});

function message(text: string, seq: number) {
  return {
    id: `m${seq}`,
    sessionId: 's1',
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt: '2026-10-28T00:00:00.000Z',
    seq
  };
}
