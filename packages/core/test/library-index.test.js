import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { SqliteStateStore } from '../dist/storage.js';
import { readIngestionSettings, writeIngestionSettings } from '../dist/ingestion/settings.js';
import { LibraryIndexWatcher, syncLibraryIndex } from '../dist/ingestion/library-index.js';
import { createMemoryTools } from '../dist/tools/memory-tools.js';
import { toolGroup } from '../dist/tools/tool-exposure.js';

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), 'libidx-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  return {
    dir,
    store,
    close() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function tools(store) {
  const memory = store.agentMemory();
  return createMemoryTools({
    async listSessionMemory() {
      return [];
    },
    async deleteSessionMemory() {
      return false;
    },
    async upsertSessionMemory() {},
    async listAgentMemory(input) {
      return memory.search(input);
    },
    async getAgentMemoryById(id) {
      return memory.getEntryById(id);
    }
  });
}

const ctx = {
  repoRoot: '/repo',
  stateDir: '/tmp',
  session: { id: 'sess-library', metadata: {}, agentId: 'general', mode: 'chat' },
  agent: { id: 'general', name: 'General', role: 'assistant', instructions: '', capabilities: [] }
};

async function search(store, query) {
  const tool = tools(store).find((item) => item.name === 'memory_search');
  const result = await tool.execute(ctx, { query });
  assert.equal(result.ok, true);
  return JSON.parse(result.content);
}

function folder(root) {
  const dir = mkdtempSync(join(root, 'notes-'));
  return realpathSync(dir);
}

test('保存的资料目录能读回，移除后文档不再被检索 [AC:knowledge-library-dirs#AC-1]', async () => {
  const env = openStore();
  const keep = folder(env.dir);
  const drop = folder(env.dir);
  writeFileSync(join(keep, 'keep.md'), 'keepquartzbeacon stays');
  writeFileSync(join(drop, 'drop.md'), 'dropquartzbeacon goes');
  try {
    const saved = writeIngestionSettings(env.store, { libraryDirs: [keep, drop] });
    assert.deepEqual(saved.libraryDirs, [keep, drop]);
    assert.deepEqual(readIngestionSettings(env.store).libraryDirs, [keep, drop]);
    syncLibraryIndex(env.store);
    assert.equal((await search(env.store, 'keepquartzbeacon')).matches.length, 1);
    assert.equal((await search(env.store, 'dropquartzbeacon')).matches.length, 1);

    const left = writeIngestionSettings(env.store, { libraryDirs: [keep] });
    assert.deepEqual(left.libraryDirs, [keep]);
    syncLibraryIndex(env.store);
    assert.equal((await search(env.store, 'dropquartzbeacon')).matches.length, 0);
    assert.equal((await search(env.store, 'keepquartzbeacon')).matches.length, 1);

    const cleared = writeIngestionSettings(env.store, { libraryDirs: [] });
    assert.deepEqual(cleared.libraryDirs, []);
    assert.deepEqual(readIngestionSettings(env.store).libraryDirs, []);
    syncLibraryIndex(env.store);
    assert.equal((await search(env.store, 'keepquartzbeacon')).matches.length, 0);
  } finally {
    env.close();
  }
});

test('对话检索能命中资料目录里的文档并读到原文 [AC:knowledge-library-dirs#AC-2]', async () => {
  const env = openStore();
  const dir = folder(env.dir);
  mkdirSync(join(dir, 'notes'));
  writeFileSync(join(dir, 'notes', 'deep.md'), 'libraryquartzbeacon lives in the folder note');
  try {
    writeIngestionSettings(env.store, { libraryDirs: [dir] });
    syncLibraryIndex(env.store);
    const group = toolGroup('memory_search');
    assert.equal(group.id, 'memory');
    assert.equal(group.tier, 1);
    const found = await search(env.store, 'libraryquartzbeacon');
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].scope, 'library');
    assert.equal(found.matches[0].key, 'notes/deep.md');
    assert.equal(found.matches[0].excerpt.includes('libraryquartzbeacon'), true);
    const read = tools(env.store).find((item) => item.name === 'memory_read');
    const page = await read.execute(ctx, { ref: found.matches[0].ref });
    assert.equal(page.ok, true);
    assert.equal(JSON.parse(page.content).text.includes('libraryquartzbeacon lives in the folder note'), true);
  } finally {
    env.close();
  }
});

