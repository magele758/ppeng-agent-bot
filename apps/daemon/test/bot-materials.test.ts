import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  collectBotMaterials,
  openParentDirectory,
  revealRegisteredMaterial,
  toPublicBotMaterial,
  type DirectoryOpener
} from '../src/bot-materials.ts';

function opener(): { spawn: DirectoryOpener; calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: DirectoryOpener = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  return { spawn, calls };
}

test('已登记文件会打开它的父目录 [AC:bot-detail-menu#AC-5]', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-mat-home-'));
  const stateDir = join(home, 'state');
  const file = join(stateDir, 'artifacts', 'sess-a', 'note.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'report');
  const materials = collectBotMaterials({
    botId: 'bot-a',
    canonicalSessionId: 'sess-a',
    stateDir,
    sessions: [{ id: 'sess-a', metadata: { botId: 'bot-a' } }, { id: 'sess-b', metadata: { botId: 'bot-b' } }],
    artifactsForSession: (sessionId) =>
      sessionId === 'sess-a'
        ? [{ id: 'art-note', fileName: 'note.txt', sourceTool: 'write_file', localRelPath: 'artifacts/sess-a/note.txt', createdAt: '2026-10-19T00:00:00.000Z' }]
        : [{ id: 'art-other', fileName: 'other.txt', sourceTool: 'write_file', localRelPath: 'artifacts/sess-b/other.txt', createdAt: '2026-10-19T00:00:00.000Z' }],
    fileExists: (absPath) => absPath === file
  });
  assert.deepEqual(materials.map((item) => item.id), ['art-note']);
  assert.equal('absPath' in materials[0]!, true);
  const { spawn, calls } = opener();
  const expectedParent = dirname(realpathSync(file));
  const opened = await revealRegisteredMaterial({
    materialId: 'art-note',
    files: materials,
    stateDir,
    homeDir: home,
    platform: 'darwin',
    spawn,
    env: { PATH: '/usr/bin', LD_PRELOAD: '/tmp/evil.so', AWS_SECRET_ACCESS_KEY: 'sekret', RAW_AGENT_AUTH_TOKEN: 'tok' }
  });
  assert.equal(opened, expectedParent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'open');
  assert.deepEqual(calls[0]?.args, [expectedParent]);
  assert.equal(calls[0]?.env.LD_PRELOAD, undefined);
  assert.equal(calls[0]?.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(calls[0]?.env.RAW_AGENT_AUTH_TOKEN, undefined);
  for (const [platform, command] of [['linux', 'xdg-open'], ['win32', 'explorer']] as const) {
    const next = opener();
    await revealRegisteredMaterial({
      materialId: 'art-note',
      files: materials,
      stateDir,
      homeDir: home,
      platform,
      spawn: next.spawn,
      env: { PATH: '/usr/bin' }
    });
    assert.equal(next.calls[0]?.command, command);
    assert.deepEqual(next.calls[0]?.args, [expectedParent]);
  }
  rmSync(home, { recursive: true, force: true });
});

test('未登记、越界或家目录外的位置不会被打开 [AC:bot-detail-menu#AC-6]', () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-mat-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'bot-mat-out-'));
  const stateDir = join(home, 'state');
  const file = join(stateDir, 'artifacts', 'sess-a', 'note.txt');
  const secret = join(stateDir, 'artifacts', 'sess-a', '.env');
  const outsideFile = join(outside, 'secret.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'report');
  writeFileSync(secret, 'TOKEN=sekret');
  writeFileSync(outsideFile, 'nope');
  symlinkSync(outsideFile, join(stateDir, 'artifacts', 'sess-a', 'link.txt'));
  const materials = collectBotMaterials({
    botId: 'bot-a',
    canonicalSessionId: 'sess-a',
    stateDir,
    sessions: [{ id: 'sess-a', metadata: { botId: 'bot-a' } }],
    artifactsForSession: () => [
      { id: 'art-note', fileName: 'note.txt', sourceTool: 'write_file', localRelPath: 'artifacts/sess-a/note.txt', createdAt: '2026-10-19T00:00:00.000Z' },
      { id: 'art-env', fileName: '.env', sourceTool: 'write_file', localRelPath: 'artifacts/sess-a/.env', createdAt: '2026-10-19T00:00:00.000Z' },
      { id: 'art-escape', fileName: 'escape.txt', sourceTool: 'write_file', localRelPath: '../../secret.txt', createdAt: '2026-10-19T00:00:00.000Z' }
    ],
    fileExists: () => true
  });
  assert.equal(materials.some((item) => item.id === 'art-env' || item.id === 'art-escape'), false);
  const { spawn, calls } = opener();
  const base = { files: materials, stateDir, homeDir: home, platform: 'linux' as const, spawn, env: { PATH: '/usr/bin' } };
  assert.throws(() => revealRegisteredMaterial({ ...base, materialId: 'missing' }));
  assert.throws(() =>
    revealRegisteredMaterial({
      ...base,
      materialId: 'env',
      files: [...materials, { id: 'env', name: '.env', kind: 'artifact', createdAt: '', absPath: secret }]
    })
  );
  assert.throws(() => revealRegisteredMaterial({ ...base, materialId: '../.ssh/id_rsa' }));
  assert.throws(() =>
    revealRegisteredMaterial({
      ...base,
      materialId: 'forged',
      files: [...materials, { id: 'forged', name: 'secret.txt', kind: 'artifact', createdAt: '', absPath: outsideFile }]
    })
  );
  assert.throws(() =>
    revealRegisteredMaterial({
      ...base,
      materialId: 'linked',
      files: [...materials, { id: 'linked', name: 'link.txt', kind: 'artifact', createdAt: '', absPath: join(stateDir, 'artifacts', 'sess-a', 'link.txt') }]
    })
  );
  const outsideState = join(outside, 'state');
  mkdirSync(join(outsideState, 'artifacts', 'sess-a'), { recursive: true });
  const outsideRegistered = join(outsideState, 'artifacts', 'sess-a', 'note.txt');
  writeFileSync(outsideRegistered, 'x');
  assert.throws(() =>
    revealRegisteredMaterial({
      ...base,
      stateDir: outsideState,
      materialId: 'outside-home',
      files: [{ id: 'outside-home', name: 'note.txt', kind: 'artifact', createdAt: '', absPath: outsideRegistered }]
    })
  );
  assert.equal(calls.length, 0);
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('打开目录的入口挂在 Bot 资料接口上 [AC:bot-detail-menu#AC-5] [AC:bot-detail-menu#AC-6]', () => {
  const route = readFileSync(new URL('../src/routes/bot-materials.ts', import.meta.url), 'utf8');
  const policy = readFileSync(new URL('../src/access/policy.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
  assert.match(route, /revealRegisteredMaterial/);
  assert.match(route, /toPublicBotMaterial/);
  assert.match(route, /\/api\/bots\/:id\/materials/);
  assert.match(route, /ok:\s*true/);
  assert.equal(route.includes('absPath'), false);
  assert.match(policy, /GET \/api\/bots\/:id\/materials/);
  assert.match(policy, /POST \/api\/bots\/:id\/materials\/:materialId\/reveal/);
  assert.match(app, /botMaterialRoutes/);
});

test('材料响应只留文件名，不回绝对路径 [AC:bot-detail-menu#AC-5] [AC:bot-detail-menu#AC-6]', () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-mat-home-'));
  const stateDir = join(home, 'state');
  const file = join(stateDir, 'artifacts', 'sess-a', 'report.txt');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'report');
  const materials = collectBotMaterials({
    botId: 'bot-a',
    canonicalSessionId: 'sess-a',
    stateDir,
    sessions: [{ id: 'sess-a', metadata: { botId: 'bot-a' } }],
    artifactsForSession: () => [
      {
        id: 'art-abs',
        fileName: '/Users/someone/Documents/report.txt',
        sourceTool: 'write_file',
        localRelPath: 'artifacts/sess-a/report.txt',
        createdAt: '2026-10-19T00:00:00.000Z'
      },
      {
        id: 'art-when',
        fileName: 'note.txt',
        sourceTool: 'write_file',
        localRelPath: 'artifacts/sess-a/report.txt',
        createdAt: '/Users/someone/.ssh/id_rsa'
      },
      {
        id: '/tmp/secret.txt',
        fileName: 'note.txt',
        sourceTool: 'write_file',
        localRelPath: 'artifacts/sess-a/report.txt',
        createdAt: '2026-10-19T00:00:00.000Z'
      }
    ],
    fileExists: (absPath) => absPath === file
  });
  const pub = materials.flatMap((item) => {
    const row = toPublicBotMaterial(item);
    return row ? [row] : [];
  });
  assert.deepEqual(pub, [
    {
      id: 'art-abs',
      name: 'report.txt',
      kind: 'artifact',
      createdAt: '2026-10-19T00:00:00.000Z',
      sourceTool: 'write_file'
    },
    {
      id: 'art-when',
      name: 'note.txt',
      kind: 'artifact',
      createdAt: '',
      sourceTool: 'write_file'
    }
  ]);
  const body = JSON.stringify({ materials: pub, ok: true });
  assert.equal(body.includes('/Users'), false);
  assert.equal(body.includes('absPath'), false);
  assert.equal(body.includes('.ssh'), false);
  assert.equal(body.includes('/tmp'), false);
  rmSync(home, { recursive: true, force: true });
});


test('missing or failing directory opener rejects without an uncaught error [AC:bot-detail-menu#AC-5]', async () => {
  const child = new EventEmitter();
  const completion = openParentDirectory('/safe/folder', { spawn: () => child });
  assert.equal(child.listenerCount('error'), 1);
  queueMicrotask(() => child.emit('error', Object.assign(new Error('missing opener'), { code: 'ENOENT' })));
  await assert.rejects(completion, /missing opener/);
  const failed = new EventEmitter();
  const failedCompletion = openParentDirectory('/safe/folder', { spawn: () => failed });
  queueMicrotask(() => failed.emit('exit', 3));
  await assert.rejects(failedCompletion);
});
