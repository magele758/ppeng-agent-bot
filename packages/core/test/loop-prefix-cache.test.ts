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

const savedAgents = process.env.RAW_AGENT_AGENTS_SKILLS;
process.env.RAW_AGENT_AGENTS_SKILLS = '0';

function kv() {
  const map = new Map<string, unknown>();
  return {
    getDaemonControl(key: string) {
      return map.get(key);
    },
    setDaemonControl(key: string, value: unknown) {
      map.set(key, value);
    },
    listSessionMemory() {
      return [];
    }
  };
}

function user(sessionId: string, text: string) {
  return {
    id: `u-${text.slice(0, 12)}`,
    sessionId,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
    createdAt: '2026-10-28T00:00:00.000Z'
  };
}

function agent() {
  return { id: 'general', name: 'Bot', role: 'assistant', instructions: 'Be helpful.', capabilities: [] as string[] };
}

test('an unchanged turn does not rebuild the skill catalog or stable prefix [AC:loop-prefix-cache#AC-1]', async () => {
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const { setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');
  const phases: string[] = [];
  setStartupPhaseEmitter((_id, event) => {
    phases.push(event.payload.phase);
  });
  try {
    const session = { id: 'prefix-same', mode: 'chat', todo: [], summary: '', metadata: { botId: 'bot-a' } };
    const store = { ...kv(), getSession: () => session };
    const builder = new PromptBuilder({
      store,
      repoRoot: '/nonexistent-repo-root-xyz',
      extraSkills: [{ id: 'sk-zebra', name: 'Zebra Routing Unique', description: 'Unique zebra routing playbook', content: 'body' }]
    });
    const ctx = { agent: agent(), session, repoRoot: '/nonexistent-repo-root-xyz' };
    const messages = [user(session.id, 'hello there')];
    const first = await builder.buildSystemPrompt(ctx, messages);
    const marked = phases.length;
    assert.ok(phases.includes('skill_catalog'));
    assert.ok(phases.includes('skill_route'));
    assert.ok(phases.includes('stable_prefix'));
    assert.ok(phases.includes('system_prompt'));
    const second = await builder.buildSystemPrompt(ctx, messages);
    assert.equal(second, first);
    assert.equal(phases.length, marked);
  } finally {
    setStartupPhaseEmitter(undefined);
  }
});

test('fast mode does not list the whole skill catalog [AC:loop-prefix-cache#AC-2]', async () => {
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const session = {
    id: 'prefix-fast',
    mode: 'chat',
    todo: [],
    summary: '',
    metadata: { taskRunMode: 'fast', botId: 'bot-fast' }
  };
  const builder = new PromptBuilder({
    store: { ...kv(), getSession: () => session },
    repoRoot: '/nonexistent-repo-root-xyz',
    extraSkills: Array.from({ length: 12 }, (_, i) => ({
      id: `bulk-${i}`,
      name: `Unrelated Bulk ${i}`,
      description: 'x'.repeat(200),
      content: 'body'
    }))
  });
  const prompt = await builder.buildSystemPrompt(
    { agent: agent(), session, repoRoot: '/nonexistent-repo-root-xyz' },
    [user(session.id, 'do it quickly')]
  );
  assert.match(prompt, /Skill disclosure \(lazy\)/);
  assert.match(prompt, /search_skills/);
  assert.equal(prompt.includes('Unrelated Bulk 0'), false);
  assert.equal(prompt.includes('Available skills:'), false);
});

test('full disclosure caps a long catalog and still lists a single skill [AC:loop-prefix-cache#AC-3]', async () => {
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const { writeSkillSettings } = await import('../src/skills/skill-settings.ts');
  const store = kv();
  writeSkillSettings(store, { disclosureMode: 'full' });
  const session = { id: 'prefix-full', mode: 'chat', todo: [], summary: '', metadata: { botId: 'bot-full' } };
  const builder = new PromptBuilder({
    store: { ...store, getSession: () => session },
    repoRoot: '/nonexistent-repo-root-xyz',
    extraSkills: [
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `long-${i}`,
        name: `Bulk Skill ${i}`,
        description: `desc-${i} ${'y'.repeat(400)}`,
        content: 'body'
      })),
      { id: 'tail', name: 'Tail Skill Omega', description: 'z'.repeat(400), content: 'body' }
    ]
  });
  const prompt = await builder.buildSystemPrompt(
    { agent: agent(), session, repoRoot: '/nonexistent-repo-root-xyz' },
    [user(session.id, 'list skills')]
  );
  assert.match(prompt, /Available skills:/);
  assert.match(prompt, /more skills are not listed/);
  assert.match(prompt, /search_skills/);
  assert.equal(prompt.includes('Tail Skill Omega'), false);

  const one = { id: 'prefix-one', mode: 'chat', todo: [], summary: '', metadata: { botId: 'bot-one' } };
  const oneStore = kv();
  writeSkillSettings(oneStore, { disclosureMode: 'full' });
  const oneBuilder = new PromptBuilder({
    store: { ...oneStore, getSession: () => one },
    repoRoot: '/nonexistent-repo-root-xyz',
    extraSkills: [{ id: 'sk-zebra', name: 'Zebra Routing Unique', description: 'Unique zebra routing playbook', content: 'body' }]
  });
  const listed = await oneBuilder.buildSystemPrompt(
    { agent: agent(), session: one, repoRoot: '/nonexistent-repo-root-xyz' },
    [user(one.id, 'list the one skill')]
  );
  assert.match(listed, /Available skills:/);
  assert.match(listed, /Zebra Routing Unique/);
});

