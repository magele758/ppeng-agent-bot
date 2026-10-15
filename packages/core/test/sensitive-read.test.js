import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { SENSITIVE_READ_REFUSAL } from '../dist/workspace/sensitive-read.js';

function ctx(dir) {
  return {
    repoRoot: dir,
    stateDir: dir,
    workspaceRoot: dir,
    agent: { id: 'test' },
    session: { id: 'test' }
  };
}

test('read_file and grep_files refuse .env, id_rsa, credentials, and blocked paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sensitive-read-'));
  const secret = 'SECRET_TOKEN_VALUE_SHOULD_NOT_LEAK';
  const privateKey = 'PRIVATE_KEY_BYTES_SHOULD_NOT_LEAK';
  const credential = 'CREDENTIAL_BYTES_SHOULD_NOT_LEAK';
  try {
    writeFileSync(join(dir, '.env'), `${secret}\n`);
    writeFileSync(join(dir, '.env.local'), `${secret}-local\n`);
    writeFileSync(join(dir, 'id_rsa'), `${privateKey}\n`);
    writeFileSync(join(dir, 'credentials'), `${credential}\n`);
    writeFileSync(join(dir, 'note.txt'), 'hello visible\n');

    const tools = createBuiltinTools({});
    const read = tools.find((tool) => tool.name === 'read_file');
    const grep = tools.find((tool) => tool.name === 'grep_files');
    const base = ctx(dir);

    for (const [path, leaked] of [
      ['.env', secret],
      ['.env.local', `${secret}-local`],
      ['id_rsa', privateKey],
      ['credentials', credential]
    ]) {
      const result = await read.execute(base, { path });
      assert.equal(result.ok, false, path);
      assert.equal(result.content, SENSITIVE_READ_REFUSAL, path);
      assert.equal(result.content.includes(leaked), false, path);
    }

    const note = await read.execute(base, { path: 'note.txt' });
    assert.equal(note.ok, true);
    assert.match(note.content, /hello visible/);

    const leakedGrep = await grep.execute(base, { pattern: secret });
    assert.equal(String(leakedGrep.content).includes(secret), false);
    const visible = await grep.execute(base, { pattern: 'hello visible' });
    assert.equal(visible.ok, true);
    assert.match(visible.content, /hello visible/);
    const aimed = await grep.execute(base, { pattern: 'hello', glob: '**/.env' });
    assert.equal(aimed.ok, false);
    assert.equal(aimed.content, SENSITIVE_READ_REFUSAL);

    const blockedRoot = {
      ...base,
      workspaceRoot: '/etc',
      workspaceRoots: [{ alias: 'repo', path: '/etc', primary: true }]
    };
    const blocked = await read.execute(blockedRoot, { path: 'ppeng-sensitive-read-missing' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.content, SENSITIVE_READ_REFUSAL);
    const blockedGrep = await grep.execute(blockedRoot, { pattern: 'root' });
    assert.equal(blockedGrep.ok, false);
    assert.equal(blockedGrep.content, SENSITIVE_READ_REFUSAL);

    rmSync(join(dir, 'credentials'));
    mkdirSync(join(dir, 'credentials'), { recursive: true });
    mkdirSync(join(dir, '.aws'), { recursive: true });
    writeFileSync(join(dir, '.env.example'), 'example visible token\n');
    writeFileSync(join(dir, '.env.sample'), 'sample visible token\n');
    writeFileSync(join(dir, '.env.template'), 'template visible token\n');
    writeFileSync(join(dir, 'credentials.ts'), 'export const credentialsCode = "code visible";\n');
    writeFileSync(join(dir, 'credentials.test.ts'), 'export const credentialsTest = "test visible";\n');
    writeFileSync(join(dir, 'credentials', 'helper.ts'), 'export const helper = "helper visible";\n');
    writeFileSync(join(dir, '.aws', 'credentials'), 'aws credential bytes\n');

    for (const [path, visible] of [
      ['.env.example', 'example visible token'],
      ['.env.sample', 'sample visible token'],
      ['.env.template', 'template visible token'],
      ['credentials.ts', 'code visible'],
      ['credentials.test.ts', 'test visible'],
      ['credentials/helper.ts', 'helper visible']
    ]) {
      const result = await read.execute(base, { path });
      assert.equal(result.ok, true, path);
      assert.match(result.content, new RegExp(visible), path);
    }
    const awsCreds = await read.execute(base, { path: '.aws/credentials' });
    assert.equal(awsCreds.ok, false);
    assert.equal(awsCreds.content, SENSITIVE_READ_REFUSAL);
    assert.equal(String(awsCreds.content).includes('aws credential bytes'), false);

    for (const visible of ['example visible token', 'code visible', 'helper visible', 'test visible']) {
      const found = await grep.execute(base, { pattern: visible });
      assert.equal(found.ok, true, visible);
      assert.match(found.content, new RegExp(visible), visible);
    }
    const awsGrep = await grep.execute(base, { pattern: 'aws credential bytes' });
    assert.equal(String(awsGrep.content).includes('aws credential bytes'), false);

    const exampleGlob = await grep.execute(base, { pattern: 'example visible token', glob: '**/.env.example' });
    assert.equal(exampleGlob.ok, true);
    assert.match(exampleGlob.content, /example visible token/);
    const codeGlob = await grep.execute(base, { pattern: 'helper visible', glob: 'credentials/**' });
    assert.equal(codeGlob.ok, true);
    assert.match(codeGlob.content, /helper visible/);
    const fileGlob = await grep.execute(base, { pattern: 'SECRET', glob: '**/credentials' });
    assert.equal(fileGlob.ok, false);
    assert.equal(fileGlob.content, SENSITIVE_READ_REFUSAL);

    mkdirSync(join(dir, '.cache', 'foo:12:bar'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'credentials'), 'preamble\npassword=secret:12:34\ntrailer\n');
    writeFileSync(join(dir, '.cache', 'foo:12:bar', 'credentials'), 'COLON_FILE_SECRET\n');
    writeFileSync(join(dir, '.env.local'), 'HIDDEN_LOCAL_SECRET\nnext hidden line\n');
    writeFileSync(join(dir, 'notes:12:readme.txt'), 'colon name visible\n');

    const contextLeak = await grep.execute(base, { pattern: 'preamble', context_lines: 2 });
    assert.equal(contextLeak.ok, true);
    assert.equal(String(contextLeak.content).includes('password=secret:12:34'), false);
    assert.equal(String(contextLeak.content).includes('preamble'), false);
    const colonFile = await grep.execute(base, { pattern: 'COLON_FILE_SECRET', context_lines: 1 });
    assert.equal(String(colonFile.content).includes('COLON_FILE_SECRET'), false);
    const hidden = await grep.execute(base, { pattern: 'HIDDEN_LOCAL_SECRET', context_lines: 1 });
    assert.equal(String(hidden.content).includes('HIDDEN_LOCAL_SECRET'), false);
    assert.equal(String(hidden.content).includes('next hidden line'), false);
    const colonOk = await grep.execute(base, { pattern: 'colon name visible' });
    assert.equal(colonOk.ok, true);
    assert.match(colonOk.content, /colon name visible/);

    const credRoot = join(dir, 'credentials');
    writeFileSync(join(credRoot, 'credentials'), 'FILE_NAMED_CREDENTIALS\n');
    const credCtx = ctx(credRoot);
    const listedRoot = await read.execute(credCtx, {});
    assert.equal(listedRoot.ok, true);
    assert.match(listedRoot.content, /helper\.ts/);
    assert.equal(String(listedRoot.content).includes('FILE_NAMED_CREDENTIALS'), false);
    const listedDir = await read.execute(base, { path: 'credentials' });
    assert.equal(listedDir.ok, true);
    assert.match(listedDir.content, /helper\.ts/);
    const secretFile = await read.execute(credCtx, { path: 'credentials' });
    assert.equal(secretFile.ok, false);
    assert.equal(secretFile.content, SENSITIVE_READ_REFUSAL);
    assert.equal(String(secretFile.content).includes('FILE_NAMED_CREDENTIALS'), false);
    const rootGrep = await grep.execute(credCtx, { pattern: 'helper visible' });
    assert.equal(rootGrep.ok, true);
    assert.match(rootGrep.content, /helper visible/);
    const secretGrep = await grep.execute(credCtx, { pattern: 'FILE_NAMED_CREDENTIALS', context_lines: 1 });
    assert.equal(String(secretGrep.content).includes('FILE_NAMED_CREDENTIALS'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
