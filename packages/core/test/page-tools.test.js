import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { createDurablePagePort } from '../dist/library/index.js';
import { createPageTools } from '../dist/tools/page-tools.js';
import { assembleOptionalTools } from '../dist/runtime/tool-assembly.js';
import { filterToolsForSession } from '../dist/turn/resolve-turn-tools.js';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'page-tools-'));
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const tools = createPageTools({ getPagePort: () => createDurablePagePort(store) });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return {
    dir,
    store,
    byName,
    ctx: {},
    close() {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('write_page 返回 id、第 1 版和分享路径，空标题或空正文不落库 [AC:page-tools#AC-1]', async () => {
  const h = harness();
  try {
    assert.deepEqual(Object.keys(h.byName).sort(), ['edit_page', 'get_page', 'list_pages', 'write_page']);
    const written = await h.byName.write_page.execute(h.ctx, { title: '  发布说明  ', markdown: '# 你好' });
    assert.equal(written.ok, true);
    const page = JSON.parse(written.content);
    assert.match(page.id, /^page_/);
    assert.equal(page.revision, 1);
    assert.match(page.sharePath, /^\/pages\/share_/);
    assert.equal(written.content.includes('# 你好'), false);

    for (const title of ['', '   ']) {
      const rejected = await h.byName.write_page.execute(h.ctx, { title, markdown: '正文' });
      assert.equal(rejected.ok, false);
      assert.match(rejected.content, /title/);
    }
    const listed = JSON.parse((await h.byName.list_pages.execute(h.ctx, {})).content);
    assert.equal(listed.pages.length, 1);
    assert.equal(listed.pages[0].id, page.id);
  } finally {
    h.close();
  }
});

test('edit 后版本加一、分享路径不变，列表无正文，get 读回新正文 [AC:page-tools#AC-2]', async () => {
  const h = harness();
  try {
    const created = JSON.parse((await h.byName.write_page.execute(h.ctx, { title: '笔记', markdown: '第一版' })).content);
    const edited = await h.byName.edit_page.execute(h.ctx, { id: created.id, markdown: '第二版' });
    assert.equal(edited.ok, true);
    const next = JSON.parse(edited.content);
    assert.equal(next.revision, 2);
    assert.equal(next.sharePath, created.sharePath);
    assert.equal(next.title, '笔记');
    assert.equal(edited.content.includes('第二版'), false);

    const listed = JSON.parse((await h.byName.list_pages.execute(h.ctx, {})).content);
    assert.equal(listed.pages.length, 1);
    const summary = listed.pages[0];
    assert.equal(summary.id, created.id);
    assert.equal(summary.title, '笔记');
    assert.equal(summary.revision, 2);
    assert.equal(summary.sharePath, created.sharePath);
    assert.ok(summary.shareId);
    assert.equal('markdown' in summary, false);
    assert.equal(JSON.stringify(listed).includes('第二版'), false);

    const got = JSON.parse((await h.byName.get_page.execute(h.ctx, { id: created.id })).content);
    assert.equal(got.markdown, '第二版');
    assert.equal(got.revision, 2);
    assert.equal(got.sharePath, created.sharePath);
    assert.equal(got.title, '笔记');
  } finally {
    h.close();
  }
});

test('分享 id 读回同一正文，编辑不存在的页面失败且不新增 [AC:page-tools#AC-3]', async () => {
  const h = harness();
  try {
    const created = JSON.parse((await h.byName.write_page.execute(h.ctx, { title: '分享页', markdown: '只有链接能看见' })).content);
    const shareId = created.sharePath.slice('/pages/'.length);
    const shared = await h.byName.get_page.execute(h.ctx, { shareId });
    assert.equal(shared.ok, true);
    const body = JSON.parse(shared.content);
    assert.equal(body.id, created.id);
    assert.equal(body.markdown, '只有链接能看见');
    assert.equal(body.sharePath, created.sharePath);

    const missing = await h.byName.edit_page.execute(h.ctx, { id: 'page_missing', markdown: 'nope' });
    assert.equal(missing.ok, false);
    assert.match(missing.content, /not found/);
    const neither = await h.byName.get_page.execute(h.ctx, {});
    assert.equal(neither.ok, false);
    const listed = JSON.parse((await h.byName.list_pages.execute(h.ctx, {})).content);
    assert.deepEqual(listed.pages.map((page) => page.id), [created.id]);
  } finally {
    h.close();
  }
});

test('page tools are on the same assembly path as vault tools and reach a turn [AC:page-tools#AC-1] [AC:page-tools#AC-2]', async () => {
  const h = harness();
  try {
    const assembled = assembleOptionalTools({
      env: { RAW_AGENT_DISCOVERY: '0' },
      store: h.store,
      stateDir: h.dir,
      getUserVault() { throw new Error('vault not used'); },
      getCronStore() { throw new Error('cron not used'); }
    });
    const pageNames = new Set(['list_pages', 'get_page', 'write_page', 'edit_page']);
    const names = assembled.filter((tool) => pageNames.has(tool.name)).map((tool) => tool.name);
    assert.deepEqual(names.sort(), ['edit_page', 'get_page', 'list_pages', 'write_page']);

    h.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
    const agent = { id: 'general', name: 'General' };
    const session = h.store.createSession({ title: 'pages', mode: 'chat', agentId: agent.id, background: false });
    const visible = filterToolsForSession({
      env: {},
      tools: assembled,
      agent,
      session: h.store.getSession(session.id),
      settingsStore: h.store
    }).tools.map((tool) => tool.name);
    for (const name of ['list_pages', 'get_page', 'write_page', 'edit_page']) assert.ok(visible.includes(name), name);

    const write = assembled.find((tool) => tool.name === 'write_page');
    const created = JSON.parse((await write.execute({}, { title: '回路', markdown: '从组装进来的' })).content);
    const list = assembled.find((tool) => tool.name === 'list_pages');
    const pages = JSON.parse((await list.execute({}, {})).content).pages;
    assert.equal(pages[0].id, created.id);
    assert.equal(pages[0].sharePath, created.sharePath);
    assert.equal(JSON.stringify(pages).includes('从组装进来的'), false);
  } finally {
    h.close();
  }
});
