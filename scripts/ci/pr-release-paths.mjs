// Decides whether a pull request touches paths that must run the full Release gate.
// Keep INCLUDE in step with the globs documented in doc/CI.md and the PR release gate workflow.
import {appendFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const RELEASE_GATE_PATHS = [
  'packages/core/**',
  'packages/agent-loop/**',
  'packages/capability-gateway/**',
  'packages/api-types/**',
  'apps/daemon/**',
  'specs/formal/**',
  'scripts/formal/**',
  'scripts/crap/**',
  'scripts/ci/validation-*.mjs',
  'scripts/ci/validation-artifacts.mjs',
  'scripts/ci/validation-lane.mjs',
  'scripts/ci/main-full-health.mjs',
  'scripts/ci/release-results.mjs',
  'scripts/ci/reviewed-verification-inputs.mjs',
  'scripts/ci/test-partition.mjs',
  'scripts/ci/verification-evidence.mjs',
  '.github/workflows/full-validation.yml',
  '.github/workflows/pr-release-gate.yml',
  '.github/workflows/release-gate.yml',
  '.github/workflows/ci.yml',
];

export function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { source += '.*'; i += 1; }
    else if (ch === '*') source += '[^/]*';
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const MATCHERS = RELEASE_GATE_PATHS.map(globToRegExp);

export function touchesReleaseGatePaths(files) {
  return files.some(file => MATCHERS.some(re => re.test(file)));
}

function changedFiles() {
  const r = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD^1', 'HEAD'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) throw new Error(`git diff failed: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = changedFiles();
  const core = touchesReleaseGatePaths(files);
  console.log(`[pr-release-paths] ${files.length} changed files; core=${core}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `core=${core}\n`);
}
