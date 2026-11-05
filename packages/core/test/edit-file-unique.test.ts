import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';

function edit(dir: string) {
  return createBuiltinTools({}).find((tool: { name: string }) => tool.name === 'edit_file');
}

function ctx(dir: string) {
  return { repoRoot: dir, stateDir: dir, workspaceRoot: dir, agent: { id: 'test' }, session: { id: 'test' } };
}

test('edit_file refuses an ambiguous match and does not write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-unique-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'one two one');
    const result = await edit(dir).execute(ctx(dir), { path: 'a.txt', oldText: 'one', newText: '1' });
    assert.equal(result.ok, false);
    assert.match(result.content, /matched 2 times/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one two one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file replaces one unique match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-unique-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'alpha beta');
    const result = await edit(dir).execute(ctx(dir), { path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'ALPHA beta');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file replace_all replaces every non-overlapping match', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-unique-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'one two one');
    const result = await edit(dir).execute(ctx(dir), { path: 'a.txt', oldText: 'one', newText: '1', replace_all: true });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '1 two 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file rejects an empty needle without writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edit-unique-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'keep');
    const result = await edit(dir).execute(ctx(dir), { path: 'a.txt', oldText: '', newText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
