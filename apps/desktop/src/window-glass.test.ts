import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

function readSrc(name: string): string {
  return readFileSync(join(srcDir, name), 'utf8');
}

test('[AC:app-frosted-glass#AC-3] darwin window is transparent vibrancy; preload marks desktop-glass', () => {
  const main = readSrc('main.ts');
  const createStart = main.indexOf('function createWindow');
  assert.ok(createStart >= 0, 'createWindow must exist');
  const createBody = main.slice(createStart, main.indexOf('function createTray'));

  assert.match(createBody, /process\.platform\s*===\s*'darwin'/);
  assert.match(createBody, /transparent:\s*true/);
  assert.match(createBody, /backgroundColor:\s*'#00000000'/);
  assert.match(createBody, /vibrancy:\s*'under-window'/);
  assert.match(createBody, /visualEffectState:\s*'active'/);
  assert.match(createBody, /nodeIntegration:\s*false/);
  assert.match(createBody, /contextIsolation:\s*true/);
  assert.match(createBody, /webSecurity:\s*true/);

  const darwinBranch = createBody.slice(
    createBody.indexOf("process.platform === 'darwin'"),
    createBody.indexOf('new BrowserWindow')
  );
  assert.match(darwinBranch, /transparent:\s*true/);
  assert.match(darwinBranch, /vibrancy:\s*'under-window'/);
  assert.doesNotMatch(darwinBranch, /process\.platform\s*!==\s*'darwin'/);

  const preload = readSrc('preload.ts');
  const logAt = preload.indexOf("console.log('[Preload]");
  const markAt = preload.indexOf("classList.add('desktop-glass')");
  assert.ok(markAt >= 0, 'preload must add desktop-glass');
  assert.ok(logAt > markAt, 'desktop-glass must be set before any preload log');
  assert.match(preload, /documentElement/);
  assert.match(preload, /DOMContentLoaded/);
});
