import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPagedArtifact,
  maybeArchiveToolResult,
  readPagedArtifactPage,
  searchPagedArtifact
} from '../dist/artifact/index.js';

const stateDir = mkdtempSync(join(tmpdir(), 'ppeng-art-'));
after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('paged artifact', () => {
  it('pages and searches by handle', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i} token-${i % 3}`);
    const content = lines.join('\n');
    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-1',
      sourceTool: 'bash',
      content,
      pageSizeChars: 80
    });
    assert.ok(manifest.handle);
    assert.ok(manifest.totalPages >= 2);

    const page1 = readPagedArtifactPage({
      stateDir,
      sessionId: 'sess-1',
      handle: manifest.handle,
      page: 1
    });
    assert.equal(page1.page, 1);
    assert.equal(page1.hasNext, true);
    assert.match(page1.content, /line-0/);

    const found = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-1',
      handle: manifest.handle,
      query: 'token-2',
      mode: 'substring'
    });
    assert.ok(found.matches.length > 0);
    assert.ok(found.matches[0].page >= 1);
    assert.match(found.matches[0].preview, /token-2/);
  });

  it('archives oversized tool results and skips retrieve tools', () => {
    const store = {
      getDaemonControl() {
        return { enabled: true, toolResultArchiveChars: 2000, archivePreviewChars: 80, pageSizeChars: 1000 };
      },
      setDaemonControl() {}
    };
    const long = 'R'.repeat(3000);
    const archived = maybeArchiveToolResult({
      stateDir,
      sessionId: 'sess-2',
      toolName: 'bash',
      content: long,
      settingsStore: store
    });
    assert.match(archived, /Artifact Handle:/);
    assert.ok(archived.length < long.length);

    const skipped = maybeArchiveToolResult({
      stateDir,
      sessionId: 'sess-2',
      toolName: 'retrieve_tool_result',
      content: long,
      settingsStore: store
    });
    assert.equal(skipped, long);
  });

  it('searches case-insensitively and reports matches past the cap', () => {
    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      sourceTool: 'bash',
      content: 'Alpha alpha ALPHA',
      pageSizeChars: 80
    });
    const found = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: manifest.handle,
      query: 'alpha',
      maxResults: 2,
      contextChars: 10
    });
    assert.equal(found.mode, 'substring');
    assert.equal(found.totalMatchesEstimate, 3);
    assert.equal(found.hasMore, true);
    assert.equal(found.matches.length, 2);
    assert.equal(found.matches[0].preview.includes('Alpha'), true);
    assert.equal(found.matches[0].lineStart, 1);
  });

  it('caps regex context and finds a match on a later page', () => {
    const needle = 'NEEDLE';
    const content = `${'x'.repeat(1000)}${needle}${'y'.repeat(1000)}`;
    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      sourceTool: 'bash',
      content,
      pageSizeChars: 100
    });
    const found = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: manifest.handle,
      query: 'ne+dle',
      mode: 'regex',
      maxResults: 1000,
      contextChars: 1
    });
    assert.equal(found.mode, 'regex');
    assert.equal(found.matches.length, 1);
    assert.equal(found.hasMore, false);
    assert.equal(found.totalMatchesEstimate, 1);
    assert.equal(found.matches[0].page, 11);
    assert.equal(found.matches[0].startOffset, 1000);
    assert.equal(found.matches[0].endOffset, 1006);
    assert.equal(found.matches[0].preview.length, 50 + needle.length + 50);

    const wide = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: manifest.handle,
      query: 'NEEDLE',
      mode: 'regex',
      contextChars: 5000
    });
    assert.equal(wide.matches[0].preview.length, 800 + needle.length + 800);
  });

  it('stops empty regex matches and rejects an invalid pattern', () => {
    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      sourceTool: 'bash',
      content: 'aaa',
      pageSizeChars: 80
    });
    const empty = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: manifest.handle,
      query: '(?=a)',
      mode: 'regex',
      maxResults: 2
    });
    assert.equal(empty.totalMatchesEstimate, 3);
    assert.equal(empty.hasMore, true);
    assert.equal(empty.matches.length, 2);
    assert.equal(empty.matches[0].startOffset, 0);
    assert.equal(empty.matches[0].endOffset, 0);
    assert.equal(empty.matches[1].startOffset, 1);

    assert.throws(
      () => searchPagedArtifact({
        stateDir,
        sessionId: 'sess-search',
        handle: manifest.handle,
        query: '(',
        mode: 'regex'
      }),
      /无效的正则表达式/
    );
  });

  it('returns a terminal miss when the artifact is already gone', () => {
    const missing = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: 'no-such-handle',
      query: '(',
      mode: 'regex'
    });
    assert.equal(missing.gone, true);
    assert.equal(missing.terminal, true);
    assert.equal(missing.mode, 'regex');
    assert.deepEqual(missing.matches, []);
    assert.equal(missing.hasMore, false);
    assert.equal(missing.totalMatchesEstimate, 0);

    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      sourceTool: 'bash',
      content: 'still-here',
      pageSizeChars: 80
    });
    unlinkSync(join(stateDir, manifest.storageRelPath));
    const dataGone = searchPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      handle: manifest.handle,
      query: 'still'
    });
    assert.equal(dataGone.gone, true);
    assert.equal(dataGone.terminal, true);
    assert.equal(dataGone.mode, 'substring');
    assert.equal(dataGone.totalChars, 0);
  });

  it('rethrows when the manifest belongs to another session', () => {
    const manifest = createPagedArtifact({
      stateDir,
      sessionId: 'sess-search',
      sourceTool: 'bash',
      content: 'owned',
      pageSizeChars: 80
    });
    const path = join(stateDir, 'artifacts', manifest.sessionId, `${manifest.handle}.manifest.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    parsed.sessionId = 'someone-else';
    writeFileSync(path, JSON.stringify(parsed));
    assert.throws(
      () => searchPagedArtifact({
        stateDir,
        sessionId: 'sess-search',
        handle: manifest.handle,
        query: 'owned'
      }),
      /不属于当前会话/
    );
  });
});
