import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LIBRARY_FOLDER_PICK_ARGS,
  LIBRARY_FOLDER_PICK_COMMAND,
  libraryFolderPickAllowed,
  libraryPickBodyAllowed,
  libraryPickQueryAllowed,
  pickLibraryFolder
} from '../dist/ingestion/folder-picker.js';

function scripted(result) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    let onError = null;
    let onClose = null;
    const child = {
      stdout: {
        on(event, cb) {
          if (event === 'data' && result.stdout) cb(result.stdout);
        }
      },
      stderr: {
        on(event, cb) {
          if (event === 'data' && result.stderr) cb(result.stderr);
        }
      },
      on(event, cb) {
        if (event === 'error') onError = cb;
        if (event === 'close') onClose = cb;
      },
      kill() {
        calls.push({ killed: true });
      }
    };
    queueMicrotask(() => {
      if (result.error) onError?.(result.error);
      else onClose?.(result.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('系统文件夹对话框返回绝对路径，脚本不接收调用方路径 [AC:knowledge-library-dirs#AC-6]', async () => {
  const dir = tempDir('pick-notes-');
  const fake = scripted({ stdout: `${dir}/\n` });
  const previousKey = process.env.RAW_AGENT_API_KEY;
  const previousPreload = process.env.LD_PRELOAD;
  process.env.RAW_AGENT_API_KEY = 'picker-should-not-see';
  process.env.LD_PRELOAD = '/tmp/evil.so';
  try {
    const picked = await pickLibraryFolder({ platform: () => 'darwin', spawn: fake.spawn });
    assert.deepEqual(picked, { status: 'selected', path: dir });
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].command, LIBRARY_FOLDER_PICK_COMMAND);
    assert.deepEqual(fake.calls[0].args, [...LIBRARY_FOLDER_PICK_ARGS]);
    assert.equal(fake.calls[0].args.join('\n').includes(dir), false);
    assert.equal(fake.calls[0].options.shell, false);
    assert.equal(fake.calls[0].options.env.PATH, '/usr/bin:/bin');
    assert.equal(fake.calls[0].options.env.RAW_AGENT_API_KEY, undefined);
    assert.equal(fake.calls[0].options.env.LD_PRELOAD, undefined);
    assert.equal(Object.keys(fake.calls[0].options.env).every((key) =>
      ['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR', 'USER', 'LOGNAME'].includes(key)
    ), true);
  } finally {
    if (previousKey === undefined) delete process.env.RAW_AGENT_API_KEY;
    else process.env.RAW_AGENT_API_KEY = previousKey;
    if (previousPreload === undefined) delete process.env.LD_PRELOAD;
    else process.env.LD_PRELOAD = previousPreload;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取消或没有图形界面时不返回路径 [AC:knowledge-library-dirs#AC-8]', async () => {
  const cancelled = scripted({ stdout: 'CANCELLED\n' });
  const picked = await pickLibraryFolder({ platform: () => 'darwin', spawn: cancelled.spawn });
  assert.deepEqual(picked, { status: 'cancelled' });
  assert.equal('path' in picked, false);

  const userCancel = scripted({ code: 1, stderr: 'execution error: User canceled. (-128)' });
  assert.deepEqual(
    await pickLibraryFolder({ platform: () => 'darwin', spawn: userCancel.spawn }),
    { status: 'cancelled' }
  );

  const headless = scripted({ code: 1, stderr: 'no user interaction is possible' });
  const unavailable = await pickLibraryFolder({ platform: () => 'darwin', spawn: headless.spawn });
  assert.deepEqual(unavailable, { status: 'unavailable' });
  assert.equal('path' in unavailable, false);

  const missing = scripted({ error: new Error('spawn /usr/bin/osascript ENOENT') });
  assert.deepEqual(
    await pickLibraryFolder({ platform: () => 'darwin', spawn: missing.spawn }),
    { status: 'unavailable' }
  );

  let spawned = false;
  const offMac = await pickLibraryFolder({
    platform: () => 'linux',
    spawn: () => {
      spawned = true;
      throw new Error('should not spawn');
    }
  });
  assert.deepEqual(offMac, { status: 'unavailable' });
  assert.equal(spawned, false);
});

test('远程、未提供本机地址，或请求里带路径时不会开对话框，也不读文件 [AC:knowledge-library-dirs#AC-9]', async () => {
  const home = tempDir('pick-home-');
  const ssh = join(home, '.ssh');
  mkdirSync(ssh);
  writeFileSync(join(ssh, 'id_rsa'), 'PRIVATE-KEY-SENTINEL');
  const notes = join(home, 'notes');
  mkdirSync(notes);
  const file = join(notes, 'note.txt');
  writeFileSync(file, 'FILE-BODY-SENTINEL');
  const link = join(home, 'alias-ssh');
  symlinkSync(ssh, link);
  try {
    const blocked = await pickLibraryFolder({
      platform: () => 'darwin',
      home,
      spawn: scripted({ stdout: `${ssh}\n` }).spawn
    });
    assert.equal(blocked.status, 'rejected');
    assert.equal(JSON.stringify(blocked).includes('PRIVATE-KEY-SENTINEL'), false);
    assert.equal('path' in blocked, false);

    const linked = await pickLibraryFolder({
      platform: () => 'darwin',
      home,
      spawn: scripted({ stdout: `${link}\n` }).spawn
    });
    assert.equal(linked.status, 'rejected');
    assert.equal(JSON.stringify(linked).includes('PRIVATE-KEY-SENTINEL'), false);

    const notDir = await pickLibraryFolder({
      platform: () => 'darwin',
      home,
      spawn: scripted({ stdout: `${file}\n` }).spawn
    });
    assert.equal(notDir.status, 'rejected');
    assert.equal(JSON.stringify(notDir).includes('FILE-BODY-SENTINEL'), false);

    assert.equal(libraryPickBodyAllowed({}), true);
    assert.equal(libraryPickBodyAllowed(null), true);
    assert.equal(libraryPickBodyAllowed({ path: file, marker: 'FILE-BODY-SENTINEL' }), false);
    assert.equal(libraryPickBodyAllowed(['/tmp']), false);
    assert.equal(libraryPickQueryAllowed(new URLSearchParams('path=' + encodeURIComponent(file))), false);
    assert.equal(libraryPickQueryAllowed(new URLSearchParams('')), true);

    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1' }), true);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.2' }), true);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '::1' }), true);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '::ffff:127.0.0.1' }), true);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1', forwardedHost: 'localhost:23000' }), true);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1', forwardedHost: '127.0.0.1:23000' }), true);
    assert.equal(
      libraryFolderPickAllowed({
        remoteAddress: '127.0.0.1',
        forwardedHost: '0.0.0.0:23000',
        browserHost: '127.0.0.1:23000'
      }),
      true
    );
    assert.equal(
      libraryFolderPickAllowed({
        remoteAddress: '127.0.0.1',
        forwardedHost: '0.0.0.0:23000',
        browserHost: 'localhost:23000'
      }),
      true
    );
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '192.168.1.9', forwardedHost: 'localhost' }), false);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '::ffff:10.0.0.8' }), false);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1', forwardedHost: 'evil.example' }), false);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1', forwardedHost: 'evil.example, 127.0.0.1' }), false);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '127.0.0.1', forwardedHost: '0.0.0.0:23000' }), false);
    assert.equal(
      libraryFolderPickAllowed({
        remoteAddress: '127.0.0.1',
        forwardedHost: '0.0.0.0:23000',
        browserHost: 'evil.example:23000'
      }),
      false
    );
    assert.equal(
      libraryFolderPickAllowed({
        remoteAddress: '127.0.0.1',
        browserHost: '192.168.1.40:23000'
      }),
      false
    );
    assert.equal(libraryFolderPickAllowed({ remoteAddress: undefined }), false);
    assert.equal(libraryFolderPickAllowed({ remoteAddress: '' }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
