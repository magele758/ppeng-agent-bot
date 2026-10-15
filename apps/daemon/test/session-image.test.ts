import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionImagePath } from '../src/session-image.ts';

test('resolveSessionImagePath serves only that session image file', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'session-image-'));
  writeFileSync(join(stateDir, 'shot.jpg'), 'jpeg-bytes');
  const asset = {
    sessionId: 'sess-a',
    localRelPath: 'shot.jpg',
    mimeType: 'image/jpeg'
  };
  const ok = resolveSessionImagePath(stateDir, asset, 'sess-a');
  assert.equal(ok?.mimeType, 'image/jpeg');
  assert.equal(ok?.absPath, join(stateDir, 'shot.jpg'));
  assert.equal(resolveSessionImagePath(stateDir, asset, 'sess-b'), undefined);
  assert.equal(
    resolveSessionImagePath(stateDir, { ...asset, localRelPath: '../shot.jpg' }, 'sess-a'),
    undefined
  );
  assert.equal(
    resolveSessionImagePath(stateDir, { ...asset, localRelPath: 'missing.jpg' }, 'sess-a'),
    undefined
  );
  assert.equal(
    resolveSessionImagePath(stateDir, { ...asset, mimeType: 'text/html' }, 'sess-a'),
    undefined
  );
});
