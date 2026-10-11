#!/usr/bin/env node
/**
 * Build one desktop artifact (macOS arm64, or win/linux × x64/arm64).
 * Intel Mac (darwin x64 / mac-x64) is not a target.
 *
 *   node scripts/build-desktop.mjs
 *   node scripts/build-desktop.mjs --platform linux --arch x64
 *
 * Default target is the host platform/arch. CI should pass both flags and
 * run on a matching runner so Next standalone + sharp match the artifact.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electronBuilderArgs, normalizeDesktopArtifactName, parseDesktopTarget, resolveElectronBuilderBin } from './lib/desktop-targets.mjs';
import { writeDesktopIcons } from './generate-desktop-icons.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const desktopDir = join(repoRoot, 'apps', 'desktop');

function parseArgs(argv) {
  const out = { platform: undefined, arch: undefined, skipWorkspaceBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') out.platform = argv[++i];
    else if (arg === '--arch') out.arch = argv[++i];
    else if (arg === '--skip-workspace-build') out.skipWorkspaceBuild = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/build-desktop.mjs [--platform mac|win|linux] [--arch x64|arm64] [--skip-workspace-build]`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function run(command, args, cwd = repoRoot) {
  console.log(`[build-desktop] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`[build-desktop] ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmArgs(args) {
  return process.platform === 'win32' ? ['npm.cmd', args] : ['npm', args];
}

const flags = parseArgs(process.argv.slice(2));
const target = parseDesktopTarget(flags);
console.log(`[build-desktop] target ${target.id} (host ${process.platform}/${process.arch})`);

writeDesktopIcons();
if (process.platform === 'darwin') {
  try {
    execSync('bash scripts/generate-icons.sh', { cwd: repoRoot, stdio: 'inherit' });
  } catch {
    console.warn('[build-desktop] macOS icns generation skipped');
  }
}

if (!flags.skipWorkspaceBuild) {
  const [npm, npmBuild] = npmArgs(['run', 'build']);
  run(npm, npmBuild);
}

if (!existsSync(join(repoRoot, 'apps', 'daemon', 'dist'))) {
  console.error('❌ 找不到 apps/daemon/dist，请先运行 npm run build');
  process.exit(1);
}
if (!existsSync(join(repoRoot, 'apps', 'web-console', '.next', 'standalone'))) {
  console.error('❌ 找不到 web-console standalone，请先运行 npm run build');
  process.exit(1);
}

run(process.execPath, [join(repoRoot, 'scripts', 'prepare-desktop-server.mjs')]);

const [npm, npmInstall] = npmArgs(['install']);
run(npm, npmInstall, desktopDir);

const [npmTsc, tscArgs] = npmArgs(['run', 'build']);
run(npmTsc, tscArgs, desktopDir);

const builderBin = resolveElectronBuilderBin(desktopDir, repoRoot);
const releaseDir = join(desktopDir, 'release');
rmSync(releaseDir, { recursive: true, force: true });
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false'
};
console.log(`[build-desktop] ${builderBin} ${electronBuilderArgs(target).join(' ')}`);
const packed = spawnSync(builderBin, electronBuilderArgs(target), {
  cwd: desktopDir,
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
});
if (packed.error) {
  console.error(`[build-desktop] ${packed.error.message}`);
  process.exit(1);
}
if (packed.status !== 0) process.exit(packed.status ?? 1);

if (existsSync(releaseDir)) {
  for (const name of readdirSync(releaseDir)) {
    const renamed = normalizeDesktopArtifactName(name, target);
    if (renamed !== name) {
      renameSync(join(releaseDir, name), join(releaseDir, renamed));
      console.log(`[build-desktop] renamed ${name} → ${renamed}`);
    }
  }
}

console.log(`[build-desktop] done → apps/desktop/release/ (${target.id})`);
