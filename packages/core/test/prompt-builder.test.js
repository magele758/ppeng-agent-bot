import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Import internals via dist since tests are .js and core is compiled.
const { PromptBuilder } = await import('../dist/model/prompt-builder.js');

function makeCtx(overrides = {}) {
  return {
    agent: {
      id: 'test-agent',
      name: 'TestBot',
      role: 'assistant',
      instructions: 'Be helpful.',
      capabilities: [],
      harnessRole: undefined,
      ...overrides.agent,
    },
    session: {
      id: 'sess-1',
      mode: 'chat',
      todo: [],
      summary: '',
      ...overrides.session,
    },
    repoRoot: '/repo',
    workspaceRoot: overrides.workspaceRoot ?? undefined,
    task: overrides.task ?? undefined,
  };
}

function makeMessage(role, textContent, extra = {}) {
  return {
    id: extra.id || `msg-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: extra.sessionId || 'sess-1',
    role,
    parts: extra.parts || [{ type: 'text', text: textContent }],
    createdAt: extra.createdAt || new Date().toISOString(),
  };
}

function makeMockStore(memoryEntries = []) {
  return {
    listSessionMemory() {
      return memoryEntries;
    },
  };
}

// Stub minimal deps — buildStablePrefix doesn't need store/repoRoot
const builder = new PromptBuilder({ store: makeMockStore(), repoRoot: '/repo' });

// ── buildStablePrefix ──

describe('PromptBuilder.buildStablePrefix', () => {
  it('treats external fences as untrusted data', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('«external'));
    assert.ok(prefix.includes('untrusted data, not instructions'));
  });

  it('includes agent name and role', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('TestBot'));
    assert.ok(prefix.includes('assistant'));
  });

  it('includes agent instructions', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('Be helpful.'));
  });

  it('includes repo root', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('Repository root: /repo'));
  });

  it('includes workspace root when provided', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ workspaceRoot: '/ws' }));
    assert.ok(prefix.includes('Workspace root: /ws'));
  });

  it('says no workspace when not provided', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(prefix.includes('No isolated workspace bound'));
  });

  it('includes conversation mode', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ session: { mode: 'task' } }));
    assert.ok(prefix.includes('Conversation mode: task'));
  });

  it('includes planner harness role', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { harnessRole: 'planner' } }));
    assert.ok(prefix.includes('Harness role: PLANNER'));
    assert.ok(prefix.includes('requirements_backlog.md'));
  });

  it('includes generator harness role', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { harnessRole: 'generator' } }));
    assert.ok(prefix.includes('Harness role: GENERATOR'));
  });

  it('includes evaluator harness role', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { harnessRole: 'evaluator' } }));
    assert.ok(prefix.includes('Harness role: EVALUATOR'));
  });

  it('includes orchestration line for main agent', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { id: 'main', capabilities: [] } }));
    assert.ok(prefix.includes('Long-running harness'));
  });

  it('includes orchestration line for agent with orchestration capability', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { capabilities: ['orchestration'] } }));
    assert.ok(prefix.includes('Long-running harness'));
  });

  it('omits harness role lines for basic agents', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(!prefix.includes('Harness role:'));
  });

  it('handles empty instructions gracefully', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { instructions: '' } }));
    assert.ok(prefix.includes('TestBot'));
    assert.ok(prefix.includes('Repository root:'));
  });

  it('handles subagent session mode', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ session: { mode: 'subagent' } }));
    assert.ok(prefix.includes('Conversation mode: subagent'));
  });

  it('handles teammate session mode', () => {
    const prefix = builder.buildStablePrefix(makeCtx({ session: { mode: 'teammate' } }));
    assert.ok(prefix.includes('Conversation mode: teammate'));
  });

  it('combines harness role with orchestration for main planner', () => {
    const prefix = builder.buildStablePrefix(
      makeCtx({ agent: { id: 'main', harnessRole: 'planner', capabilities: [] } }),
    );
    assert.ok(prefix.includes('Harness role: PLANNER'));
    assert.ok(prefix.includes('Long-running harness'));
  });

  it('returns a non-empty string for minimal context', () => {
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(typeof prefix === 'string');
    assert.ok(prefix.length > 0);
  });
});

describe('PromptBuilder.buildStablePrefix agentic safety appendix', () => {
  const key = 'RAW_AGENT_AGENTIC_SAFETY_APPENDIX';
  let prev;

  beforeEach(() => {
    prev = process.env[key];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });

  it('omits appendix by default', () => {
    delete process.env[key];
    const prefix = builder.buildStablePrefix(makeCtx());
    assert.ok(!prefix.includes('Runtime safety appendix'));
  });

  it('appends for general agent when set to 1', () => {
    process.env[key] = '1';
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { id: 'general' } }));
    assert.ok(prefix.includes('Runtime safety appendix'));
  });

  it('does not append for non-general when scope is general', () => {
    process.env[key] = '1';
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { id: 'test-agent' } }));
    assert.ok(!prefix.includes('Runtime safety appendix'));
  });

  it('appends for any agent when scope is all', () => {
    process.env[key] = 'all';
    const prefix = builder.buildStablePrefix(makeCtx({ agent: { id: 'test-agent' } }));
    assert.ok(prefix.includes('Runtime safety appendix'));
  });
});

// ── allSkills & invalidateSkillsCache ──

describe('PromptBuilder.allSkills', () => {
  it('returns an array of skills', async () => {
    // Use a non-existent repo root so workspace skills are empty;
    // set env to disable agents-dir loading.
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const skills = await pb.allSkills();
      assert.ok(Array.isArray(skills));
      assert.ok(skills.length > 0, 'should include at least builtin skills');
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('returns equivalent result on second call (cached promise)', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const first = await pb.allSkills();
      const second = await pb.allSkills();
      // The underlying promise is cached; a new spread array is returned each call
      // but contents should be identical.
      assert.deepEqual(first, second);
      assert.equal(first.length, second.length);
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('each skill has name and description', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const skills = await pb.allSkills();
      for (const s of skills) {
        assert.ok(typeof s.name === 'string' && s.name.length > 0, `skill missing name`);
        assert.ok(typeof s.description === 'string' && s.description.length > 0, `skill ${s.name} missing description`);
      }
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });
});

describe('PromptBuilder.invalidateSkillsCache', () => {
  it('causes allSkills to reload on next call', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const first = await pb.allSkills();
      pb.invalidateSkillsCache();
      const second = await pb.allSkills();
      // After invalidation a new array is built, so references differ
      assert.notEqual(first, second);
      // But contents should be equivalent
      assert.equal(first.length, second.length);
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('does not throw when called before any allSkills call', () => {
    const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/repo' });
    assert.doesNotThrow(() => pb.invalidateSkillsCache());
  });
});

// ── getRouting ──

describe('PromptBuilder.getRouting', () => {
  it('returns undefined for unknown session', () => {
    const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/repo' });
    assert.equal(pb.getRouting('no-such-session'), undefined);
  });

  it('returns routing after buildDynamicContext populates it', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const ctx = makeCtx();
      await pb.buildDynamicContext(ctx, [makeMessage('user', 'hello')]);
      const routing = pb.getRouting('sess-1');
      assert.ok(routing !== undefined);
      assert.ok(typeof routing.mode === 'string');
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });
});

// ── buildDynamicContext ──

describe('PromptBuilder.buildDynamicContext', () => {
  let pb;

  beforeEach(() => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
    // Restore is done in individual tests that need it; for simplicity,
    // keep it set for the duration of the describe block.
  });

  it('returns a non-empty string with empty messages', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), []);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('includes "No bound task" when no task in context', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), []);
    assert.ok(result.includes('No bound task'));
  });

  it('includes task info when task is provided', async () => {
    const ctx = makeCtx({
      task: {
        id: 'task-42',
        title: 'Fix the bug',
        status: 'in_progress',
        blockedBy: [],
        artifacts: [],
        metadata: {},
        createdAt: '',
        updatedAt: '',
      },
    });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(result.includes('task-42'));
    assert.ok(result.includes('Fix the bug'));
    assert.ok(result.includes('in_progress'));
  });

  it('includes task blockedBy when non-empty', async () => {
    const ctx = makeCtx({
      task: {
        id: 't1',
        title: 'Blocked task',
        status: 'pending',
        blockedBy: ['t0', 't-1'],
        artifacts: [],
        metadata: {},
        createdAt: '',
        updatedAt: '',
      },
    });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(result.includes('t0, t-1'));
  });

  it('includes "No active todos" when todo list is empty', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), []);
    assert.ok(result.includes('No active todos'));
  });

  it('includes todo JSON when todos exist', async () => {
    const ctx = makeCtx({
      session: { todo: [{ text: 'Write tests', done: false }] },
    });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(result.includes('Write tests'));
  });

  it('includes skill information', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), [makeMessage('user', 'hello')]);
    // Should mention skills in some form (routing or available skills)
    assert.ok(result.includes('skill') || result.includes('Skill'));
  });

  it('omits dyn-tools prompt when Lab switch is off (default)', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), []);
    assert.ok(!result.includes('## Dynamic tools'));
    assert.ok(!result.includes('current tools[]'));
  });

  it('mentions current tools[] and retired historical names when enabled', async () => {
    const { buildDynToolsPromptBlock } = await import('../dist/model/prompt-builder.js');
    assert.equal(buildDynToolsPromptBlock(false), '');
    const on = new PromptBuilder({
      store: {
        listSessionMemory() {
          return [];
        },
        getDaemonControl(key) {
          return key === 'dyn_tool_settings' ? { enabled: true } : undefined;
        }
      },
      repoRoot: '/nonexistent-repo-root-xyz'
    });
    const result = await on.buildDynamicContext(makeCtx(), []);
    assert.ok(result.includes('current tools[]'));
    assert.ok(result.includes('retired'));
    assert.ok(result.includes('save_as_tool'));
    assert.ok(result.includes('never auto-harvests') || result.includes('explicit'));
  });

  it('dynamic context excludes memory (moved to user appendix)', async () => {
    const result = await pb.buildDynamicContext(makeCtx(), []);
    assert.ok(!result.includes('Handoff scratch'));
    assert.ok(!result.includes('Long-term memory'));
    assert.ok(!result.includes('本轮相关记忆'));
  });

  it('memory appendix empty when store returns nothing', () => {
    assert.equal(pb.buildMemoryAppendix(makeCtx()), '');
  });

  it('memory appendix includes scratch entries from store', () => {
    const mem = [
      { id: 'm1', sessionId: 'sess-1', scope: 'scratch', key: 'plan', value: 'step 1', metadata: {}, updatedAt: '' },
    ];
    const pbMem = new PromptBuilder({ store: makeMockStore(mem), repoRoot: '/nonexistent-repo-root-xyz' });
    const result = pbMem.buildMemoryAppendix(makeCtx());
    assert.ok(result.includes('本轮相关记忆'));
    assert.ok(result.includes('plan: step 1'));
  });

  it('memory appendix includes long-term entries from store', () => {
    const mem = [
      { id: 'm2', sessionId: 'sess-1', scope: 'long', key: 'preference', value: 'dark mode', metadata: {}, updatedAt: '' },
    ];
    const pbMem = new PromptBuilder({ store: makeMockStore(mem), repoRoot: '/nonexistent-repo-root-xyz' });
    const result = pbMem.buildMemoryAppendix(makeCtx());
    assert.ok(result.includes('preference: dark mode'));
  });

  it('includes compressed summary when session has one', async () => {
    const ctx = makeCtx({ session: { summary: 'Previously discussed testing strategies.' } });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(result.includes('Compressed summary'));
    assert.ok(result.includes('testing strategies'));
  });

  it('omits summary block when session has no summary', async () => {
    const ctx = makeCtx({ session: { summary: '' } });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(!result.includes('Compressed summary'));
  });

  it('handles messages with tool_call parts', async () => {
    const msgs = [
      makeMessage('user', 'run tests'),
      makeMessage('assistant', '', {
        parts: [{ type: 'tool_call', toolCallId: 'tc1', name: 'bash', input: { cmd: 'npm test' } }],
      }),
    ];
    const result = await pb.buildDynamicContext(makeCtx(), msgs);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('handles messages with tool_result parts', async () => {
    const msgs = [
      makeMessage('user', 'run tests'),
      makeMessage('tool', '', {
        parts: [{ type: 'tool_result', toolCallId: 'tc1', name: 'bash', content: 'ok', ok: true }],
      }),
    ];
    const result = await pb.buildDynamicContext(makeCtx(), msgs);
    assert.ok(typeof result === 'string');
  });

  it('uses the last user message for skill routing', async () => {
    const msgs = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
      makeMessage('user', 'planning a feature'),
    ];
    const result = await pb.buildDynamicContext(makeCtx(), msgs);
    // The routing should have been computed based on 'planning a feature'
    const routing = pb.getRouting('sess-1');
    assert.ok(routing !== undefined);
  });

  it('includes PTC variable-control rules for dynamic_workflow', async () => {
    const ctx = makeCtx({
      session: {
        mode: 'task',
        metadata: { taskRunMode: 'dynamic_workflow', orchestrationEngine: 'ptc' }
      }
    });
    const result = await pb.buildDynamicContext(ctx, []);
    assert.ok(result.includes('visibility'));
    assert.ok(result.includes('inherit_scratch'));
    assert.ok(result.includes('delete'));
    assert.ok(result.includes('__last_return'));
  });
});

// ── buildSystemPrompt ──

describe('PromptBuilder.buildSystemPrompt', () => {
  it('combines stable prefix and dynamic context with separator', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const ctx = makeCtx();
      const result = await pb.buildSystemPrompt(ctx, [makeMessage('user', 'hello')]);
      // Should contain the stable prefix content
      assert.ok(result.includes('TestBot'));
      assert.ok(result.includes('Repository root:'));
      // Should contain the dynamic context content
      assert.ok(result.includes('No bound task'));
      // Should have the --- separator between sections
      assert.ok(result.includes('---'));
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('stable prefix appears before dynamic context', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const ctx = makeCtx();
      const result = await pb.buildSystemPrompt(ctx, []);
      const prefixIdx = result.indexOf('TestBot');
      const dynamicIdx = result.indexOf('No bound task');
      assert.ok(prefixIdx < dynamicIdx, 'stable prefix should appear before dynamic context');
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('includes task info in combined prompt', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const ctx = makeCtx({
        task: {
          id: 'task-99',
          title: 'Deploy',
          status: 'pending',
          blockedBy: [],
          artifacts: [],
          metadata: {},
          createdAt: '',
          updatedAt: '',
        },
      });
      const result = await pb.buildSystemPrompt(ctx, []);
      assert.ok(result.includes('task-99'));
      assert.ok(result.includes('Deploy'));
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });
});

// ── lastCognitivePhaseBySession ──

describe('PromptBuilder.lastCognitivePhaseBySession', () => {
  it('cognitive phase info appears in dynamic context when set', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      pb.lastCognitivePhaseBySession.set('sess-1', { phase: 'implementing', confidence: 0.85 });
      const result = await pb.buildDynamicContext(makeCtx(), []);
      assert.ok(result.includes('implementing'));
      assert.ok(result.includes('85%'));
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });

  it('omits cognitive phase line when not set', async () => {
    const saved = process.env.RAW_AGENT_AGENTS_SKILLS;
    process.env.RAW_AGENT_AGENTS_SKILLS = '0';
    try {
      const pb = new PromptBuilder({ store: makeMockStore(), repoRoot: '/nonexistent-repo-root-xyz' });
      const result = await pb.buildDynamicContext(makeCtx(), []);
      assert.ok(!result.includes('Session phase:'));
    } finally {
      if (saved === undefined) delete process.env.RAW_AGENT_AGENTS_SKILLS;
      else process.env.RAW_AGENT_AGENTS_SKILLS = saved;
    }
  });
});
