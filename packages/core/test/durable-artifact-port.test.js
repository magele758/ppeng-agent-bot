import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableArtifactPort } from '../dist/artifact/index.js';
import { defaultIngestionSettings } from '../dist/ingestion/settings.js';

function settings(patch = {}) {
  return { ...defaultIngestionSettings(), toolResultArchiveChars: 200, archivePreviewChars: 30, pageSizeChars: 100, ...patch };
}

function longText() {
  const sentinel = 'TAIL-SENTINEL-9f3c';
  return { sentinel, content: `HEAD-VISIBLE-${'x'.repeat(400)}${sentinel}` };
}

function withDir(fn) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dur-art-'));
  try {
    return fn(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

test('超长工具结果回到模型时只有句柄和预览 [AC:durable-artifact-port#AC-1]', () => {
  withDir((stateDir) => {
    const { sentinel, content } = longText();
    const port = createDurableArtifactPort({ stateDir, settings: settings() });
    const retained = port.retain({ sessionId: 'sess-a', source: 'bash', content });
    assert.equal(retained.mode, 'ref');
    if (retained.mode !== 'ref') return;
    assert.match(retained.text, new RegExp(retained.ref.handle));
    assert.match(retained.text, /页/);
    assert.equal(retained.text.includes(sentinel), false);
    assert.ok(retained.text.length < content.length);
    const tail = port.readPage({
      sessionId: 'sess-a',
      handle: retained.ref.handle,
      page: retained.ref.totalPages
    });
    assert.match(tail.content, /TAIL-SENTINEL-9f3c/);
  });
});

test('第一页不含后页，其他会话不能读同一句柄 [AC:durable-artifact-port#AC-2]', () => {
  withDir((stateDir) => {
    const pageSize = 1000;
    const content = `${'A'.repeat(pageSize)}${'B'.repeat(pageSize)}TAIL`;
    const port = createDurableArtifactPort({
      stateDir,
      settings: settings({ pageSizeChars: pageSize, toolResultArchiveChars: 50 })
    });
    const retained = port.retain({ sessionId: 'sess-a', source: 'bash', content });
    assert.equal(retained.mode, 'ref');
    if (retained.mode !== 'ref') return;
    const first = port.readPage({ sessionId: 'sess-a', handle: retained.ref.handle, page: 1 });
    assert.equal(first.content, 'A'.repeat(pageSize));
    assert.equal(first.hasNext, true);
    assert.equal(first.nextPage, 2);
    assert.equal(first.content.includes('B'), false);
    assert.throws(
      () => port.readPage({ sessionId: 'sess-b', handle: retained.ref.handle, page: 1 }),
      /分页内容不存在|不属于当前会话/
    );
  });
});

test('未超长或关闭归档时原文回到模型 [AC:durable-artifact-port#AC-3]', () => {
  withDir((stateDir) => {
    const exact = 'e'.repeat(200);
    const open = createDurableArtifactPort({ stateDir, settings: settings() });
    const same = open.retain({ sessionId: 'sess-a', source: 'bash', content: exact });
    assert.equal(same.mode, 'inline');
    assert.equal(same.text, exact);

    const { content } = longText();
    const closed = createDurableArtifactPort({ stateDir, settings: settings({ enabled: false }) });
    const held = closed.retain({ sessionId: 'sess-a', source: 'bash', content });
    assert.equal(held.mode, 'inline');
    assert.equal(held.text, content);
  });
});

test('重新打开同一状态目录仍能按句柄翻到原文 [AC:durable-artifact-port#AC-4]', () => {
  withDir((stateDir) => {
    const { sentinel, content } = longText();
    const first = createDurableArtifactPort({ stateDir, settings: settings() });
    const retained = first.retain({ sessionId: 'sess-a', source: 'bash', content });
    assert.equal(retained.mode, 'ref');
    if (retained.mode !== 'ref') return;
    const again = createDurableArtifactPort({ stateDir, settings: settings() });
    const page = again.readPage({
      sessionId: 'sess-a',
      handle: retained.ref.handle,
      page: retained.ref.totalPages
    });
    assert.match(page.content, new RegExp(sentinel));
  });
});

test('翻页检索和历史取回不会被再次归档 [AC:durable-artifact-port#AC-5]', () => {
  withDir((stateDir) => {
    const { content } = longText();
    const port = createDurableArtifactPort({ stateDir, settings: settings() });
    for (const source of ['read_artifact_page', 'search_artifact_content', 'retrieve_tool_result']) {
      const retained = port.retain({ sessionId: 'sess-a', source, content });
      assert.equal(retained.mode, 'inline');
      assert.equal(retained.text, content);
    }
  });
});
