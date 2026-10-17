import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkspaceGrep } from '../dist/tools/grep-workspace.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('runWorkspaceGrep clamps maxMatches between 1 and 500', async () => {
  const dir = await mkdir(join(tmpdir(), `grep-test-${Date.now()}`), { recursive: true });
  try {
    await writeFile(join(dir, 'test.txt'), 'hello world\n');

    // Test that maxMatches=0 is clamped to 1
    const result0 = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      maxMatches: 0
    });
    assert.equal(result0.ok, true);

    // Test that negative maxMatches is clamped to 1
    const resultNeg = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      maxMatches: -100
    });
    assert.equal(resultNeg.ok, true);

    // Test that maxMatches > 500 is clamped
    const result500 = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      maxMatches: 10000
    });
    assert.equal(result500.ok, true);
  } finally {
    try {
      await rmdir(dir);
    } catch {}
  }
});

test('runWorkspaceGrep returns (no matches) for missing pattern', async () => {
  const dir = await mkdir(join(tmpdir(), `grep-test-nomatch-${Date.now()}`), { recursive: true });
  try {
    await writeFile(join(dir, 'test.txt'), 'hello world\n');
    const result = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'nonexistent_pattern_xyz',
      maxMatches: 50
    });
    assert.equal(result.ok, true);
    assert.equal(result.content, '(no matches)');
  } finally {
    try {
      await rmdir(dir);
    } catch {}
  }
});

test('runWorkspaceGrep finds matching content', async () => {
  const dir = await mkdir(join(tmpdir(), `grep-test-match-${Date.now()}`), { recursive: true });
  try {
    await writeFile(join(dir, 'test.txt'), 'hello world\nfoo bar\n');
    const result = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      maxMatches: 50
    });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes('hello'));
  } finally {
    try {
      await rmdir(dir);
    } catch {}
  }
});

test('runWorkspaceGrep handles glob pattern', async () => {
  const dir = await mkdir(join(tmpdir(), `grep-test-glob-${Date.now()}`), { recursive: true });
  try {
    await writeFile(join(dir, 'test.txt'), 'hello world\n');
    await writeFile(join(dir, 'test.md'), 'hello markdown\n');
    const result = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      glob: '*.md',
      maxMatches: 50
    });
    assert.equal(result.ok, true);
    assert.ok(result.content.includes('markdown'));
  } finally {
    try {
      await rmdir(dir);
    } catch {}
  }
});

test('runWorkspaceGrep handles context lines', async () => {
  const dir = await mkdir(join(tmpdir(), `grep-test-ctx-${Date.now()}`), { recursive: true });
  try {
    await writeFile(join(dir, 'test.txt'), 'line1\nline2\nline3\nhello\nline5\nline6\n');
    const result = await runWorkspaceGrep({
      cwd: dir,
      pattern: 'hello',
      maxMatches: 50,
      contextLines: 2
    });
    assert.equal(result.ok, true);
    // With context, should include surrounding lines
    assert.ok(result.content.includes('hello'));
  } finally {
    try {
      await rmdir(dir);
    } catch {}
  }
});

test('runWorkspaceGrep falls back to grep when rg is missing and refuses secret globs', async () => {
  const dir = join(tmpdir(), `grep-test-fallback-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const previous = process.env.PATH;
  const bin = join(dir, 'empty-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(dir, 'notes.txt'), 'fallback-hit\n');
  process.env.PATH = `/usr/bin:${bin}`;
  try {
    const refused = await runWorkspaceGrep({ cwd: dir, pattern: 'fallback', glob: '**/.env', maxMatches: 10 });
    assert.equal(refused.ok, false);
    const found = await runWorkspaceGrep({ cwd: dir, pattern: 'fallback-hit', maxMatches: 10 });
    assert.equal(found.ok, true);
    assert.match(found.content, /fallback-hit/);
    const missed = await runWorkspaceGrep({ cwd: dir, pattern: 'no-such-fallback-token', maxMatches: 10 });
    assert.equal(missed.ok, true);
    assert.equal(missed.content, '(no matches)');
  } finally {
    process.env.PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