test('目录里的文件修改或删除后检索跟上，不必改环境变量 [AC:knowledge-library-dirs#AC-3]', async (t) => {
  const env = openStore();
  const dir = folder(env.dir);
  const file = join(dir, 'live.md');
  writeFileSync(file, 'oldquartzbeacon before');
  const watcher = new LibraryIndexWatcher(env.store, { debounceMs: 40 });
  t.after(() => watcher.stop());
  try {
    writeIngestionSettings(env.store, { libraryDirs: [dir] });
    watcher.start();
    assert.equal((await search(env.store, 'oldquartzbeacon')).matches.length, 1);

    writeFileSync(file, 'newquartzbeacon after the edit');
    await waitFor(async () => (await search(env.store, 'newquartzbeacon')).matches.length === 1);
    assert.equal((await search(env.store, 'oldquartzbeacon')).matches.length, 0);

    unlinkSync(file);
    await waitFor(async () => (await search(env.store, 'newquartzbeacon')).matches.length === 0);
    assert.equal(process.env.RAW_AGENT_LIBRARY_DIRS, undefined);
  } finally {
    watcher.stop();
    env.close();
  }
});

test('密钥文件、未添加目录和禁止访问的路径不会进入检索 [AC:knowledge-library-dirs#AC-4]', async () => {
  const env = openStore();
  const home = mkdtempSync(join(env.dir, 'home-'));
  const dir = folder(env.dir);
  const other = folder(env.dir);
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.ssh', 'secret.md'), 'sshquartzbeacon hidden');
  writeFileSync(join(dir, '.env'), 'envquartzbeacon secret');
  writeFileSync(join(dir, 'id_rsa'), 'rsaquartzbeacon secret');
  writeFileSync(join(dir, 'credentials'), 'credquartzbeacon secret');
  writeFileSync(join(dir, 'ok.md'), 'okquartzbeacon visible');
  writeFileSync(join(other, 'outside.md'), 'outsidequartzbeacon hidden');
  symlinkSync(join(home, '.ssh', 'secret.md'), join(dir, 'linked.md'));
  try {
    assert.throws(() => writeIngestionSettings(env.store, { libraryDirs: [join(home, '.ssh')] }, home), /not allowed/);
    writeIngestionSettings(env.store, { libraryDirs: [dir] }, home);
    assert.deepEqual(readIngestionSettings(env.store).libraryDirs, [dir]);
    syncLibraryIndex(env.store, { home });
    assert.equal((await search(env.store, 'okquartzbeacon')).matches.length, 1);
    for (const token of ['envquartzbeacon', 'rsaquartzbeacon', 'credquartzbeacon', 'outsidequartzbeacon', 'sshquartzbeacon']) {
      assert.equal((await search(env.store, token)).matches.length, 0, token);
    }
  } finally {
    env.close();
  }
});

test('library symlinks index canonical in-root documents once and tolerate cycles and dangling links [AC:knowledge-library-dirs#AC-2] [AC:knowledge-library-dirs#AC-4]', async () => {
  const env = openStore();
  const dir = folder(env.dir);
  const nested = join(dir, 'notes');
  mkdirSync(nested);
  writeFileSync(join(nested, 'document.md'), 'symlinkquartzbeacon visible');
  symlinkSync(join(nested, 'document.md'), join(dir, 'file-alias.md'));
  symlinkSync(nested, join(dir, 'directory-alias'));
  symlinkSync(dir, join(nested, 'cycle'));
  symlinkSync(join(dir, 'missing.md'), join(dir, 'dangling.md'));
  const outside = join(env.dir, 'outside.md');
  writeFileSync(outside, 'outsidelinkquartzbeacon hidden');
  symlinkSync(outside, join(dir, 'outside-link.md'));
  try {
    writeIngestionSettings(env.store, { libraryDirs: [dir] });
    syncLibraryIndex(env.store);
    const found = await search(env.store, 'symlinkquartzbeacon');
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].key, 'notes/document.md');
    assert.equal((await search(env.store, 'outsidelinkquartzbeacon')).matches.length, 0);
    unlinkSync(join(nested, 'document.md'));
    syncLibraryIndex(env.store);
    assert.equal((await search(env.store, 'symlinkquartzbeacon')).matches.length, 0);
  } finally {
    env.close();
  }
});

async function waitFor(predicate) {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail('library index did not follow the folder change');
}
