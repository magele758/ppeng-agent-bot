import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBlockedVerifyHost,
  isPrivateOrReservedIp,
  parseGoalVerifySpec,
  resolveUnderWorkspace,
  runGoalVerify,
  sanitizeDerivedVerifySpec
} from '../dist/goal/index.js';

test('parseGoalVerifySpec files_exist / http / command', () => {
  assert.equal(parseGoalVerifySpec({ kind: 'files_exist', paths: ['a.md'] }).kind, 'files_exist');
  assert.equal(parseGoalVerifySpec({ kind: 'http', url: 'https://example.com' }).kind, 'http');
  assert.equal(parseGoalVerifySpec({ command: 'echo 1' }).kind, 'command');
  assert.equal(parseGoalVerifySpec({ kind: 'files_exist', paths: [] }), undefined);
});

test('sanitizeDerivedVerifySpec drops command and unsafe paths', () => {
  assert.equal(sanitizeDerivedVerifySpec({ kind: 'command', command: 'rm -rf /' }), undefined);
  assert.equal(sanitizeDerivedVerifySpec({ kind: 'files_exist', paths: ['/etc/passwd'] }), undefined);
  assert.deepEqual(sanitizeDerivedVerifySpec({ kind: 'files_exist', paths: ['out/report.md'] }), {
    kind: 'files_exist',
    paths: ['out/report.md']
  });
});

test('SSRF blocks private hosts', () => {
  assert.equal(isBlockedVerifyHost('localhost'), true);
  assert.equal(isBlockedVerifyHost('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
});

test('isPrivateOrReservedIp understands URL-canonical IPv4-mapped addresses', () => {
  assert.equal(isPrivateOrReservedIp('::ffff:7f00:1'), true);
  assert.equal(isPrivateOrReservedIp('[::ffff:7f00:1]'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:a00:1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:c0a8:101'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:ac10:1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:a9fe:a9fe'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:6440:1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:808:808'), false);
  assert.equal(isPrivateOrReservedIp('::ffff:8.8.8.8'), false);
});

test('runGoalVerify files_exist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-verify-'));
  try {
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'ok.txt'), 'x');
    const ok = await runGoalVerify(
      { kind: 'files_exist', paths: ['out/ok.txt'] },
      { workspaceRoot: dir }
    );
    assert.equal(ok.ok, true);
    const miss = await runGoalVerify(
      { kind: 'files_exist', paths: ['out/missing.txt'] },
      { workspaceRoot: dir }
    );
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /缺失/);
    const traversal = resolveUnderWorkspace(dir, '../secret');
    assert.equal(traversal, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runGoalVerify http SSRF + command refused', async () => {
  const blocked = await runGoalVerify({ kind: 'http', url: 'http://127.0.0.1/' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /SSRF|拒绝/);
  const cmd = await runGoalVerify({ kind: 'command', command: 'echo hi' });
  assert.equal(cmd.ok, false);
  assert.match(cmd.reason, /不执行/);
});
