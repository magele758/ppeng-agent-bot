import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLibraryDir, prepareLibraryDirs } from '../dist/ingestion/library-paths.js';
import { pickLibraryFolder } from '../dist/ingestion/folder-picker.js';

function scripted(stdout) {
  const spawn = () => {
    let onClose = null;
    const child = {
      stdout: {
        on(event, cb) {
          if (event === 'data') cb(stdout);
        }
      },
      stderr: { on() {} },
      on(event, cb) {
        if (event === 'close') onClose = cb;
      },
      kill() {}
    };
    queueMicrotask(() => onClose?.(0));
    return child;
  };
  return spawn;
}

test('存在的 iCloud 库根可以保存，拼错的名字是找不到而不是不允许 [AC:library-icloud-config#AC-1] [AC:library-icloud-config#AC-2]', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'icloud-lib-')));
  const vault = join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Mac-Knowledge');
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  writeFileSync(join(vault, 'note.md'), 'icloud vault note');
  try {
    const saved = prepareLibraryDirs([vault], home);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.dirs, [realpathSync(vault)]);

    const missing = checkLibraryDir(
      join(home, 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'mac-knowlodge'),
      home
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'missing');
    assert.equal(missing.error, 'Folder does not exist');
    assert.equal(missing.error.includes('not allowed'), false);

    const file = join(home, 'not-a-directory');
    writeFileSync(file, 'x');
    const unreadable = checkLibraryDir(join(file, 'Mac-Knowledge'), home);
    assert.equal(unreadable.ok, false);
    assert.equal(unreadable.code, 'unreadable');
    assert.equal(unreadable.error, 'That folder could not be read');
    assert.equal(unreadable.error.includes('not allowed'), false);

    mkdirSync(join(home, '.ssh'));
    const denied = checkLibraryDir(join(home, '.ssh'), home);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'denied');
    assert.match(denied.error, /not allowed/);

    writeFileSync(join(home, '.aws'), 'not a directory');
    const deniedUnreadable = checkLibraryDir(join(home, '.aws', 'hidden'), home);
    assert.equal(deniedUnreadable.ok, false);
    assert.equal(deniedUnreadable.code, 'denied');
    assert.match(deniedUnreadable.error, /not allowed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('选择器拒绝不存在的文件夹时带上找不到的原因 [AC:library-icloud-config#AC-2]', async () => {
  const missing = await pickLibraryFolder({
    platform: () => 'darwin',
    spawn: scripted('/tmp/mac-knowlodge-does-not-exist\n')
  });
  assert.deepEqual(missing, { status: 'rejected', reason: 'missing' });
  assert.equal(JSON.stringify(missing).includes('not allowed'), false);
});
