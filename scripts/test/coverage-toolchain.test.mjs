import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCoverageVersions, resolveCoverageToolchain } from '../crap/coverage-toolchain.mjs';
import { fileURLToPath } from 'node:url';

test('coverage preflight accepts a consistent runner and provider', () => {
  assert.doesNotThrow(() => assertCoverageVersions({ vitest: '1.6.1', coverageV8: '1.6.1', providerVitest: '1.6.1' }));
});

test('coverage preflight rejects plugin mismatch and the observed hoisted-runner mismatch', () => {
  for (const versions of [
    { vitest: '1.6.1', coverageV8: '3.2.7', providerVitest: '1.6.1' },
    { vitest: '1.6.1', coverageV8: '1.6.1', providerVitest: '3.2.7' },
    { vitest: '1.6.1', coverageV8: '1.6.1' },
    {}
  ]) {
    assert.throws(() => assertCoverageVersions(versions), /Coverage toolchain mismatch.*pnpm install --frozen-lockfile/);
  }
});

test('installed coverage toolchain resolves the exact CLI and records runtime provenance', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const { cli, metadata } = resolveCoverageToolchain(root);
  assert.match(cli, /vitest/);
  assert.equal(metadata.node, process.version);
  assert.equal(metadata.vitest, metadata.coverageV8);
  assert.equal(metadata.vitest, metadata.providerVitest);
});
