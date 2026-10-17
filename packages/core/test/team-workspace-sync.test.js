import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  copyWorkspaceSnapshot,
  createTeamWorkerWorkspace,
  teamTaskWorkspaceDir
} from '../dist/teams/workspace-sync.js';

test('copyWorkspaceSnapshot skips node_modules/.git/dist', async () => {
  const src = mkdtempSync(join(tmpdir(), 'team-src-'));
  const dest = mkdtempSync(join(tmpdir(), 'team-dest-'));
  try {
    writeFileSync(join(src, 'keep.txt'), 'ok');
    mkdirSync(join(src, 'node_modules'), { recursive: true });
    writeFileSync(join(src, 'node_modules', 'x.js'), 'no');
    mkdirSync(join(src, '.git'), { recursive: true });
    writeFileSync(join(src, '.git', 'HEAD'), 'ref');
    mkdirSync(join(src, 'dist'), { recursive: true });
    writeFileSync(join(src, 'dist', 'out.js'), 'no');
    await copyWorkspaceSnapshot(src, dest);
    assert.equal(existsSync(join(dest, 'keep.txt')), true);
    assert.equal(existsSync(join(dest, 'node_modules')), false);
    assert.equal(existsSync(join(dest, '.git')), false);
    assert.equal(existsSync(join(dest, 'dist')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('createTeamWorkerWorkspace falls back to directory-copy', async () => {
  const src = mkdtempSync(join(tmpdir(), 'team-src-'));
  const dest = mkdtempSync(join(tmpdir(), 'team-dest-'));
  try {
    writeFileSync(join(src, 'a.ts'), 'x');
    const out = await createTeamWorkerWorkspace({
      sourceRoot: src,
      destRoot: dest,
      taskId: 't1',
      mode: 'directory-copy'
    });
    assert.equal(out.mode, 'directory-copy');
    assert.equal(existsSync(join(dest, 'a.ts')), true);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('parallel snapshot copies keep every source file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-parallel-'));
  try {
    const sources = [0, 1].map((i) => {
      const src = join(root, `src-${i}`);
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, `keep-${i}.txt`), `ok-${i}`);
      return src;
    });
    const dest = join(root, 'dest');
    await Promise.all(sources.map((src) => copyWorkspaceSnapshot(src, dest)));
    assert.equal(existsSync(join(dest, 'keep-0.txt')), true);
    assert.equal(existsSync(join(dest, 'keep-1.txt')), true);
    assert.equal(existsSync(join(dest, '.snapshot.lock')), false);
    assert.equal(existsSync(join(dest, '.snapshot.lock.db')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('teamTaskWorkspaceDir sanitizes traversal', () => {
  const dir = teamTaskWorkspaceDir('/tmp/state', 'plan1', '../evil');
  assert.equal(dirname(dir), join('/tmp/state', 'teams', 'plan1', 'tasks'));
  assert.equal(basename(dir), '.._evil');
  assert.ok(!basename(dir).includes('/') && !basename(dir).includes('\\'));
});
