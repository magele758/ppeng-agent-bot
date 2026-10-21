import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { createToolServices } from '../dist/runtime/tool-services.js';
import { createSubagentHelpTool } from '../dist/runtime/subagent-help.js';

const AGENT = { id: 'general', name: 'general', role: 'general', instructions: '', capabilities: [] };

function servicesFor(store, stateDir) {
  return createToolServices({
    store,
    stateDir,
    resolveSkillLoad: async () => ({}),
    resolveSkillSearch: async () => ({ content: '' }),
    unblockDependentTasks: async () => {},
    spawnSubagent: async () => '',
    spawnTeammate: async () => '',
    startBackgroundJob: async () => ({})
  });
}

function context(dir, session) {
  return { repoRoot: dir, stateDir: dir, workspaceRoot: dir, session, agent: AGENT };
}

function tool(tools, name) {
  const found = tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function textsOf(store, sessionId) {
  return store
    .foldMessages(sessionId)
    .flatMap((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text))
    .join('\n');
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fork-sibling-files-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const parent = store.createSession({
    title: 'parent',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'bot-parent', canonicalBotChat: true }
  });
  const childA = store.createSession({
    title: 'child-a',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id,
    metadata: { botId: 'bot-parent', parentSessionId: parent.id, spawnSource: 'concurrent-bot-work' }
  });
  const childB = store.createSession({
    title: 'child-b',
    mode: 'subagent',
    agentId: 'general',
    parentSessionId: parent.id,
    metadata: { botId: 'bot-parent', parentSessionId: parent.id, spawnSource: 'delegate' }
  });
  const other = store.createSession({
    title: 'other-bot',
    mode: 'chat',
    agentId: 'general',
    metadata: { botId: 'bot-other', canonicalBotChat: true }
  });
  writeFileSync(join(dir, 'project-readme.txt'), 'PARENT_PROJECT_FILE\n');
  mkdirSync(join(dir, 'attachments', parent.id), { recursive: true });
  mkdirSync(join(dir, 'artifacts', parent.id), { recursive: true });
  mkdirSync(join(dir, 'artifacts', other.id), { recursive: true });
  writeFileSync(join(dir, 'attachments', parent.id, 'brief.txt'), 'PARENT_ATTACHMENT_FILE\n');
  writeFileSync(join(dir, 'artifacts', parent.id, 'generated.txt'), 'PARENT_MATERIAL_FILE\n');
  writeFileSync(join(dir, 'artifacts', other.id, 'private.txt'), 'OTHER_BOT_PRIVATE_FILE\n');
  store.createAttachment({
    id: 'att-parent',
    sessionId: parent.id,
    fileName: 'brief.txt',
    mimeType: 'text/plain',
    kind: 'rawtext',
    sourceType: 'upload',
    localRelPath: `attachments/${parent.id}/brief.txt`,
    sizeBytes: 22,
    status: 'ready',
    createdAt: new Date().toISOString()
  });
  store.createArtifactIndex({
    id: 'art-parent',
    sessionId: parent.id,
    sourceTool: 'write_file',
    fileName: 'generated.txt',
    mimeType: 'text/plain',
    localRelPath: `artifacts/${parent.id}/generated.txt`,
    totalBytes: 21,
    totalChars: 21,
    pageSizeChars: 4000,
    totalPages: 1,
    createdAt: new Date().toISOString()
  });
  const tools = createBuiltinTools(servicesFor(store, dir));
  return {
    dir,
    store,
    parent,
    childA,
    childB,
    other,
    tools,
    close() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function writeSiblingSecret(box) {
  const write = tool(box.tools, 'write_file');
  const result = await write.execute(context(box.dir, box.store.getSession(box.childA.id)), {
    path: 'sibling-private/secret.txt',
    content: 'SIBLING_PRIVATE_SECRET\n'
  });
  assert.equal(result.ok, true, result.content);
}

test('sibling sub-agents cannot read or search unshared files [AC:bot-fork-retrievable-inheritance#AC-6]', async () => {
  const box = fixture();
  try {
    await writeSiblingSecret(box);
    const read = tool(box.tools, 'read_file');
    const grep = tool(box.tools, 'grep_files');
    const reader = context(box.dir, box.store.getSession(box.childB.id));
    const denied = await read.execute(reader, { path: 'sibling-private/secret.txt' });
    assert.equal(denied.ok, false);
    assert.equal(denied.content.includes('SIBLING_PRIVATE_SECRET'), false);
    const listing = await read.execute(reader, { path: 'sibling-private' });
    assert.equal(listing.content.includes('secret.txt'), false);
    assert.equal(listing.content.includes('SIBLING_PRIVATE_SECRET'), false);
    const searched = await grep.execute(reader, { pattern: 'SIBLING_PRIVATE_SECRET' });
    assert.equal(searched.content.includes('SIBLING_PRIVATE_SECRET'), false);
    const own = await read.execute(context(box.dir, box.store.getSession(box.childA.id)), {
      path: 'sibling-private/secret.txt'
    });
    assert.equal(own.ok, true);
    assert.match(own.content, /SIBLING_PRIVATE_SECRET/);
    const parentRead = await read.execute(context(box.dir, box.store.getSession(box.parent.id)), {
      path: 'sibling-private/secret.txt'
    });
    assert.equal(parentRead.ok, true);
    assert.match(parentRead.content, /SIBLING_PRIVATE_SECRET/);
  } finally {
    box.close();
  }
});

test('sub-agents can read parent files and cannot read another bot private file [AC:bot-fork-retrievable-inheritance#AC-4] [AC:bot-fork-retrievable-inheritance#AC-6]', async () => {
  const box = fixture();
  try {
    const write = tool(box.tools, 'write_file');
    const later = await write.execute(context(box.dir, box.store.getSession(box.parent.id)), {
      path: 'parent-later.txt',
      content: 'PARENT_LATER_FILE\n'
    });
    assert.equal(later.ok, true, later.content);
    const read = tool(box.tools, 'read_file');
    const grep = tool(box.tools, 'grep_files');
    const reader = context(box.dir, box.store.getSession(box.childB.id));
    const project = await read.execute(reader, { path: 'project-readme.txt' });
    assert.equal(project.ok, true);
    assert.match(project.content, /PARENT_PROJECT_FILE/);
    const attachment = await read.execute(reader, { path: `attachments/${box.parent.id}/brief.txt` });
    assert.equal(attachment.ok, true);
    assert.match(attachment.content, /PARENT_ATTACHMENT_FILE/);
    const material = await read.execute(reader, { path: `artifacts/${box.parent.id}/generated.txt` });
    assert.equal(material.ok, true);
    assert.match(material.content, /PARENT_MATERIAL_FILE/);
    const parentLater = await read.execute(reader, { path: 'parent-later.txt' });
    assert.equal(parentLater.ok, true);
    assert.match(parentLater.content, /PARENT_LATER_FILE/);
    const foreign = await read.execute(reader, { path: `artifacts/${box.other.id}/private.txt` });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.content.includes('OTHER_BOT_PRIVATE_FILE'), false);
    const foreignGrep = await grep.execute(reader, { pattern: 'OTHER_BOT_PRIVATE_FILE' });
    assert.equal(foreignGrep.content.includes('OTHER_BOT_PRIVATE_FILE'), false);
    const projectGrep = await grep.execute(reader, { pattern: 'PARENT_PROJECT_FILE' });
    assert.match(projectGrep.content, /PARENT_PROJECT_FILE/);
  } finally {
    box.close();
  }
});

test('an explicitly shared sibling file stays readable [AC:bot-fork-retrievable-inheritance#AC-6]', async () => {
  const box = fixture();
  try {
    await writeSiblingSecret(box);
    const read = tool(box.tools, 'read_file');
    const reader = () => context(box.dir, box.store.getSession(box.childB.id));
    const denied = await read.execute(reader(), { path: 'sibling-private/secret.txt' });
    assert.equal(denied.ok, false);
    assert.equal(denied.content.includes('SIBLING_PRIVATE_SECRET'), false);
    const owner = box.store.getSession(box.childA.id);
    box.store.updateSession(box.childA.id, {
      metadata: { ...owner.metadata, forkSharedFiles: ['sibling-private/secret.txt'] }
    });
    const shared = await read.execute(reader(), { path: 'sibling-private/secret.txt' });
    assert.equal(shared.ok, true);
    assert.match(shared.content, /SIBLING_PRIVATE_SECRET/);
  } finally {
    box.close();
  }
});

test('help does not open or attach a sibling private file [AC:bot-fork-retrievable-inheritance#AC-6]', async () => {
  const box = fixture();
  try {
    await writeSiblingSecret(box);
    const help = createSubagentHelpTool(box.store);
    const result = await help.execute(context(box.dir, box.store.getSession(box.childB.id)), {
      message: 'please check the step sibling-private/secret.txt',
      audience: 'both'
    });
    assert.equal(result.ok, true, result.content);
    assert.equal(result.content.includes('SIBLING_PRIVATE_SECRET'), false);
    const delivered = [box.parent.id, box.childA.id].map((id) => textsOf(box.store, id)).join('\n');
    assert.match(delivered, /please check the step/);
    assert.equal(delivered.includes('sibling-private/secret.txt'), false);
    assert.equal(delivered.includes('SIBLING_PRIVATE_SECRET'), false);
  } finally {
    box.close();
  }
});

test('file access decision is pure [AC:bot-fork-retrievable-inheritance#AC-6] [AC:bot-fork-retrievable-inheritance#AC-4]', async () => {
  const mod = await import('../dist/bots/fork-sibling-isolation.js');
  const parent = { id: 'parent', mode: 'chat', metadata: { botId: 'bot-parent' } };
  const childA = {
    id: 'child-a',
    mode: 'subagent',
    parentSessionId: 'parent',
    metadata: { botId: 'bot-parent', parentSessionId: 'parent' }
  };
  const childB = {
    id: 'child-b',
    mode: 'subagent',
    parentSessionId: 'parent',
    metadata: { botId: 'bot-parent', parentSessionId: 'parent' }
  };
  const other = { id: 'other', mode: 'chat', metadata: { botId: 'bot-other' } };
  const claim = {
    path: 'sibling-private/secret.txt',
    sessionId: 'child-a',
    parentSessionId: 'parent',
    botId: 'bot-parent',
    shared: false
  };
  const facts = {
    reader: childB,
    sessions: [parent, childA, childB, other],
    claims: [claim],
    workspaceRoot: '/work',
    stateDir: '/work',
    parentAttachmentPaths: [`attachments/${parent.id}/brief.txt`],
    parentMaterialPaths: [`artifacts/${parent.id}/generated.txt`]
  };
  assert.equal(mod.decideForkSiblingFileRead(facts, '/work/sibling-private/secret.txt').allow, false);
  assert.equal(mod.decideForkSiblingFileRead(facts, '/work/project-readme.txt').allow, true);
  assert.equal(mod.decideForkSiblingFileRead(facts, '/work/attachments/parent/brief.txt').kind, 'parent-attachment');
  assert.equal(mod.decideForkSiblingFileRead(facts, '/work/artifacts/parent/generated.txt').kind, 'parent-material');
  assert.equal(mod.decideForkSiblingFileRead(facts, '/work/artifacts/other/private.txt').kind, 'other-bot-private');
  assert.equal(mod.decideForkSiblingFileRead({ ...facts, reader: childA }, '/work/sibling-private/secret.txt').kind, 'own');
  assert.equal(mod.decideForkSiblingFileRead({ ...facts, reader: parent }, '/work/sibling-private/secret.txt').allow, true);
  const shared = mod.shareSiblingPath(facts.claims, 'sibling-private/secret.txt');
  assert.equal(mod.decideForkSiblingFileRead({ ...facts, claims: shared }, '/work/sibling-private/secret.txt').kind, 'shared');
  const redacted = mod.redactHelpMessage('please check the step sibling-private/secret.txt', [
    'sibling-private/secret.txt'
  ]);
  assert.equal(redacted.includes('sibling-private/secret.txt'), false);
  assert.match(redacted, /please check the step/);
  const visible = mod.filterGrepContent(
    'project-readme.txt:1:PARENT_PROJECT_FILE\nsibling-private/secret.txt:1:SIBLING_PRIVATE_SECRET',
    facts,
    '/work'
  );
  assert.match(visible, /PARENT_PROJECT_FILE/);
  assert.equal(visible.includes('SIBLING_PRIVATE_SECRET'), false);
});
