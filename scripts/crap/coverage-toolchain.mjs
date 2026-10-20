import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function assertCoverageVersions({ vitest, coverageV8, providerVitest }) {
  if (!vitest || !coverageV8 || !providerVitest || vitest !== coverageV8 || vitest !== providerVitest) {
    throw new Error(
      `Coverage toolchain mismatch: vitest=${vitest}, coverage-v8=${coverageV8}, ` +
      `provider resolves vitest=${providerVitest}. Restore dependencies with pnpm install --frozen-lockfile ` +
      `under the CI Node version before collecting coverage; do not update the CRAP baseline.`
    );
  }
}

/** Resolve from the workspace AND the provider: hoisting can give each a different Vitest. */
export function resolveCoverageToolchain(root) {
  const fromLoop = createRequire(path.join(root, 'packages/agent-loop/package.json'));
  const runnerPath = fromLoop.resolve('vitest/package.json');
  const providerPath = fromLoop.resolve('@vitest/coverage-v8/package.json');
  const providerRunnerPath = createRequire(providerPath).resolve('vitest/package.json');
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const runner = read(runnerPath);
  const versions = {
    vitest: runner.version,
    coverageV8: read(providerPath).version,
    providerVitest: read(providerRunnerPath).version,
  };
  assertCoverageVersions(versions);
  const bin = typeof runner.bin === 'string' ? runner.bin : runner.bin?.vitest;
  if (!bin) throw new Error('Installed Vitest has no CLI entry; restore dependencies with pnpm install --frozen-lockfile.');
  const cli = path.resolve(path.dirname(runnerPath), bin);
  if (!fs.existsSync(cli)) throw new Error(`Vitest CLI missing: ${cli}`);
  return {
    cli,
    metadata: { node: process.version, platform: process.platform, arch: process.arch, ...versions }
  };
}