test('a new user message routes skills again [AC:loop-prefix-cache#AC-4]', async () => {
  const { PromptBuilder } = await import('../src/model/prompt-builder.ts');
  const { setStartupPhaseEmitter } = await import('../src/observability/startup-phase.ts');
  const phases: string[] = [];
  setStartupPhaseEmitter((_id, event) => {
    phases.push(event.payload.phase);
  });
  try {
    const session = { id: 'prefix-reroute', mode: 'chat', todo: [], summary: '', metadata: { botId: 'bot-route' } };
    const builder = new PromptBuilder({
      store: { ...kv(), getSession: () => session },
      repoRoot: '/nonexistent-repo-root-xyz',
      extraSkills: [{ id: 'sk-zebra', name: 'Zebra Routing Unique', description: 'Unique zebra routing playbook for xy-test-query', content: 'body' }]
    });
    const ctx = { agent: agent(), session, repoRoot: '/nonexistent-repo-root-xyz' };
    const first = await builder.buildSystemPrompt(ctx, [user(session.id, 'hello')]);
    const marked = phases.length;
    const second = await builder.buildSystemPrompt(ctx, [user(session.id, 'please run xy-test-query')]);
    assert.notEqual(second, first);
    assert.match(second, /Zebra Routing Unique/);
    const added = phases.slice(marked);
    assert.ok(added.includes('skill_route'));
    assert.equal(added.includes('skill_catalog'), false);
  } finally {
    setStartupPhaseEmitter(undefined);
  }
});

test('an unchanged fold does not rebuild the view or memory appendix [AC:loop-prefix-cache#AC-5]', async () => {
  const { prepareTurnInput } = await import('../src/turn/prepare-turn-input.ts');
  const sessionId = 'prepare-cache-core';
  const phases: string[] = [];
  let views = 0;
  let appendices = 0;
  const session = {
    id: sessionId,
    mode: 'chat',
    todo: [],
    summary: '',
    updatedAt: '2026-10-28T00:00:00.000Z',
    metadata: {}
  };
  const folded = [user(sessionId, 'same view')];
  const deps = {
    store: {
      getSession: () => session,
      foldMessages: () => folded,
      hideByKey: () => 0,
      appendMessage: () => folded[0]
    },
    autoCompact: async () => undefined,
    claimNextStep: () => [],
    prepareView: async (_session: unknown, messages: unknown[]) => {
      views += 1;
      return messages;
    },
    buildAppendix: async () => {
      appendices += 1;
      return 'remembered';
    },
    emitTrace: (_id: string, event: { payload: { phase?: string } }) => {
      if (event.payload.phase) phases.push(event.payload.phase);
    }
  };
  await prepareTurnInput(sessionId, deps);
  await prepareTurnInput(sessionId, deps);
  assert.equal(views, 1);
  assert.equal(appendices, 1);
  assert.equal(phases.filter((phase) => phase === 'prepare_view').length, 1);
  assert.equal(phases.filter((phase) => phase === 'memory_appendix').length, 1);
  assert.equal(phases.filter((phase) => phase === 'fold_messages').length, 2);
});

test.after(() => {
  if (savedAgents === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
  else process.env.RAW_AGENT_AGENTS_SKILLS = savedAgents;
});
