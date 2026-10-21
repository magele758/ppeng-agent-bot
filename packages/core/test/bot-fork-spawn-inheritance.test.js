import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { spawnSubagentOutcome } from '../dist/runtime/spawn-host.js';
import { resolveSkillLoad, resolveSkillSearch } from '../dist/runtime/skill-load.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';
import { resolveEffectiveWorkspace } from '../dist/workspace/effective.js';
import { SUBAGENT_DENIED_TOOLS } from '../dist/runtime/subagent-policy.js';
import { settleRuns, waitFor } from './helpers/settle.js';

const PARENT_SKILL = 'fork-inherit-parent-playbook';
const EXTRA_SKILL = 'fork-inherit-extra-public';
const PRIVATE_SKILL = 'fork-inherit-private-ledger';
const PARENT_SKILL_BODY = 'PARENT-SKILL-BODY-fork-inherit';
const EXTRA_SKILL_BODY = 'EXTRA-SKILL-BODY-fork-inherit';
const PRIVATE_SKILL_BODY = 'PRIVATE-SKILL-BODY-fork-inherit';
const PARENT_CHAT = 'UNIQUE-PARENT-CHAT-fork-inherit';
const FORK_TASK = 'read the parent file for the fork';
const DELEGATED_TASK = 'delegated task only';
const STEER_TASK = 'steered task only';
const ATTACHMENT_BODY = 'ATTACHMENT-BODY-fork-inherit';
const PARENT_FILE = 'PARENT-FILE-MARK-fork-inherit';
const OTHER_FILE = 'OTHER-BOT-SECRET-fork-inherit';
const REPO_FILE = 'REPO-ONLY-MARK-fork-inherit';
const ALLOWED_TOOLS = [
  'read_file',
  'load_skill',
  'search_skills',
  'web_fetch',
  'memory_set',
  'send_message',
  'cron_create',
  'ask_user'
];

