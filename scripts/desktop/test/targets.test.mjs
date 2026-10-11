import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESKTOP_TARGETS,
  desktopCiMatrix,
  desktopTargetFromPackTag,
  electronBuilderArgs,
  resolveDesktopCiTarget,
  electronBuilderBinCandidates,
  normalizeDesktopArtifactName,
  parseDesktopTarget,
  resolveElectronBuilderBin
} from '../../lib/desktop-targets.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('desktop-v tags select all or a single target without creating a release', () => {
  assert.equal(desktopTargetFromPackTag('desktop-v0.1.0'), 'all');
  assert.equal(desktopTargetFromPackTag('desktop-v0.1.0-mac-arm64'), 'mac-arm64');
  assert.equal(desktopTargetFromPackTag('v0.1.0'), 'all');
  assert.equal(resolveDesktopCiTarget({ target: 'linux-x64', tagName: 'desktop-v1-mac-arm64' }), 'linux-x64');
  assert.equal(resolveDesktopCiTarget({ target: 'all', tagName: 'desktop-v1-win-x64' }), 'win-x64');
});

test('desktopCiMatrix filters workflow_dispatch target without job-level matrix if', () => {
  assert.equal(desktopCiMatrix('all').length, 5);
  assert.deepEqual(desktopCiMatrix('linux-x64'), [
    { id: 'linux-x64', platform: 'linux', arch: 'x64', os: 'ubuntu-latest', node_arch: 'x64' }
  ]);
  assert.throws(() => desktopCiMatrix('solaris-x64'), /unknown desktop target/);
  assert.throws(() => desktopCiMatrix('mac-x64'), /unknown desktop target/);
});

test('desktop matrix ships Apple Silicon macOS and keeps Linux and Windows', () => {
  assert.deepEqual(
    DESKTOP_TARGETS.map((row) => row.id).sort(),
    ['linux-arm64', 'linux-x64', 'mac-arm64', 'win-arm64', 'win-x64']
  );
  const mac = desktopCiMatrix('mac-arm64');
  assert.deepEqual(mac, [
    { id: 'mac-arm64', platform: 'mac', arch: 'arm64', os: 'macos-14', node_arch: 'arm64' }
  ]);
  assert.equal(
    desktopCiMatrix('all').some((row) => row.os === 'macos-13' || (row.platform === 'mac' && row.arch === 'x64')),
    false
  );
});

test('desktop workflow does not schedule Intel Mac packs', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/desktop.yml'), 'utf8');
  assert.doesNotMatch(workflow, /^\s+- mac-x64\s*$/m);
  assert.doesNotMatch(workflow, /^\s*(runs-on|os):\s*['"]?macos-13\b/m);
  assert.match(workflow, /darwin x64/);
  assert.match(workflow, /不要加回 mac-x64/);
  assert.match(workflow, /- mac-arm64/);
});

test('parseDesktopTarget accepts amd64 alias and electron-builder flags', () => {
  const linuxAmd = parseDesktopTarget({ platform: 'linux', arch: 'amd64' });
  assert.deepEqual(linuxAmd, { id: 'linux-x64', platform: 'linux', arch: 'x64' });
  assert.deepEqual(electronBuilderArgs(linuxAmd), ['--linux', '--x64', '--publish', 'never']);
  assert.deepEqual(electronBuilderArgs(parseDesktopTarget({ platform: 'windows', arch: 'aarch64' })), [
    '--win',
    '--arm64',
    '--publish',
    'never'
  ]);
  assert.throws(() => parseDesktopTarget({ platform: 'solaris', arch: 'x64' }), /unknown desktop platform/);
  assert.throws(() => parseDesktopTarget({ platform: 'mac', arch: 'x64' }), /mac-x64/);
});

test('electron-builder bin resolution includes workspace-hoisted path', () => {
  const desktopDir = join(repoRoot, 'apps', 'desktop');
  const linuxBins = electronBuilderBinCandidates(desktopDir, repoRoot, 'linux');
  assert.equal(linuxBins[0], join(desktopDir, 'node_modules', '.bin', 'electron-builder'));
  assert.equal(linuxBins[1], join(repoRoot, 'node_modules', '.bin', 'electron-builder'));
  const winBins = electronBuilderBinCandidates(desktopDir, repoRoot, 'win32');
  assert.ok(winBins.every((path) => path.endsWith('electron-builder.cmd')));
  assert.ok(existsSync(resolveElectronBuilderBin(desktopDir, repoRoot)));
});

test('electron-builder config leaves arch to CLI flags', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.mac.target, ['dmg']);
  assert.deepEqual(pkg.build.win.target, ['nsis']);
  assert.deepEqual(pkg.build.linux.target, ['AppImage']);
});

test('normalizeDesktopArtifactName maps linux AppImage x86_64 to x64', () => {
  assert.equal(
    normalizeDesktopArtifactName('RawAgent-0.1.0-linux-x86_64.AppImage', { id: 'linux-x64', platform: 'linux', arch: 'x64' }),
    'RawAgent-0.1.0-linux-x64.AppImage'
  );
  assert.equal(
    normalizeDesktopArtifactName('RawAgent-0.1.0-linux-arm64.AppImage', { id: 'linux-arm64', platform: 'linux', arch: 'arm64' }),
    'RawAgent-0.1.0-linux-arm64.AppImage'
  );
});