function skillFile(dir, name, body, ownerBotId) {
  const folder = join(dir, 'skills', name);
  mkdirSync(folder, { recursive: true });
  const owner = ownerBotId ? `owner-bot: ${ownerBotId}\n` : '';
  writeFileSync(
    join(folder, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} reference\n${owner}---\n${body}\n`
  );
}

function imageAsset(id, sessionId) {
  const now = new Date().toISOString();
  return {
    id,
    sessionId,
    sha256: `sha-${id}`,
    mimeType: 'image/png',
    sourceType: 'upload',
    localRelPath: `images/${id}.png`,
    sizeBytes: 8,
    derivedFromIds: [],
    retentionTier: 'hot',
    kind: 'original',
    lastAccessAt: now,
    createdAt: now
  };
}

function openingText(store, sessionId) {
  return store
    .foldMessages(sessionId)
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text))
    .join('\n');
}

function contextSources(store, sessionId) {
  return store.foldMessages(sessionId).flatMap((message) =>
    message.parts.flatMap((part) => (part.type === 'text' ? part.contextSources ?? [] : []))
  );
}

function imageParts(store, sessionId) {
  return store.foldMessages(sessionId).flatMap((message) => message.parts.filter((part) => part.type === 'image'));
}

async function openForkParent() {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'fork-repo-')));
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'fork-state-')));
  const parentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'fork-parent-ws-')));
  const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'fork-other-ws-')));
  writeFileSync(join(repoRoot, 'REPO-ONLY.txt'), REPO_FILE);
  writeFileSync(join(parentRoot, 'parent-note.txt'), PARENT_FILE);
  writeFileSync(join(otherRoot, 'other-secret.txt'), OTHER_FILE);
  const release = { current: () => {} };
  const gate = {};
  gate.promise = new Promise((resolve) => {
    release.current = resolve;
  });
  const parentId = { current: '' };
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'fork-hold',
      async runTurn(input) {
        if (input.sessionId === parentId.current) await gate.promise;
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const parentBot = runtime.createBot({ name: 'ForkParent' });
  const otherBot = runtime.createBot({ name: 'ForkOther' });
  skillFile(stateDir, PARENT_SKILL, PARENT_SKILL_BODY, parentBot.id);
  skillFile(stateDir, EXTRA_SKILL, EXTRA_SKILL_BODY);
  skillFile(stateDir, PRIVATE_SKILL, PRIVATE_SKILL_BODY, otherBot.id);
  const project = runtime.store.projects().create({
    name: 'parent-project',
    roots: [{ path: parentRoot, alias: 'parent', primary: true }]
  });
  runtime.store.projects().create({
    name: 'other-project',
    roots: [{ path: otherRoot, alias: 'other', primary: true }]
  });
  const session = runtime.getSession(runtime.openBot(parentBot.id).sessionId);
  parentId.current = session.id;
  const parentAssetId = 'img-parent-fork';
  const foreignAssetId = 'img-other-fork';
  runtime.store.createImageAsset(imageAsset(parentAssetId, session.id));
  const otherSession = runtime.store.createSession({
    title: 'other',
    mode: 'chat',
    agentId: otherBot.id,
    metadata: { botId: otherBot.id, canonicalBotChat: true }
  });
  runtime.store.createImageAsset(imageAsset(foreignAssetId, otherSession.id));
  runtime.mergeSessionMetadata(session.id, {
    userId: 'fork-user',
    permissionMode: 'bypass',
    allowedTools: ALLOWED_TOOLS,
    skillScope: 'requested',
    requestedSkills: [PARENT_SKILL],
    enabledOptionalToolGroups: [],
    workspaceBinding: { kind: 'project', projectId: project.id },
    workspaceBindingBound: true
  });
  runtime.sendUserMessage(session.id, PARENT_CHAT, { autoRun: true });
  runtime.sendUserMessage(session.id, FORK_TASK, {
    autoRun: true,
    imageAssetIds: [parentAssetId, foreignAssetId],
    contextSources: [{ kind: 'file', name: 'brief.txt', text: ATTACHMENT_BODY }]
  });
  const running = runtime.runHumanSession(session.id);
  const concurrent = await waitFor(() => {
    const child = runtime
      .listSessions()
      .find((item) => item.parentSessionId === session.id && item.metadata?.spawnSource === 'concurrent-bot-work');
    return child ?? null;
  });
  assert.ok(concurrent, 'concurrent child was not spawned');
  const steered = runtime.startSteeringSubagent(session.id, STEER_TASK, undefined, undefined, [
    { type: 'text', text: `«external source=attachment label=brief.txt»\n${ATTACHMENT_BODY}\n«end external»`, contextSources: [{ kind: 'file', name: 'brief.txt', text: ATTACHMENT_BODY }] },
    { type: 'image', assetId: parentAssetId, mimeType: 'image/png' },
    { type: 'image', assetId: foreignAssetId, mimeType: 'image/png' }
  ]);
  const steering = runtime.getSession(steered.sessionId);
  const parent = runtime.getSession(session.id);
  await spawnSubagentOutcome(
    {
      store: runtime.store,
      repoRoot: runtime.repoRoot,
      stateDir: runtime.stateDir,
      workspaceManager: runtime.workspaceManager,
      sandbox: undefined,
      setSandbox() {},
      backgroundJobAborts: new Map(),
      async runSession(id) {
        return runtime.store.getSession(id);
      }
    },
    {
      repoRoot: runtime.repoRoot,
      stateDir: runtime.stateDir,
      session: parent,
      agent: runtime.store.getAgent(parent.agentId)
    },
    DELEGATED_TASK
  );
  const delegated = runtime
    .listSessions()
    .find((item) => item.parentSessionId === session.id && openingText(runtime.store, item.id).includes(DELEGATED_TASK));
  assert.ok(delegated, 'delegated child was not spawned');
  return {
    runtime,
    session,
    concurrent,
    steering,
    delegated,
    parentAssetId,
    foreignAssetId,
    otherRoot,
    repoFile: realpathSync(join(repoRoot, 'REPO-ONLY.txt')),
    otherFile: realpathSync(join(otherRoot, 'other-secret.txt')),
    async finish() {
      release.current();
      await running.catch(() => undefined);
      await settleRuns(runtime);
      await runtime.destroy();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(parentRoot, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    }
  };
}

function children(fx) {
  return [fx.concurrent, fx.steering, fx.delegated];
}

test('forked children load the parent skill on demand and cannot see a private skill [AC:bot-fork-retrievable-inheritance#AC-3]', async () => {
  const fx = await openForkParent();
  try {
    const host = { promptBuilder: fx.runtime.promptBuilder, emitTrace() {} };
    for (const child of children(fx)) {
      const fresh = fx.runtime.getSession(child.id);
      assert.equal(fresh.metadata.skillScope, 'requested');
      assert.deepEqual(fresh.metadata.requestedSkills, [PARENT_SKILL]);
      assert.equal(fresh.metadata.botId, fx.session.metadata.botId);
      const text = openingText(fx.runtime.store, child.id);
      assert.equal(text.includes(PARENT_SKILL_BODY), false);
      assert.equal(text.includes(EXTRA_SKILL_BODY), false);
      assert.equal(text.includes(PRIVATE_SKILL_BODY), false);
      assert.equal(text.includes(PARENT_CHAT), false);
      const dynamic = await fx.runtime.promptBuilder.buildDynamicContext(
        {
          session: fresh,
          agent: fx.runtime.store.getAgent(fresh.agentId),
          repoRoot: fx.runtime.repoRoot
        },
        fx.runtime.store.foldMessages(child.id)
      );
      assert.equal(dynamic.includes(EXTRA_SKILL_BODY), false);
      assert.equal(dynamic.includes(PRIVATE_SKILL_BODY), false);
      assert.equal(dynamic.includes(PARENT_SKILL_BODY) && dynamic.includes(EXTRA_SKILL_BODY), false);
      const found = JSON.parse((await resolveSkillSearch(host, PARENT_SKILL, child.id)).content);
      assert.equal(found.hits.some((hit) => hit.name === PARENT_SKILL), true);
      const extra = JSON.parse((await resolveSkillSearch(host, EXTRA_SKILL, child.id)).content);
      assert.equal(extra.hits.some((hit) => hit.name === EXTRA_SKILL), false);
      const hidden = JSON.parse((await resolveSkillSearch(host, PRIVATE_SKILL, child.id)).content);
      assert.equal(hidden.hits.some((hit) => hit.name === PRIVATE_SKILL), false);
      assert.match((await resolveSkillLoad(host, PARENT_SKILL, child.id)).content, new RegExp(PARENT_SKILL_BODY));
      assert.ok((await resolveSkillLoad(host, EXTRA_SKILL, child.id)).error);
      assert.ok((await resolveSkillLoad(host, PRIVATE_SKILL, child.id)).error);
    }
  } finally {
    await fx.finish();
  }
});

test('three fork paths read the parent file and keep attachment references [AC:bot-fork-retrievable-inheritance#AC-4]', async () => {
  const fx = await openForkParent();
  try {
    const readFile = fx.runtime.tools.find((tool) => tool.name === 'read_file');
    for (const child of children(fx)) {
      const fresh = fx.runtime.getSession(child.id);
      const parent = fx.runtime.getSession(fx.session.id);
      assert.deepEqual(fresh.metadata.workspaceBinding, parent.metadata.workspaceBinding);
      assert.equal(fresh.metadata.workspaceBindingBound, true);
      const text = openingText(fx.runtime.store, child.id);
      assert.equal(text.includes(ATTACHMENT_BODY), false);
      assert.equal(text.includes(PARENT_CHAT), false);
      assert.equal(text.includes(PARENT_FILE), false);
      const sources = contextSources(fx.runtime.store, child.id);
      assert.equal(sources.some((source) => source.kind === 'file' && source.name === 'brief.txt' && source.text.includes(ATTACHMENT_BODY)), true);
      const images = imageParts(fx.runtime.store, child.id);
      assert.equal(images.some((part) => part.assetId === fx.foreignAssetId), false);
      const inherited = images.some((part) => {
        const asset = fx.runtime.store.getImageAsset(part.assetId);
        return asset?.sessionId === child.id && asset.derivedFromIds.includes(fx.parentAssetId);
      });
      assert.equal(inherited, true);
      const effective = await resolveEffectiveWorkspace({
        store: fx.runtime.store,
        session: fresh,
        repoRoot: fx.runtime.repoRoot,
        stateDir: fx.runtime.stateDir
      });
      assert.equal(effective.kind, 'project');
      assert.notEqual(effective.workspaceRoot, fx.runtime.repoRoot);
      const ctx = {
        repoRoot: fx.runtime.repoRoot,
        stateDir: fx.runtime.stateDir,
        session: fresh,
        agent: fx.runtime.store.getAgent(fresh.agentId),
        workspaceRoot: effective.workspaceRoot,
        workspaceRoots: effective.workspaceRoots
      };
      const parentFile = await readFile.execute(ctx, { path: 'parent-note.txt' });
      assert.equal(parentFile.ok, true);
      assert.match(parentFile.content, new RegExp(PARENT_FILE));
      await assert.rejects(() => readFile.execute(ctx, { path: fx.otherFile }), /escapes workspace/);
      await assert.rejects(() => readFile.execute(ctx, { path: fx.repoFile }), /escapes workspace/);
    }
  } finally {
    await fx.finish();
  }
});

test('forked children cannot use tools skills or files outside the parent bot [AC:bot-fork-retrievable-inheritance#AC-7]', async () => {
  const fx = await openForkParent();
  try {
    const host = { promptBuilder: fx.runtime.promptBuilder, emitTrace() {} };
    const readFile = fx.runtime.tools.find((tool) => tool.name === 'read_file');
    const catalog = [...ALLOWED_TOOLS, 'bash', 'memory_delete', 'cron_run_now'].map((name) => ({
      name,
      description: name,
      inputSchema: {},
      approvalMode: 'never',
      sideEffectLevel: 'none',
      execute: async () => ({ ok: true, content: '' })
    }));
    for (const child of children(fx)) {
      const fresh = fx.runtime.getSession(child.id);
      assert.equal(fresh.mode, 'subagent');
      assert.deepEqual(fresh.metadata.enabledOptionalToolGroups, []);
      assert.deepEqual(fresh.metadata.allowedTools, ALLOWED_TOOLS);
      assert.equal(fresh.metadata.permissionMode, 'bypass');
      assert.equal(fresh.metadata.userId, 'fork-user');
      const names = filterToolsForSession({
        env: { RAW_AGENT_OPTIONAL_TOOL_GROUPS: '1' },
        tools: catalog,
        agent: { id: fresh.agentId, name: 'bot', role: 'bot', instructions: '', capabilities: [] },
        session: fresh
      }).tools.map((tool) => tool.name);
      assert.deepEqual(names.sort(), ['load_skill', 'read_file', 'search_skills']);
      for (const denied of SUBAGENT_DENIED_TOOLS) assert.equal(names.includes(denied), false);
      assert.equal(names.includes('bash'), false);
      assert.equal(names.includes('web_fetch'), false);
      assert.match((await resolveSkillLoad(host, PARENT_SKILL, child.id)).content, new RegExp(PARENT_SKILL_BODY));
      assert.ok((await resolveSkillLoad(host, PRIVATE_SKILL, child.id)).error);
      assert.ok((await resolveSkillLoad(host, EXTRA_SKILL, child.id)).error);
      const effective = await resolveEffectiveWorkspace({
        store: fx.runtime.store,
        session: fresh,
        repoRoot: fx.runtime.repoRoot,
        stateDir: fx.runtime.stateDir
      });
      const ctx = {
        repoRoot: fx.runtime.repoRoot,
        stateDir: fx.runtime.stateDir,
        session: fresh,
        agent: fx.runtime.store.getAgent(fresh.agentId),
        workspaceRoot: effective.workspaceRoot,
        workspaceRoots: effective.workspaceRoots
      };
      const parentFile = await readFile.execute(ctx, { path: 'parent-note.txt' });
      assert.match(parentFile.content, new RegExp(PARENT_FILE));
      await assert.rejects(() => readFile.execute(ctx, { path: fx.otherFile }), /escapes workspace/);
      await assert.rejects(() => readFile.execute(ctx, { path: fx.repoFile }), /escapes workspace/);
    }
  } finally {
    await fx.finish();
  }
});
